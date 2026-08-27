// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import {
  DEFAULT_SENSOR_MAX_AGE_MS,
  DEFAULT_SENSOR_MERGE_POLICY,
  DEFAULT_SENSOR_REDUCE,
  mergeSensorSamples,
  resolveSensorMergePolicy,
} from "./sensors-merge.js";
import type { SensorSample } from "./sensors.js";

const policy = resolveSensorMergePolicy;

describe("reduction is per channel, over the samples that carry it", () => {
  const staggered: SensorSample[] = [
    { t: 100, values: { a: 10 } },
    { t: 110, values: { b: 20 } },
    { t: 120, values: { a: 14, b: 24 } },
  ];

  it("averages each channel over its own samples, never treating absence as zero", () => {
    // `a` appears at t=100 and t=120, `b` at t=110 and t=120. Counting a missing key as
    // zero would report a=8 and b=14.67 instead.
    expect(mergeSensorSamples(staggered, 200, policy({ reduce: "avg", maxAgeMs: 1000 }))).toEqual({
      a: 12,
      b: 22,
    });
  });

  it("takes the most recent value per channel with last", () => {
    expect(mergeSensorSamples(staggered, 200, policy({ reduce: "last", maxAgeMs: 1000 }))).toEqual({
      a: 14,
      b: 24,
    });
  });

  it("takes per-channel extremes with min and max", () => {
    expect(mergeSensorSamples(staggered, 200, policy({ reduce: "min", maxAgeMs: 1000 }))).toEqual({
      a: 10,
      b: 20,
    });
    expect(mergeSensorSamples(staggered, 200, policy({ reduce: "max", maxAgeMs: 1000 }))).toEqual({
      a: 14,
      b: 24,
    });
  });

  it("reports a channel that appears in only one sample", () => {
    const samples: SensorSample[] = [
      { t: 100, values: { a: 1 } },
      { t: 110, values: { rare: 42 } },
    ];
    expect(mergeSensorSamples(samples, 200, policy({ maxAgeMs: 1000 }))).toEqual({
      a: 1,
      rare: 42,
    });
  });
});

describe("which samples are eligible", () => {
  it("drops a sample older than maxAgeMs", () => {
    const samples: SensorSample[] = [
      { t: 1000, values: { a: 1 } }, // 9s before the point — stale
      { t: 9500, values: { a: 2 } },
    ];
    expect(mergeSensorSamples(samples, 10_000, policy({ maxAgeMs: 5000 }))).toEqual({ a: 2 });
  });

  it("keeps a sample exactly at the age limit", () => {
    const samples: SensorSample[] = [{ t: 5000, values: { a: 1 } }];
    expect(mergeSensorSamples(samples, 10_000, policy({ maxAgeMs: 5000 }))).toEqual({ a: 1 });
  });

  it("drops a sample newer than the point — it belongs to the next one", () => {
    const samples: SensorSample[] = [
      { t: 900, values: { a: 1 } },
      { t: 1100, values: { a: 2 } },
    ];
    expect(mergeSensorSamples(samples, 1000, policy({ maxAgeMs: 5000 }))).toEqual({ a: 1 });
  });

  it("keeps a sample exactly at the point's timestamp", () => {
    expect(
      mergeSensorSamples([{ t: 1000, values: { a: 7 } }], 1000, policy({ maxAgeMs: 5000 })),
    ).toEqual({ a: 7 });
  });

  it("returns nothing when every sample is stale", () => {
    const samples: SensorSample[] = [{ t: 0, values: { a: 1 } }];
    expect(mergeSensorSamples(samples, 100_000, policy({ maxAgeMs: 1000 }))).toEqual({});
  });

  it("returns nothing for no samples", () => {
    expect(mergeSensorSamples([], 1000, policy())).toEqual({});
  });

  it("orders by timestamp for `last`, whatever order it was handed", () => {
    const outOfOrder: SensorSample[] = [
      { t: 300, values: { a: 3 } },
      { t: 100, values: { a: 1 } },
      { t: 200, values: { a: 2 } },
    ];
    expect(mergeSensorSamples(outOfOrder, 400, policy({ maxAgeMs: 1000 }))).toEqual({ a: 3 });
  });

  it("ignores a non-finite value rather than poisoning the channel", () => {
    const samples: SensorSample[] = [
      { t: 100, values: { a: 10 } },
      { t: 110, values: { a: Number.NaN } },
    ];
    expect(mergeSensorSamples(samples, 200, policy({ reduce: "avg", maxAgeMs: 1000 }))).toEqual({
      a: 10,
    });
  });
});

describe("policy", () => {
  it("defaults to last, within ten seconds", () => {
    expect(DEFAULT_SENSOR_MERGE_POLICY).toEqual({ maxAgeMs: 10_000, reduce: "last" });
    expect(DEFAULT_SENSOR_MAX_AGE_MS).toBe(10_000);
    expect(DEFAULT_SENSOR_REDUCE).toBe("last");
    expect(Object.isFrozen(DEFAULT_SENSOR_MERGE_POLICY)).toBe(true);
  });

  it("fills a partial policy", () => {
    expect(resolveSensorMergePolicy({ reduce: "avg" })).toEqual({
      maxAgeMs: 10_000,
      reduce: "avg",
    });
    expect(resolveSensorMergePolicy()).toEqual(DEFAULT_SENSOR_MERGE_POLICY);
  });
});

describe("purity", () => {
  it("does not modify the samples it is given", () => {
    const samples: SensorSample[] = [
      { t: 300, values: { a: 3 } },
      { t: 100, values: { a: 1 } },
    ];
    const before = structuredClone(samples);
    mergeSensorSamples(samples, 400, policy({ maxAgeMs: 1000 }));
    expect(samples).toEqual(before);
  });
});
