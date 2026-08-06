// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  DEFAULT_SAMPLING_POLICY,
  sample,
  type SamplingPolicy,
} from "./sampling";
import type { TrackPoint } from "./types";

const policy: SamplingPolicy = {
  minDistanceM: 10,
  maxIntervalMs: 15000,
  maxAccuracyM: 50,
};

const at = (
  lat: number,
  lng: number,
  t: number,
  accuracyM?: number,
): TrackPoint =>
  accuracyM === undefined ? { lat, lng, t } : { lat, lng, t, accuracyM };

describe("sample", () => {
  it("keeps the first fix", () => {
    expect(sample(undefined, at(0, 0, 0), policy)).toEqual({
      keep: true,
      reason: "first",
    });
  });

  it("drops a fix worse than maxAccuracyM (accuracy branch runs first)", () => {
    // Would otherwise pass on interval, but bad accuracy wins.
    const prev = at(0, 0, 0);
    const candidate = at(1, 1, 999999, 80);
    expect(sample(prev, candidate, policy)).toEqual({
      keep: false,
      reason: "low-accuracy",
    });
  });

  it("keeps a fix once maxIntervalMs has elapsed even without movement", () => {
    const prev = at(0, 0, 0);
    const candidate = at(0, 0, 15000);
    expect(sample(prev, candidate, policy)).toEqual({
      keep: true,
      reason: "interval",
    });
  });

  it("keeps a fix once minDistanceM has been covered", () => {
    const prev = at(0, 0, 0);
    // ~111 m east at the equator — well past 10 m.
    const candidate = at(0, 0.001, 1000);
    expect(sample(prev, candidate, policy)).toEqual({
      keep: true,
      reason: "distance",
    });
  });

  it("drops a fix that is too close and too soon", () => {
    const prev = at(0, 0, 0);
    // ~1 m north, 1 s later — under both thresholds.
    const candidate = at(0.00001, 0, 1000);
    expect(sample(prev, candidate, policy)).toEqual({
      keep: false,
      reason: "too-close",
    });
  });

  it("accepts a fix with no accuracy reading", () => {
    expect(sample(undefined, at(0, 0, 0), policy).keep).toBe(true);
  });

  it("exposes the api.md default policy", () => {
    expect(DEFAULT_SAMPLING_POLICY).toEqual({
      minDistanceM: 10,
      maxIntervalMs: 15000,
      maxAccuracyM: 50,
    });
  });
});
