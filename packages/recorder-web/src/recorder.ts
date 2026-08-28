// SPDX-License-Identifier: Apache-2.0

import type {
  LapInput,
  SamplingPolicy,
  Track,
  TrackPoint,
  TrackRecorder,
  TrackRecorderError,
  TrackRecorderOptions,
  TrackSegment,
  TrackStatus,
} from "@mapatlas/core";
import { finalizeTrack, newId, resolveSamplingPolicy, sample } from "@mapatlas/core";

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

  let status: TrackStatus = "finalized";
  let started = false;

  const points: TrackPoint[] = [];
  const segments: TrackSegment[] = [];
  const laps: LapInput[] = [];

  /** Index where the open segment begins, or undefined when none is open. */
  let segmentStart: number | undefined;
  let segmentStartedAt = 0;
  /** Index where the current lap begins. Laps exist only once `markLap` is called. */
  let lapStart = 0;

  let startedAt = 0;
  let watchId: number | undefined;
  let wakeLock: WakeLockLease | undefined;

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
  };

  /** Close the open segment, unless it never received a point — an empty span is not one. */
  const closeSegment = (): void => {
    if (segmentStart === undefined) return;
    const endIndex = points.length - 1;
    if (endIndex >= segmentStart) {
      const first = points[segmentStart];
      const last = points[endIndex];
      segments.push({
        id: newId(),
        startIndex: segmentStart,
        endIndex,
        startedAt: first?.t ?? segmentStartedAt,
        ...(last === undefined ? {} : { endedAt: last.t }),
      });
    }
    segmentStart = undefined;
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

    points.push(candidate);
    lastKept = candidate;
    for (const listener of pointListeners) listener(candidate);
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
  };

  const stopWatching = (): void => {
    // Bump first: anything already queued is now from the previous generation.
    generation += 1;
    if (watchId !== undefined) {
      environment.clearWatch(watchId);
      watchId = undefined;
    }
    releaseWakeLock();
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
      if (status === "finalized" && started && segments.length === 0 && points.length === 0) {
        // Stopped without ever starting, or stopped twice with nothing recorded.
        return Promise.resolve(
          finalizeTrack({ points: [], segments: [], startedAt, endedAt: startedAt }),
        );
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

      return Promise.resolve(
        finalizeTrack({
          points,
          segments,
          startedAt: points[0]?.t ?? startedAt,
          endedAt,
          origin: "recorded",
          ...(laps.length === 0 ? {} : { laps }),
        }),
      );
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
