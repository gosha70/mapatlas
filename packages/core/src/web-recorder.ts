// SPDX-License-Identifier: Apache-2.0

/**
 * `createWebTrackRecorder` (tasks T3.1): the foreground web {@link TrackRecorder}.
 *
 * Wraps `navigator.geolocation.watchPosition`, applies the pure sampling policy
 * (T1.2) so only accuracy-passing, sufficiently-spaced fixes are kept, holds a
 * Screen Wake Lock while recording, and maps geolocation errors onto the
 * engine's {@link TrackRecorderError} taxonomy.
 *
 * It reads `navigator` lazily at `start()` time so it stays dependency-free at
 * import: no browser globals are touched until the consumer begins recording.
 * The engine imports nothing from the DOM or any renderer — only the ambient
 * `navigator` API is used, which the isolation scan permits.
 */
import type { Track, TrackPoint, TrackStatus } from "./types.js";
import type {
  StorageAdapter,
  TrackRecorder,
  TrackRecorderError,
} from "./interfaces.js";
import type { SamplingPolicy } from "./sampling.js";
import { DEFAULT_SAMPLING_POLICY, sample } from "./sampling.js";
import { finalizeTrack } from "./track.js";
import { newId } from "./id.js";

type PointCb = (p: TrackPoint) => void;
type ErrorCb = (e: TrackRecorderError) => void;

/** Build a `TrackPoint` from a geolocation fix, omitting absent optionals. */
function toPoint(pos: GeolocationPosition): TrackPoint {
  const c = pos.coords;
  const p: TrackPoint = { lat: c.latitude, lng: c.longitude, t: pos.timestamp };
  if (c.accuracy != null && !Number.isNaN(c.accuracy)) p.accuracyM = c.accuracy;
  if (c.speed != null && !Number.isNaN(c.speed)) p.speedMps = c.speed;
  if (c.heading != null && !Number.isNaN(c.heading)) p.headingDeg = c.heading;
  return p;
}

/** Map a `GeolocationPositionError` code onto a `TrackRecorderError`. */
function mapGeoError(err: GeolocationPositionError): TrackRecorderError {
  switch (err.code) {
    case err.PERMISSION_DENIED:
      return { kind: "permission-denied", message: err.message };
    case err.POSITION_UNAVAILABLE:
      return { kind: "position-unavailable", message: err.message };
    case err.TIMEOUT:
      return { kind: "timeout", message: err.message };
    default:
      return { kind: "position-unavailable", message: err.message };
  }
}

class WebTrackRecorder implements TrackRecorder {
  private _status: TrackStatus = "paused";
  private policy: SamplingPolicy = DEFAULT_SAMPLING_POLICY;
  private points: TrackPoint[] = [];
  private lastKept: TrackPoint | undefined;
  private watchId: number | undefined;
  private wakeLock: WakeLockSentinel | undefined;
  private startedAt = 0;
  private readonly pointCbs = new Set<PointCb>();
  private readonly errorCbs = new Set<ErrorCb>();

  constructor(private readonly store?: StorageAdapter) {}

  get status(): TrackStatus {
    return this._status;
  }

  async start(opts?: Partial<SamplingPolicy>): Promise<void> {
    this.policy = { ...DEFAULT_SAMPLING_POLICY, ...opts };
    this.points = [];
    this.lastKept = undefined;
    this.startedAt = Date.now();
    this._status = "recording";
    await this.acquireWakeLock();
    this.beginWatch();
  }

  pause(): void {
    if (this._status !== "recording") return;
    this._status = "paused";
    this.stopWatch();
    void this.releaseWakeLock();
  }

  resume(): void {
    if (this._status !== "paused") return;
    this._status = "recording";
    void this.acquireWakeLock();
    this.beginWatch();
  }

  async stop(): Promise<Track> {
    this.stopWatch();
    await this.releaseWakeLock();
    this._status = "finalized";
    const { simplified, distanceM } = finalizeTrack(this.points);
    const track: Track = {
      id: newId(),
      startedAt: this.startedAt,
      endedAt: Date.now(),
      status: "finalized",
      points: this.points.slice(),
      simplified,
      distanceM,
    };
    if (this.store) await this.store.saveTrack(track);
    return track;
  }

  onPoint(cb: PointCb): () => void {
    this.pointCbs.add(cb);
    return () => this.pointCbs.delete(cb);
  }

  onError(cb: ErrorCb): () => void {
    this.errorCbs.add(cb);
    return () => this.errorCbs.delete(cb);
  }

  private emitError(e: TrackRecorderError): void {
    for (const cb of this.errorCbs) cb(e);
  }

  private beginWatch(): void {
    const geo = getGeolocation();
    if (!geo) {
      this.emitError({
        kind: "unsupported",
        message: "Geolocation is not available in this environment.",
      });
      return;
    }
    this.watchId = geo.watchPosition(
      (pos) => this.onFix(pos),
      (err) => this.emitError(mapGeoError(err)),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 30_000 },
    );
  }

  private stopWatch(): void {
    if (this.watchId === undefined) return;
    getGeolocation()?.clearWatch(this.watchId);
    this.watchId = undefined;
  }

  private onFix(pos: GeolocationPosition): void {
    const candidate = toPoint(pos);
    const decision = sample(this.lastKept, candidate, this.policy);
    if (!decision.keep) return;
    this.lastKept = candidate;
    this.points.push(candidate);
    for (const cb of this.pointCbs) cb(candidate);
  }

  private async acquireWakeLock(): Promise<void> {
    const wl = getWakeLock();
    if (!wl) return;
    try {
      this.wakeLock = await wl.request("screen");
    } catch {
      // Wake Lock is best-effort; recording continues without it.
      this.wakeLock = undefined;
    }
  }

  private async releaseWakeLock(): Promise<void> {
    const sentinel = this.wakeLock;
    if (!sentinel) return;
    this.wakeLock = undefined;
    try {
      await sentinel.release();
    } catch {
      // ignore — the lock may already be gone (tab hidden, etc.)
    }
  }
}

function getGeolocation(): Geolocation | undefined {
  return typeof navigator !== "undefined" ? navigator.geolocation : undefined;
}

function getWakeLock(): WakeLock | undefined {
  return typeof navigator !== "undefined"
    ? (navigator as Navigator & { wakeLock?: WakeLock }).wakeLock
    : undefined;
}

/**
 * Create the foreground web recorder. Pass a {@link StorageAdapter} to have the
 * finalized {@link Track} persisted automatically on `stop()`.
 */
export function createWebTrackRecorder(store?: StorageAdapter): TrackRecorder {
  return new WebTrackRecorder(store);
}
