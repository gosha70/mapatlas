// SPDX-License-Identifier: Apache-2.0

import type { SamplingPolicy } from "./sampling.js";
import type { SensorMergePolicy, SensorSource } from "./sensors.js";
import type { StorageAdapter } from "./storage.js";
import type { Track, TrackPoint, TrackStatus } from "./track.js";

export type TrackRecorderErrorKind =
  "permission-denied" | "position-unavailable" | "timeout" | "unsupported" | "sensor";

export interface TrackRecorderError {
  kind: TrackRecorderErrorKind;
  message: string;
  /** Which {@link SensorSource} failed, when `kind` is "sensor". */
  sourceId?: string;
}

/**
 * Produces a {@link Track} from live position fixes.
 *
 * A recorder never emits a point that fails the accuracy filter; `pause()`/`resume()` open
 * and close segments so a paused span is a real gap rather than a straight line; `stop()`
 * returns a finalized track with segments, simplified geometry and statistics.
 *
 * It is also this layer's job to **drop a stale out-of-order fix** rather than let it
 * become a kept point. `sample()` observes and reports a negative elapsed time without
 * judging it, and `finalizeTrack` refuses to finalize a track whose clock runs backwards —
 * so a recorder that admits one produces a track that cannot be finalized. Reordering live
 * observations is not the answer: buffering would entangle `onPoint`, sensor merge, laps,
 * segments and autosave. (ADR-0020)
 */
export interface TrackRecorder {
  readonly status: TrackStatus;
  start(opts?: Partial<SamplingPolicy>): Promise<void>;
  /** Closes the current segment. */
  pause(): void;
  /** Opens a new segment. */
  resume(): void;
  /** Splits the current lap at the latest point. */
  markLap(label?: string): void;
  stop(): Promise<Track>;
  /** Kept points only, post-sampling, with sensor channels already merged. */
  onPoint(cb: (p: TrackPoint) => void): () => void;
  onError(cb: (e: TrackRecorderError) => void): () => void;
}

export interface TrackRecorderOptions {
  store?: StorageAdapter;
  sampling?: Partial<SamplingPolicy>;
  sensors?: SensorSource[];
  sensorMerge?: Partial<SensorMergePolicy>;
  /**
   * Persist the in-progress track this often, so a crash or a killed tab loses at most one
   * interval rather than a whole trip. Requires `store`. `0` disables. (ADR-0015)
   */
  autosaveMs?: number;
}
