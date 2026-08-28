// SPDX-License-Identifier: Apache-2.0

import type {
  ChannelDescriptor,
  Id,
  LapInput,
  SamplingPolicy,
  SensorMergePolicy,
  SensorSample,
  SensorSource,
  Track,
  TrackPoint,
  TrackRecorder,
  TrackRecorderError,
  TrackRecorderOptions,
  TrackSegment,
  TrackStatus,
} from "@mapatlas/core";
import {
  finalizeTrack,
  mergeSensorSamples,
  newId,
  resolveSamplingPolicy,
  resolveSensorMergePolicy,
  sample,
} from "@mapatlas/core";

import type {
  PositionFailure,
  PositionFix,
  WakeLockLease,
  WebRecorderEnvironment,
} from "./environment.js";
import { POSITION_ERROR, createBrowserEnvironment } from "./environment.js";

/** Turn a browser fix into a candidate point. Nulls become absences. */
function toTrackPoint(fix: PositionFix): TrackPoint {
  const { coords } = fix;
  const optional = <T>(value: T | null | undefined): T | undefined =>
    value === null || value === undefined ? undefined : value;

  const accuracyM = optional(coords.accuracy);
  const altitudeM = optional(coords.altitude);
  const altitudeAccuracyM = optional(coords.altitudeAccuracy);
  const speedMps = optional(coords.speed);
  const headingDeg = optional(coords.heading);

  return {
    lat: coords.latitude,
    lng: coords.longitude,
    t: fix.timestamp,
    ...(accuracyM === undefined ? {} : { accuracyM }),
    ...(altitudeM === undefined ? {} : { altitudeM }),
    ...(altitudeAccuracyM === undefined ? {} : { altitudeAccuracyM }),
    ...(speedMps === undefined ? {} : { speedMps }),
    ...(headingDeg === undefined ? {} : { headingDeg }),
  };
}

/** A point carries a nested `channels` record once T3.3 lands, so a spread is not enough. */
function clonePoint(point: TrackPoint): TrackPoint {
  return point.channels === undefined
    ? { ...point }
    : { ...point, channels: { ...point.channels } };
}

function toRecorderError(failure: PositionFailure): TrackRecorderError {
  const message = failure.message ?? "geolocation failed";
  switch (failure.code) {
    case POSITION_ERROR.permissionDenied:
      return { kind: "permission-denied", message };
    case POSITION_ERROR.positionUnavailable:
      return { kind: "position-unavailable", message };
    case POSITION_ERROR.timeout:
      return { kind: "timeout", message };
    default:
      return { kind: "position-unavailable", message };
  }
}

/** Exported for tests only — not re-exported from the package barrel. */
export function createWebTrackRecorderInternal(
  options: TrackRecorderOptions,
  environment: WebRecorderEnvironment,
): TrackRecorder {
  const samplingPolicy: SamplingPolicy = resolveSamplingPolicy(options.sampling);
  const mergePolicy: SensorMergePolicy = resolveSensorMergePolicy(options.sensorMerge);
  // Snapshotted: a consumer mutating the array it passed must not change which sensors a
  // running recording listens to.
  const sensors: readonly SensorSource[] = [...(options.sensors ?? [])];

  /**
   * Every channel the configured sensors declare, cloned and de-duplicated **once**.
   *
   * Read lazily, this changed under a recording: mutating a descriptor mid-run rewrote the
   * finalized track, and once autosave exists it would let successive snapshots of one
   * recording disagree about what a channel is called. What a track declares is fixed when
   * the recorder is built.
   */
  const declaredChannels: ChannelDescriptor[] = (() => {
    const byKey = new Map<string, ChannelDescriptor>();
    for (const sensor of sensors) {
      for (const descriptor of sensor.channels) byKey.set(descriptor.key, { ...descriptor });
    }
    return [...byKey.values()];
  })();

  /**
   * Samples gathered since the previous **kept** point.
   *
   * Cleared each time a point is kept, so a channel value is attributed to the point it was
   * observed near rather than accumulating across a whole recording. `mergeSensorSamples`
   * decides which of these are eligible and how to reduce them.
   */
  let pendingSamples: SensorSample[] = [];
  let sensorUnsubscribes: (() => void)[] = [];
  /** Whether sensors are wanted running right now — consulted by a late `start()`. */
  let sensorsDesired = false;

  let status: TrackStatus = "finalized";
  let started = false;

  const points: TrackPoint[] = [];
  const segments: TrackSegment[] = [];
  const laps: LapInput[] = [];

  /** Index where the open segment begins, or undefined when none is open. */
  let segmentStart: number | undefined;
  let segmentStartedAt = 0;
  /** Minted when the segment opens, not when it closes, so a snapshot of an in-progress
   *  segment names the same one the finalized track will. */
  let segmentId: Id | undefined;
  /** Index where the current lap begins. Laps exist only once `markLap` is called. */
  let lapStart = 0;

  /**
   * Minted once, when recording begins, and used by every projection of this recording.
   *
   * Without it `stop()` called twice produces two tracks with different ids over the same
   * points, and T3.4's autosaves would each address a different record instead of
   * overwriting one.
   */
  let trackId: Id | undefined;
  let startedAt = 0;
  let watchId: number | undefined;
  let wakeLock: WakeLockLease | undefined;

  /** The finalized result, so `stop()` is idempotent rather than newly minting each time. */
  let finalized: Track | undefined;

  /**
   * Bumped whenever the watch is torn down. A geolocation callback already queued when
   * `pause()` or `stop()` runs belongs to a session that has ended, and a wake lock request
   * that resolves afterwards must be released rather than held. Both check this.
   */
  let generation = 0;

  /**
   * The last point actually kept, held across the whole recording — pauses included.
   *
   * A fix older than this is stale, whatever segment it arrives in. Letting one through
   * would produce a track `finalizeTrack` refuses to finalize, so the recorder drops it
   * here: this is the layer that received it and the only one that knows it is late.
   * Reordering live observations is the alternative, and it would entangle `onPoint`,
   * sensor merge, laps, segments and autosave for no gain. (ADR-0020)
   */
  let lastKept: TrackPoint | undefined;

  const pointListeners = new Set<(p: TrackPoint) => void>();
  const errorListeners = new Set<(e: TrackRecorderError) => void>();

  const emitError = (error: TrackRecorderError): void => {
    for (const listener of errorListeners) listener(error);
  };

  const openSegment = (): void => {
    segmentStart = points.length;
    segmentStartedAt = environment.now();
    segmentId = newId();
  };

  /** Close the open segment, unless it never received a point — an empty span is not one. */
  const closeSegment = (): void => {
    if (segmentStart === undefined) return;
    const endIndex = points.length - 1;
    if (endIndex >= segmentStart) {
      const first = points[segmentStart];
      const last = points[endIndex];
      segments.push({
        id: segmentId ?? newId(),
        startIndex: segmentStart,
        endIndex,
        startedAt: first?.t ?? segmentStartedAt,
        ...(last === undefined ? {} : { endedAt: last.t }),
      });
    }
    segmentStart = undefined;
    segmentId = undefined;
  };

  const handleFix = (fix: PositionFix, forGeneration: number): void => {
    // A callback queued before the watch was torn down. Not an error, just late.
    if (forGeneration !== generation || status !== "recording") return;

    const candidate = toTrackPoint(fix);

    // Strictly older than the last kept point: dropped before sampling even looks at it.
    // Equal timestamps are fine — two fixes can share a millisecond, and the finalized
    // invariant is non-decreasing. (ADR-0020)
    if (lastKept !== undefined && candidate.t < lastKept.t) return;

    if (!sample(lastKept, candidate, samplingPolicy).keep) return;

    // Merged only into points that survive sampling: a dropped fix is not a moment anyone
    // will ever look at, and attaching telemetry to it would only carry it into the past.
    const channels = mergeSensorSamples(pendingSamples, candidate.t, mergePolicy);
    if (Object.keys(channels).length > 0) candidate.channels = channels;

    // Only what this point could have consumed is discarded. `mergeSensorSamples` excludes
    // a sample dated after the point because it belongs to the *next* one — clearing the
    // whole buffer would throw that away instead, and a sensor whose clock runs slightly
    // ahead of the GPS would report nothing at all.
    pendingSamples = pendingSamples.filter((pending) => pending.t > candidate.t);

    points.push(candidate);
    lastKept = candidate;

    // Each listener gets its own copy. Handing out the object the recorder stores lets a
    // consumer rewrite `t` from a render callback and corrupt sampling and finalization —
    // mutating the second emitted timestamp reproduced a TrackTemporalOrderError on stop —
    // and lets one listener change what the next one sees.
    for (const listener of pointListeners) listener(clonePoint(candidate));
  };

  const handleFailure = (failure: PositionFailure, forGeneration: number): void => {
    if (forGeneration !== generation) return;
    emitError(toRecorderError(failure));
  };

  const acquireWakeLock = async (forGeneration: number): Promise<void> => {
    const lease = await environment.requestWakeLock();
    if (lease === undefined) return;
    // Resolved after the session ended: release rather than hold a lock nobody wants.
    if (forGeneration !== generation) {
      void lease.release().catch(() => undefined);
      return;
    }
    wakeLock = lease;
  };

  const releaseWakeLock = (): void => {
    const lease = wakeLock;
    wakeLock = undefined;
    // A lock the browser already dropped on a visibility change rejects here; that is the
    // ordinary case and not worth surfacing to a consumer.
    if (lease !== undefined) void lease.release().catch(() => undefined);
  };

  /**
   * Subscribe to every sensor and start it.
   *
   * A sensor that fails to start, or fails later, raises `onError` and is otherwise
   * ignored: losing a heart-rate strap must not lose the trip. (ADR-0009)
   */
  const startSensors = (forGeneration: number): void => {
    sensorsDesired = true;
    for (const sensor of sensors) {
      sensorUnsubscribes.push(
        sensor.onSample((sensorSample) => {
          if (forGeneration !== generation || status !== "recording") return;
          // Cloned: a source reusing one sample object would otherwise rewrite readings
          // already buffered, turning an average of 100 and 140 into 140.
          pendingSamples.push({ t: sensorSample.t, values: { ...sensorSample.values } });
        }),
        sensor.onError((error) => {
          if (forGeneration !== generation) return;
          emitError({ kind: "sensor", message: error.message, sourceId: sensor.id });
        }),
      );

      void sensor
        .start()
        .then(() => {
          // A start still pending when pause or stop ran: the immediate `stop()` may have
          // happened before the source was even active, so it would be left running with
          // nothing subscribed. Reconcile against what is wanted *now* — and leave it alone
          // if a newer generation has since started it, since that session owns it.
          if (forGeneration !== generation && !sensorsDesired) {
            void sensor.stop().catch(() => undefined);
          }
        })
        .catch((error: unknown) => {
          if (forGeneration !== generation) return;
          emitError({
            kind: "sensor",
            message: error instanceof Error ? error.message : String(error),
            sourceId: sensor.id,
          });
        });
    }
  };

  const stopSensors = (): void => {
    sensorsDesired = false;
    for (const unsubscribe of sensorUnsubscribes) unsubscribe();
    sensorUnsubscribes = [];
    for (const sensor of sensors) {
      // A sensor refusing to stop is not worth failing a finished recording over.
      void sensor.stop().catch(() => undefined);
    }
    pendingSamples = [];
  };

  const beginWatching = (): void => {
    const forGeneration = generation;
    try {
      watchId = environment.watchPosition(
        (fix) => {
          handleFix(fix, forGeneration);
        },
        (failure) => {
          handleFailure(failure, forGeneration);
        },
      );
    } catch (error) {
      emitError({
        kind: "unsupported",
        message: error instanceof Error ? error.message : "geolocation is unavailable",
      });
    }
    void acquireWakeLock(forGeneration);
    startSensors(forGeneration);
  };

  const stopWatching = (): void => {
    // Bump first: anything already queued is now from the previous generation.
    generation += 1;
    if (watchId !== undefined) {
      environment.clearWatch(watchId);
      watchId = undefined;
    }
    releaseWakeLock();
    stopSensors();
  };

  return {
    get status() {
      return status;
    },

    start: (overrides) => {
      // Idempotent, like every other start in the engine: a second call is a no-op rather
      // than a second watch quietly doubling the fixes.
      if (status === "recording") return Promise.resolve();

      if (started) {
        return Promise.reject(
          new Error("this recorder has already produced a track; create another to record again"),
        );
      }

      started = true;
      status = "recording";
      startedAt = environment.now();
      trackId ??= newId();
      Object.assign(samplingPolicy, resolveSamplingPolicy({ ...options.sampling, ...overrides }));

      openSegment();
      beginWatching();
      return Promise.resolve();
    },

    pause: () => {
      if (status !== "recording") return;
      status = "paused";
      closeSegment();
      // The watch goes too. Holding it while discarding every fix would drain the battery
      // for nothing, and a pause is usually taken precisely to stop that.
      stopWatching();
    },

    resume: () => {
      if (status !== "paused") return;
      status = "recording";
      openSegment();
      beginWatching();
    },

    markLap: (label) => {
      // A lifecycle call after finalization must not change what a repeated `stop()`
      // returns; the recording is over and its result is fixed.
      if (finalized !== undefined) return;
      if (points.length <= lapStart) return; // nothing recorded since the last one
      laps.push({
        id: newId(),
        startIndex: lapStart,
        endIndex: points.length - 1,
        ...(label === undefined ? {} : { label }),
      });
      lapStart = points.length;
    },

    stop: () => {
      // Idempotent, and identical: a second call returns the same track rather than a new
      // one with a fresh id over the same points.
      if (finalized !== undefined) return Promise.resolve(finalized);

      // Stopping something never started used to memoize an empty track while leaving
      // `started` false, so a subsequent `start()` succeeded and every later `stop()`
      // returned the cached empty track before any cleanup — a live watch, status
      // "recording", and a track with no points.
      if (!started) {
        return Promise.reject(new Error("cannot stop a recorder that was never started"));
      }

      closeSegment();
      stopWatching();
      status = "finalized";

      // A final lap only exists if laps were marked at all.
      if (laps.length > 0 && points.length > lapStart) {
        laps.push({ id: newId(), startIndex: lapStart, endIndex: points.length - 1 });
        lapStart = points.length;
      }

      const endedAt = points[points.length - 1]?.t ?? environment.now();

      // Copied again on the way out, so a caller holding the finalized track cannot reach
      // back into what the next projection of this recording will declare.
      const descriptors = declaredChannels.map((descriptor) => ({ ...descriptor }));

      finalized = finalizeTrack({
        points,
        segments,
        id: trackId ?? newId(),
        startedAt: points[0]?.t ?? startedAt,
        endedAt,
        origin: "recorded",
        ...(laps.length === 0 ? {} : { laps }),
        ...(descriptors.length === 0 ? {} : { channels: descriptors }),
      });

      return Promise.resolve(finalized);
    },

    onPoint: (cb) => {
      pointListeners.add(cb);
      return () => pointListeners.delete(cb);
    },

    onError: (cb) => {
      errorListeners.add(cb);
      return () => errorListeners.delete(cb);
    },
  };
}

/**
 * The web (foreground) recorder: `watchPosition` plus a Screen Wake Lock.
 *
 * Foreground only, by design. Recording with the screen locked needs a native shell, which
 * ADR-0003 keeps out of this repo — the `TrackRecorder` seam exists so a consumer can inject
 * one without the engine changing.
 */
export function createWebTrackRecorder(options: TrackRecorderOptions = {}): TrackRecorder {
  return createWebTrackRecorderInternal(options, createBrowserEnvironment());
}

export type { Track };
