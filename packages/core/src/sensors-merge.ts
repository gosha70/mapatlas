// SPDX-License-Identifier: Apache-2.0

import type { SensorMergePolicy, SensorSample } from "./sensors.js";

export const DEFAULT_SENSOR_MAX_AGE_MS = 10_000;
export const DEFAULT_SENSOR_REDUCE: SensorMergePolicy["reduce"] = "last";

export const DEFAULT_SENSOR_MERGE_POLICY: Readonly<SensorMergePolicy> = Object.freeze({
  maxAgeMs: DEFAULT_SENSOR_MAX_AGE_MS,
  reduce: DEFAULT_SENSOR_REDUCE,
});

export function resolveSensorMergePolicy(partial?: Partial<SensorMergePolicy>): SensorMergePolicy {
  return { ...DEFAULT_SENSOR_MERGE_POLICY, ...partial };
}

/**
 * Reduce the samples collected since the previous kept point into the channel values that
 * belong on this one.
 *
 * Reduction is **per channel, over the samples that actually carry that key**. Sensors
 * report at different rates and a sample may hold a subset, so a channel missing from a
 * sample is absent, not zero — averaging it in as zero would drag a heart rate toward the
 * floor every time a depth reading arrived alone.
 *
 * Two samples are excluded: any older than `maxAgeMs` before the point, which is stale
 * enough to describe somewhere else; and any *newer* than the point, which has not happened
 * yet as far as this point is concerned and belongs to the next one.
 */
export function mergeSensorSamples(
  samples: readonly SensorSample[],
  pointT: number,
  policy: SensorMergePolicy,
): Record<string, number> {
  const eligible = samples
    .filter((sample) => sample.t <= pointT && pointT - sample.t <= policy.maxAgeMs)
    .sort((a, b) => a.t - b.t);

  const collected = new Map<string, number[]>();
  for (const sample of eligible) {
    for (const [key, value] of Object.entries(sample.values)) {
      if (!Number.isFinite(value)) continue;
      const values = collected.get(key);
      if (values === undefined) collected.set(key, [value]);
      else values.push(value);
    }
  }

  const merged: Record<string, number> = {};
  for (const [key, values] of collected) {
    // `eligible` is sorted, so the last entry per key is genuinely the most recent.
    const reduced =
      policy.reduce === "last"
        ? values[values.length - 1]
        : policy.reduce === "min"
          ? Math.min(...values)
          : policy.reduce === "max"
            ? Math.max(...values)
            : values.reduce((total, value) => total + value, 0) / values.length;

    if (reduced !== undefined) merged[key] = reduced;
  }

  return merged;
}
