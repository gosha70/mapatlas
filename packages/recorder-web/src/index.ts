// SPDX-License-Identifier: Apache-2.0

/**
 * MAP-ATLAS web (foreground) {@link TrackRecorder}.
 *
 * Wraps `navigator.geolocation.watchPosition`, applies the pure `sample`
 * decision from `@mapatlas/core`, and holds a Screen Wake Lock while recording
 * so the screen (and GPS) stay awake. It runs in the browser only — which is
 * exactly why it lives outside `@mapatlas/core`: the engine core must stay
 * DOM-free and pass the import-isolation scan (see ADR-0011). A native
 * background recorder is a separate out-of-tree adapter implementing the same
 * `TrackRecorder` interface (ADR-0003).
 */
import {
  DEFAULT_SAMPLING_POLICY,
  finalizeTrack,
  newId,
  sample,
  type SamplingPolicy,
  type StorageAdapter,
  type Track,
  type TrackPoint,
  type TrackRecorder,
  type TrackRecorderError,
  type TrackRecorderErrorKind,
} from "@mapatlas/core";

/** Minimal shape of the Screen Wake Lock API this recorder relies on. */
interface WakeLockSentinelLike {
  release(): Promise<void>;
}
interface WakeLockLike {
  request(type: "screen"): Promise<WakeLockSentinelLike>;
}

/**
 * Injectable browser dependencies. Both default to the ambient `navigator` at
 * `start()` time (never at import — construction is SSR-safe). Tests pass fakes
 * so the recorder is exercised without live hardware.
 */
export interface WebRecorderDeps {
  geolocation?: Geolocation;
  /** `null` explicitly disables the Wake Lock (e.g. where it is unsupported). */
  wakeLock?: WakeLockLike | null;
}

function resolveGeolocation(deps?: WebRecorderDeps): Geolocation | undefined {
  if (deps && "geolocation" in deps) return deps.geolocation;
  if (typeof navigator !== "undefined") return navigator.geolocation;
  return undefined;
}

function resolveWakeLock(deps?: WebRecorderDeps): WakeLockLike | undefined {
  if (deps && "wakeLock" in deps) return deps.wakeLock ?? undefined;
  if (typeof navigator !== "undefined") {
    return (navigator as Navigator & { wakeLock?: WakeLockLike }).wakeLock;
  }
  return undefined;
}

/** Map a browser `GeolocationPositionError` code to our stable error kind. */
function mapErrorKind(code: number): TrackRecorderErrorKind {
  switch (code) {
    case 1:
      return "permission-denied";
    case 3:
      return "timeout";
    default:
      return "position-unavailable";
  }
}

function toTrackPoint(pos: GeolocationPosition): TrackPoint {
  const c = pos.coords;
  const p: TrackPoint = { lat: c.latitude, lng: c.longitude, t: pos.timestamp };
  if (c.accuracy != null && Number.isFinite(c.accuracy))
    p.accuracyM = c.accuracy;
  if (c.speed != null && Number.isFinite(c.speed)) p.speedMps = c.speed;
  if (c.heading != null && Number.isFinite(c.heading)) p.headingDeg = c.heading;
  return p;
}

/**
 * Create a web foreground recorder. When a `store` is given, the finalized
 * `Track` is persisted on `stop()`.
 */
export function createWebTrackRecorder(
  store?: StorageAdapter,
  deps?: WebRecorderDeps,
): TrackRecorder {
  const pointCbs = new Set<(p: TrackPoint) => void>();
  const errorCbs = new Set<(e: TrackRecorderError) => void>();

  let status: Track["status"] = "paused"; // pre-start; becomes "recording" on start()
  let track: Track | undefined;
  let prev: TrackPoint | undefined;
  let policy: SamplingPolicy = DEFAULT_SAMPLING_POLICY;

  let geo: Geolocation | undefined;
  let watchId: number | undefined;
  let wakeSource: WakeLockLike | undefined;
  let wakeSentinel: WakeLockSentinelLike | undefined;

  const emitError = (kind: TrackRecorderErrorKind, message: string): void => {
    for (const cb of errorCbs) cb({ kind, message });
  };

  const onPosition = (pos: GeolocationPosition): void => {
    if (status !== "recording" || !track) return;
    const candidate = toTrackPoint(pos);
    // sample() runs the accuracy gate first, so a dropped-for-accuracy fix is
    // never kept or emitted — honouring the recorder contract.
    if (!sample(prev, candidate, policy).keep) return;
    track.points.push(candidate);
    prev = candidate;
    for (const cb of pointCbs) cb(candidate);
  };

  const onGeoError = (err: GeolocationPositionError): void => {
    emitError(mapErrorKind(err.code), err.message || "geolocation error");
  };

  const startWatch = (): void => {
    if (!geo) return;
    watchId = geo.watchPosition(onPosition, onGeoError, {
      enableHighAccuracy: true,
    });
  };

  const stopWatch = (): void => {
    if (geo && watchId !== undefined) geo.clearWatch(watchId);
    watchId = undefined;
  };

  const acquireWakeLock = async (): Promise<void> => {
    if (!wakeSource || wakeSentinel) return;
    try {
      wakeSentinel = await wakeSource.request("screen");
    } catch {
      // A Wake Lock is a best-effort enhancement; recording proceeds without it.
      wakeSentinel = undefined;
    }
  };

  const releaseWakeLock = async (): Promise<void> => {
    const sentinel = wakeSentinel;
    wakeSentinel = undefined;
    if (sentinel) {
      try {
        await sentinel.release();
      } catch {
        // Ignore: the lock is gone either way.
      }
    }
  };

  return {
    get status(): Track["status"] {
      return status;
    },

    async start(opts?: Partial<SamplingPolicy>): Promise<void> {
      policy = { ...DEFAULT_SAMPLING_POLICY, ...opts };
      geo = resolveGeolocation(deps);
      wakeSource = resolveWakeLock(deps);
      if (!geo) {
        emitError("unsupported", "geolocation is unavailable");
        return;
      }
      track = {
        id: newId(),
        startedAt: Date.now(),
        status: "recording",
        points: [],
      };
      prev = undefined;
      status = "recording";
      startWatch();
      await acquireWakeLock();
    },

    pause(): void {
      if (status !== "recording") return;
      status = "paused";
      stopWatch();
      void releaseWakeLock();
    },

    resume(): void {
      if (status !== "paused" || !track) return;
      status = "recording";
      startWatch();
      void acquireWakeLock();
    },

    async stop(): Promise<Track> {
      stopWatch();
      await releaseWakeLock();
      status = "finalized";
      const base: Track = track ?? {
        id: newId(),
        startedAt: Date.now(),
        status: "finalized",
        points: [],
      };
      const { simplified, distanceM } = finalizeTrack(base.points);
      const finalized: Track = {
        ...base,
        status: "finalized",
        endedAt: Date.now(),
        simplified,
        distanceM,
      };
      track = finalized;
      if (store) await store.saveTrack(finalized);
      return finalized;
    },

    onPoint(cb: (p: TrackPoint) => void): () => void {
      pointCbs.add(cb);
      return () => pointCbs.delete(cb);
    },

    onError(cb: (e: TrackRecorderError) => void): () => void {
      errorCbs.add(cb);
      return () => errorCbs.delete(cb);
    },
  };
}
