// SPDX-License-Identifier: Apache-2.0

// Sampling asks "did this move ~10 m?", so the sphere approximation is the right trade.
// Recorded distance does not come from here — see ADR-0019 and geodesicDistanceMeters.
import { haversineDistanceMeters } from "./geo.js";
import type { TrackPoint } from "./track.js";

/**
 * When a fix is worth keeping. Recording all day at 1 Hz produces a dense cloud of noise
 * around anything stationary — a parked car, a drift, a lunch break — which costs storage,
 * renders badly, and inflates distance. (architecture.md §6)
 */
export interface SamplingPolicy {
  /** Keep a fix only after moving this far since the last kept point. */
  minDistanceM: number;
  /** ...or after this long, so a stationary track still has a heartbeat. */
  maxIntervalMs: number;
  /** Drop fixes worse than this. */
  maxAccuracyM: number;
}

/**
 * Defaults, as named constants rather than literals at the call site.
 *
 * They live in code, not a config file, because `core` is a zero-dependency library
 * consumed in a browser: it has no config loader and no filesystem to read one from. A
 * consumer overrides them per call, which is the seam that matters.
 */
export const DEFAULT_MIN_DISTANCE_M = 10;
export const DEFAULT_MAX_INTERVAL_MS = 15_000;
export const DEFAULT_MAX_ACCURACY_M = 50;

export const DEFAULT_SAMPLING_POLICY: Readonly<SamplingPolicy> = Object.freeze({
  minDistanceM: DEFAULT_MIN_DISTANCE_M,
  maxIntervalMs: DEFAULT_MAX_INTERVAL_MS,
  maxAccuracyM: DEFAULT_MAX_ACCURACY_M,
});

/** Why {@link sample} decided as it did. Recorders surface this when explaining a gap. */
export type SampleReason =
  /** Rejected: the fix is less accurate than the policy allows. */
  | "inaccurate"
  /** Kept: nothing to compare against yet. */
  | "first-point"
  /** Kept: moved further than `minDistanceM` since the last kept point. */
  | "moved"
  /** Kept: `maxIntervalMs` has elapsed, so record one even while stationary. */
  | "interval-elapsed"
  /** Rejected: too close to the last kept point, and too soon. */
  | "too-close";

export interface SampleDecision {
  keep: boolean;
  reason: SampleReason;
  /** Metres from the previous kept point; undefined for the first point. */
  distanceM?: number;
  /** Milliseconds since the previous kept point; undefined for the first point. */
  elapsedMs?: number;
}

/**
 * Decide whether to keep a fix. Pure: no clock, no state, no I/O — the caller owns which
 * point was last kept, which is what makes this testable without a GPS.
 *
 * The order is not arbitrary. Accuracy is checked first and is absolute: "a recorder never
 * emits a point that fails the accuracy filter" (api.md §2), so a wild fix is dropped even
 * when the interval has elapsed and a heartbeat is due. Recording a known-bad position is
 * worse than recording nothing.
 *
 * **Boundaries are taken verbatim from the contract, and they are deliberately asymmetric.**
 * Accuracy drops fixes with `accuracyM > maxAccuracyM`, so a fix exactly at the limit is
 * kept. Distance accepts a fix that "moved > minDistanceM", so exactly `minDistanceM` is
 * not far enough on its own. The interval admits once `maxIntervalMs` has *elapsed*, which
 * includes landing exactly on it. If that asymmetry is ever unwanted, change the words in
 * `specs/architecture.md §6` first — this function follows them, and the tests pin them.
 *
 * A fix with no `accuracyM` at all is not "worse than the limit", so it passes: some
 * devices simply do not report accuracy, and refusing to record them would be a policy the
 * contract does not state.
 */
export function sample(
  previous: TrackPoint | undefined,
  candidate: TrackPoint,
  policy: SamplingPolicy = DEFAULT_SAMPLING_POLICY,
): SampleDecision {
  if (candidate.accuracyM !== undefined && candidate.accuracyM > policy.maxAccuracyM) {
    return { keep: false, reason: "inaccurate" };
  }

  if (previous === undefined) {
    return { keep: true, reason: "first-point" };
  }

  const distanceM = haversineDistanceMeters(previous, candidate);
  const elapsedMs = candidate.t - previous.t;

  if (distanceM > policy.minDistanceM) {
    return { keep: true, reason: "moved", distanceM, elapsedMs };
  }

  if (elapsedMs >= policy.maxIntervalMs) {
    return { keep: true, reason: "interval-elapsed", distanceM, elapsedMs };
  }

  return { keep: false, reason: "too-close", distanceM, elapsedMs };
}

/** Fill a partial policy from the defaults. */
export function resolveSamplingPolicy(partial?: Partial<SamplingPolicy>): SamplingPolicy {
  return { ...DEFAULT_SAMPLING_POLICY, ...partial };
}
