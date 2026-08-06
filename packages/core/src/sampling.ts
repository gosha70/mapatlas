// SPDX-License-Identifier: Apache-2.0
import type { TrackPoint } from "./types";
import { haversineMeters } from "./geo";

/** Sampling policy for track recording (see specs/api.md §2). */
export interface SamplingPolicy {
  /** keep a fix only after moving this far */
  minDistanceM: number;
  /** ...or after this long */
  maxIntervalMs: number;
  /** drop fixes worse than this */
  maxAccuracyM: number;
}

/** Contract defaults from specs/api.md §2. */
export const DEFAULT_SAMPLING_POLICY: SamplingPolicy = {
  minDistanceM: 10,
  maxIntervalMs: 15000,
  maxAccuracyM: 50,
};

export type SampleReason =
  "first" | "interval" | "distance" | "too-close" | "low-accuracy";

export interface SampleDecision {
  keep: boolean;
  reason: SampleReason;
}

/**
 * Pure decision function: should `candidate` be kept given the previously kept
 * point `prev` and the sampling `policy`?
 *
 * Branch order is a contract: the accuracy filter runs first, so a recorder
 * built on this function never emits a point that fails the accuracy gate. The
 * first fix is always kept; thereafter a fix is kept once enough time has
 * elapsed (interval) or enough ground has been covered (distance).
 */
export function sample(
  prev: TrackPoint | undefined,
  candidate: TrackPoint,
  policy: SamplingPolicy,
): SampleDecision {
  if (
    candidate.accuracyM !== undefined &&
    candidate.accuracyM > policy.maxAccuracyM
  ) {
    return { keep: false, reason: "low-accuracy" };
  }
  if (prev === undefined) {
    return { keep: true, reason: "first" };
  }
  if (candidate.t - prev.t >= policy.maxIntervalMs) {
    return { keep: true, reason: "interval" };
  }
  if (haversineMeters(prev, candidate) >= policy.minDistanceM) {
    return { keep: true, reason: "distance" };
  }
  return { keep: false, reason: "too-close" };
}
