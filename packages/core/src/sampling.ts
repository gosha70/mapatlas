// SPDX-License-Identifier: Apache-2.0

import type { TrackPoint } from "./types.js";
import { haversineM } from "./geo.js";

/**
 * Track sampling policy (api.md §2). Controls which raw geolocation fixes a
 * recorder keeps, independent of any particular geolocation source.
 */
export interface SamplingPolicy {
  /** keep a fix only after moving this far (meters) */
  minDistanceM: number;
  /** ...or after this long (ms) */
  maxIntervalMs: number;
  /** drop fixes worse than this (meters) */
  maxAccuracyM: number;
}

export const DEFAULT_SAMPLING_POLICY: SamplingPolicy = {
  minDistanceM: 10,
  maxIntervalMs: 15_000,
  maxAccuracyM: 50,
};

/** Why `sample` decided to keep or drop a candidate fix. */
export type SampleReason =
  /** first point in a track — always kept (if accuracy passes) */
  | "first"
  /** dropped: accuracy worse than policy.maxAccuracyM */
  | "accuracy"
  /** kept: enough time has passed since the previous point */
  | "interval"
  /** kept: moved at least policy.minDistanceM since the previous point */
  | "distance"
  /** dropped: too close in space and too soon in time */
  | "too-close";

export interface SampleDecision {
  keep: boolean;
  reason: SampleReason;
}

/**
 * Pure decision: given the previously kept point (if any) and a candidate fix,
 * decide whether to keep it under `policy`.
 *
 * Order of checks:
 *  1. accuracy filter — a fix worse than `maxAccuracyM` is always dropped;
 *  2. first point — kept;
 *  3. interval — kept if `maxIntervalMs` has elapsed since `prev`;
 *  4. distance — kept if moved ≥ `minDistanceM` from `prev`;
 *  5. otherwise dropped as too-close.
 */
export function sample(
  prev: TrackPoint | undefined,
  candidate: TrackPoint,
  policy: SamplingPolicy = DEFAULT_SAMPLING_POLICY,
): SampleDecision {
  if (
    candidate.accuracyM !== undefined &&
    candidate.accuracyM > policy.maxAccuracyM
  ) {
    return { keep: false, reason: "accuracy" };
  }

  if (prev === undefined) {
    return { keep: true, reason: "first" };
  }

  if (candidate.t - prev.t >= policy.maxIntervalMs) {
    return { keep: true, reason: "interval" };
  }

  if (haversineM(prev, candidate) >= policy.minDistanceM) {
    return { keep: true, reason: "distance" };
  }

  return { keep: false, reason: "too-close" };
}
