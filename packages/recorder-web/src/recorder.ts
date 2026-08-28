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
  TrackLap,
  TrackSegment,
  TrackStatus,
} from "@mapatlas/core";
import {
  TrackTemporalOrderError,
  assertValidTrackGeometry,
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

/**
 * How often an in-progress track is persisted when a store is supplied and no interval is
 * given. Ten seconds is what `api.md` documents: enough that a long recording is not
 * writing constantly, short enough that a crash costs a few points rather than a trip.
 */
export const DEFAULT_AUTOSAVE_MS = 10_000;

/** Two configured sensors describe one channel key differently. */
export class ChannelConflictError extends Error {
  readonly channelKey: string;

  constructor(channelKey: string, detail: string) {
    super(`conflicting channel definitions: ${detail}`);
    this.name = "ChannelConflictError";
    this.channelKey = channelKey;
  }
}

/** A track offered to `resumeFrom` that cannot be continued. */
export class RecorderResumeError extends Error {
  readonly reason: "temporal-order" | "channel-conflict" | "geometry" | "not-interrupted";

  constructor(reason: RecorderResumeError["reason"], detail: string, options?: ErrorOptions) {
    super(`cannot resume this track: ${detail}`, options);
    this.name = "RecorderResumeError";
    this.reason = reason;
  }
}

/**
 * Timestamps across the whole restored track must be non-decreasing.
 *
 * Stricter than `assertValidTrackGeometry`, deliberately: that checks chronology *within*
 * each segment, because a pause is a legitimate gap. The recorder holds the stronger rule —
 * `lastKept` spans pauses — so a track whose second segment starts before the first ended
 * would pass validation and then reject every subsequent fix as stale.
 */
function assertRestorableOrder(points: readonly TrackPoint[]): void {
  for (let i = 1; i < points.length; i += 1) {
    const previous = points[i - 1];
    const current = points[i];
    if (previous === undefined || current === undefined) continue;
    if (current.t < previous.t) {
      throw new RecorderResumeError(
        "temporal-order",
        `points[${i}].t (${current.t}) precedes points[${i - 1}].t (${previous.t})`,
      );
    }
  }
}

/**
 * Two descriptors describe the same channel only if they agree on **everything**.
 *
 * `aggregate` matters as much as `unit`: it decides whether `computeStats` sums a channel
 * or averages it, so a definition that changes it changes what every stored value means.
 * `min`, `max` and `precision` are display bounds, but a silent change there still leaves a
 * track whose descriptor does not describe its own data.
 *
 * An omitted `aggregate` is normalised to "avg", which is the documented default — the two
 * spellings mean the same thing and should not read as a conflict.
 */
function describeChannel(descriptor: ChannelDescriptor): string {
  return JSON.stringify({
    key: descriptor.key,
    label: descriptor.label,
    unit: descriptor.unit,
    aggregate: descriptor.aggregate ?? "avg",
    min: descriptor.min ?? null,
    max: descriptor.max ?? null,
    precision: descriptor.precision ?? null,
  });
}

/** The mismatch between two definitions of one channel, or undefined when they agree. */
function channelMismatch(
  existing: ChannelDescriptor,
  incoming: ChannelDescriptor,
  context: string,
): string | undefined {
  if (describeChannel(existing) === describeChannel(incoming)) return undefined;
  return (
    `channel "${incoming.key}" ${context}: ${describeChannel(existing)} ` +
    `does not match ${describeChannel(incoming)}`
  );
}

/**
 * Collect what the configured sensors declare, rejecting two definitions of one key.
 *
 * A `Map` alone lets the last source win silently, so two sensors reporting depth in metres
 * and feet would produce a track labelled one way holding values measured the other.
 */
function collectSensorChannels(sensors: readonly SensorSource[]): ChannelDescriptor[] {
  const byKey = new Map<string, ChannelDescriptor>();
  for (const sensor of sensors) {
    for (const descriptor of sensor.channels) {
      const existing = byKey.get(descriptor.key);
      if (existing === undefined) {
        byKey.set(descriptor.key, { ...descriptor });
        continue;
      }
      const mismatch = channelMismatch(
        existing,
        descriptor,
        "is declared twice by the configured sensors",
      );
      // A configuration fault, not a recovery one: this path runs whether or not a track is
      // being resumed, and reporting it as "cannot resume this track" would send a reader
      // looking for a snapshot that does not exist.
      if (mismatch !== undefined) throw new ChannelConflictError(descriptor.key, mismatch);
    }
  }
  return [...byKey.values()];
}

/**
 * Historical descriptors are preserved and new keys appended.
 *
 * A key defined two ways is rejected rather than reconciled: the stored values were
 * recorded under the old definition, and silently adopting a new one would reinterpret data
 * already on disk.
 */
function mergeChannelDescriptors(
  restored: readonly ChannelDescriptor[],
  declared: readonly ChannelDescriptor[],
): ChannelDescriptor[] {
  const merged = new Map<string, ChannelDescriptor>();
  for (const descriptor of restored) merged.set(descriptor.key, { ...descriptor });

  for (const descriptor of declared) {
    const existing = merged.get(descriptor.key);
    if (existing === undefined) {
      merged.set(descriptor.key, { ...descriptor });
      continue;
    }
    const mismatch = channelMismatch(
      existing,
      descriptor,
      "was recorded under a different definition",
    );
    if (mismatch !== undefined) throw new RecorderResumeError("channel-conflict", mismatch);
  }

  return [...merged.values()];
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
  const sensorChannels: ChannelDescriptor[] = collectSensorChannels(sensors);

  const resumed = options.resumeFrom;
  if (resumed !== undefined) {
    // Only a recording a previous session left unfinished. A finalized track is a durable
    // trip, and resuming one would let this recorder overwrite it under its own id —
    // silently replacing a finished trip with a partial one.
    if (resumed.status !== "recording" && resumed.status !== "paused") {
      throw new RecorderResumeError(
        "not-interrupted",
        `its status is "${resumed.status}"; only an interrupted recording can be continued`,
      );
    }
    if (resumed.origin !== "recorded") {
      throw new RecorderResumeError(
        "not-interrupted",
        `its origin is "${resumed.origin}"; a recorder continues only what a recorder produced`,
      );
    }
    // Wrapped so every way of failing to resume raises one family. Unwrapped, a caller
    // handling RecorderResumeError would still be surprised by a core geometry error
    // depending on which invariant the stored track happened to violate; the original is
    // kept as `cause` so nothing is lost.
    //
    // The reason is discriminated rather than assumed. `assertValidTrackGeometry` validates
    // ranges, coverage *and* chronology within each segment, so a backwards timestamp
    // inside one segment surfaces here — and reporting that as "geometry" would tell a
    // caller the shape was wrong when the clock was. A regression across a boundary is
    // caught by `assertRestorableOrder` below; both are the same fault to a consumer, and
    // both must say so.
    try {
      assertValidTrackGeometry(resumed);
    } catch (error) {
      throw new RecorderResumeError(
        error instanceof TrackTemporalOrderError ? "temporal-order" : "geometry",
        error instanceof Error ? error.message : String(error),
        { cause: error },
      );
    }
    assertRestorableOrder(resumed.points);
  }

  const declaredChannels: ChannelDescriptor[] =
    resumed === undefined
      ? sensorChannels
      : mergeChannelDescriptors(resumed.channels ?? [], sensorChannels);

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

  /**
   * Autosave is on when a store exists and the interval is positive — resolved once, so the
   * periodic write and the pause flush can never disagree.
   *
   * Previously they did, in both directions: omitting `autosaveMs` created no timer despite
   * the documented default, and setting it to `0` disabled the timer while `pause()` went
   * on writing snapshots the consumer had asked not to have.
   */
  const autosaveMs = options.autosaveMs ?? DEFAULT_AUTOSAVE_MS;
  // Exactly `0`, or a positive finite number of milliseconds. Anything else is rejected
  // rather than given an undocumented meaning: `Infinity` reached `setInterval` unchanged,
  // and a negative or NaN interval quietly acquired the "disabled" sense that only `0` has.
  // Same boundary the polling sensor source enforces.
  if (autosaveMs !== 0 && (!Number.isFinite(autosaveMs) || autosaveMs <= 0)) {
    throw new RangeError(
      `autosaveMs must be 0 or a positive, finite number of milliseconds: ${autosaveMs}`,
    );
  }
  const autosaveEnabled = options.store !== undefined && autosaveMs > 0;

  let writeInFlight: Promise<void> | undefined;
  let pendingSnapshot: Track | undefined;
  let autosaveHandle: unknown;
  let stopPromise: Promise<Track> | undefined;

  let status: TrackStatus = "finalized";
  let started = false;

  const points: TrackPoint[] = (resumed?.points ?? []).map(clonePoint);
  const segments: TrackSegment[] = (resumed?.segments ?? []).map((segment) => ({ ...segment }));
  const laps: LapInput[] = (resumed?.laps ?? []).map((lap) => ({
    id: lap.id,
    startIndex: lap.startIndex,
    endIndex: lap.endIndex,
    ...(lap.label === undefined ? {} : { label: lap.label }),
  }));

  /** Index where the open segment begins, or undefined when none is open. */
  let segmentStart: number | undefined;
  let segmentStartedAt = 0;
  /** Minted when the segment opens, not when it closes, so a snapshot of an in-progress
   *  segment names the same one the finalized track will. */
  let segmentId: Id | undefined;
  /** Index where the current lap begins. Laps exist only once `markLap` is called. */
  let lapStart = laps.length === 0 ? 0 : (laps[laps.length - 1]?.endIndex ?? -1) + 1;

  /**
   * Minted once, when recording begins, and used by every projection of this recording.
   *
   * Without it `stop()` called twice produces two tracks with different ids over the same
   * points, and T3.4's autosaves would each address a different record instead of
   * overwriting one.
   */
  let trackId: Id | undefined = resumed?.id;
  /**
   * Canonical for this recording: every snapshot and the final track carry the same value.
   *
   * Not the first point's timestamp. A snapshot written before any fix arrives has no first
   * point, so deriving it there would let successive projections of one recording disagree
   * about when it began — and a resumed track must keep the moment the *original* session
   * started, not when recovery happened.
   */
  let startedAt = resumed?.startedAt ?? 0;
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
  let lastKept: TrackPoint | undefined = points[points.length - 1];

  const pointListeners = new Set<(p: TrackPoint) => void>();
  const errorListeners = new Set<(e: TrackRecorderError) => void>();

  const emitError = (error: TrackRecorderError): void => {
    for (const listener of errorListeners) listener(error);
  };

  /**
   * An immutable picture of the recording as it stands, cheap enough to write on a timer.
   *
   * Deliberately **not** finalized. Statistics and simplification are derived (ADR-0022) and
   * would cost a full pass over every point on each autosave, for a value nobody reads until
   * the trip ends. `status` stays `recording` or `paused`, which is exactly what
   * `recoverInterruptedTrack` looks for — a finalized snapshot would be invisible to it.
   *
   * Lap `index` and timing are derived because `TrackLap` requires them and both are one
   * lookup; lap statistics are not, for the same reason the track's are not.
   */
  const buildSnapshot = (): Track => {
    const snapshotSegments = segments.map((segment) => ({ ...segment }));

    // The segment still open, if it has caught anything. Its id was minted when it opened,
    // so successive snapshots name the same segment rather than inventing a new one.
    if (segmentStart !== undefined && points.length - 1 >= segmentStart) {
      const first = points[segmentStart];
      const last = points[points.length - 1];
      snapshotSegments.push({
        id: segmentId ?? newId(),
        startIndex: segmentStart,
        endIndex: points.length - 1,
        startedAt: first?.t ?? segmentStartedAt,
        ...(last === undefined ? {} : { endedAt: last.t }),
      });
    }

    const snapshotLaps: TrackLap[] = laps.map((lap, index) => {
      const first = points[lap.startIndex];
      const last = points[lap.endIndex];
      return {
        id: lap.id,
        index,
        startIndex: lap.startIndex,
        endIndex: lap.endIndex,
        startedAt: first?.t ?? startedAt,
        ...(last === undefined ? {} : { endedAt: last.t }),
        ...(lap.label === undefined ? {} : { label: lap.label }),
      };
    });

    return {
      id: trackId ?? newId(),
      startedAt,
      status: status === "paused" ? "paused" : "recording",
      origin: "recorded",
      points: points.map(clonePoint),
      segments: snapshotSegments,
      ...(snapshotLaps.length === 0 ? {} : { laps: snapshotLaps }),
      ...(declaredChannels.length === 0
        ? {}
        : { channels: declaredChannels.map((descriptor) => ({ ...descriptor })) }),
    };
  };

  /**
   * At most one write in flight, and only the newest pending snapshot is kept.
   *
   * Two writes racing could land out of order and leave an older picture on disk, still
   * recoverable and wrong. Queueing keeps the sequence; discarding superseded snapshots
   * keeps a slow store from accumulating a backlog of pictures nobody will ever want.
   */
  const enqueueSave = (snapshot: Track): void => {
    const store = options.store;
    if (store === undefined || !autosaveEnabled) return;

    pendingSnapshot = snapshot;
    if (writeInFlight !== undefined) return;

    writeInFlight = (async () => {
      while (pendingSnapshot !== undefined) {
        const next = pendingSnapshot;
        pendingSnapshot = undefined;
        try {
          await store.saveTrack(next);
        } catch (error) {
          // A failed autosave costs durability, not the recording. It must not poison the
          // queue, and it must not surface as an unhandled rejection.
          emitError({
            kind: "storage",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      writeInFlight = undefined;
    })();
  };

  /** Wait for the queue to drain, so the final write is genuinely last. */
  const drainWrites = async (): Promise<void> => {
    while (writeInFlight !== undefined) await writeInFlight;
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
      // A resumed recording keeps the moment its original session began.
      if (resumed === undefined) startedAt = environment.now();
      trackId ??= newId();
      Object.assign(samplingPolicy, resolveSamplingPolicy({ ...options.sampling, ...overrides }));

      openSegment();
      beginWatching();

      if (autosaveEnabled) {
        autosaveHandle = environment.setInterval(() => {
          enqueueSave(buildSnapshot());
        }, autosaveMs);
      }

      return Promise.resolve();
    },

    pause: () => {
      if (status !== "recording") return;

      status = "paused";
      closeSegment();
      // The watch goes too. Holding it while discarding every fix would drain the battery
      // for nothing, and a pause is usually taken precisely to stop that.
      stopWatching();

      // Flushed now rather than waiting for the next tick: a pause is often the last thing
      // that happens before an app is backgrounded and killed, which is exactly when the
      // interval is least likely to fire again. The timer keeps running — a paused track is
      // still recoverable — it simply has less to write.
      enqueueSave(buildSnapshot());
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
      if (stopPromise !== undefined) return stopPromise;
      if (finalized !== undefined) {
        // Finalized already, but its save failed and was not retried by a live promise.
        const store = options.store;
        if (store === undefined) return Promise.resolve(finalized);
        const track = finalized;
        stopPromise = store.saveTrack(track).then(() => track);
        return stopPromise.catch((error: unknown) => {
          stopPromise = undefined;
          throw error;
        });
      }

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

      if (autosaveHandle !== undefined) {
        environment.clearInterval(autosaveHandle);
        autosaveHandle = undefined;
      }

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
        startedAt,
        endedAt,
        origin: "recorded",
        ...(laps.length === 0 ? {} : { laps }),
        ...(descriptors.length === 0 ? {} : { channels: descriptors }),
      });

      const track = finalized;
      const store = options.store;
      if (store === undefined) return Promise.resolve(track);

      // Memoizing the *promise*, not just the result: two concurrent stops must await the
      // same drain and produce exactly one final save, rather than racing each other.
      stopPromise = (async () => {
        // Queued snapshots first, so an older picture cannot land after the finished track
        // and leave it falsely recoverable.
        await drainWrites();
        await store.saveTrack(track);
        return track;
      })().catch((error: unknown) => {
        // A failed final save is worth surfacing, and worth retrying: the finalized track
        // is already memoized, so a second stop() re-attempts the write rather than
        // rebuilding or losing it.
        stopPromise = undefined;
        throw error;
      });

      return stopPromise;
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
