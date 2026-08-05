// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import type { TrackPoint } from "./types.js";
import { DEFAULT_SAMPLING_POLICY, sample } from "./sampling.js";

const policy = { minDistanceM: 10, maxIntervalMs: 15_000, maxAccuracyM: 50 };

function pt(p: Partial<TrackPoint>): TrackPoint {
  return { lat: 0, lng: 0, t: 0, ...p };
}

describe("sample", () => {
  it("keeps the first point when there is no previous", () => {
    const d = sample(undefined, pt({ t: 0 }), policy);
    expect(d).toEqual({ keep: true, reason: "first" });
  });

  it("drops a fix worse than maxAccuracyM (accuracy branch)", () => {
    const prev = pt({ t: 0 });
    const d = sample(
      prev,
      pt({ lat: 1, lng: 1, t: 1000, accuracyM: 75 }),
      policy,
    );
    expect(d).toEqual({ keep: false, reason: "accuracy" });
  });

  it("drops a bad first fix on accuracy before the first-point rule", () => {
    const d = sample(undefined, pt({ accuracyM: 100 }), policy);
    expect(d).toEqual({ keep: false, reason: "accuracy" });
  });

  it("keeps a fix once maxIntervalMs has elapsed (interval branch)", () => {
    const prev = pt({ t: 0 });
    // Same location, but 20 s later.
    const d = sample(prev, pt({ t: 20_000 }), policy);
    expect(d).toEqual({ keep: true, reason: "interval" });
  });

  it("keeps a fix once it has moved minDistanceM (distance branch)", () => {
    const prev = pt({ lat: 0, lng: 0, t: 0 });
    // ~111 m east, only 1 s later.
    const d = sample(prev, pt({ lat: 0, lng: 0.001, t: 1000 }), policy);
    expect(d).toEqual({ keep: true, reason: "distance" });
  });

  it("drops a fix that is too close in space and too soon in time", () => {
    const prev = pt({ lat: 0, lng: 0, t: 0 });
    // ~1.1 m east, 1 s later — under both thresholds.
    const d = sample(prev, pt({ lat: 0, lng: 0.00001, t: 1000 }), policy);
    expect(d).toEqual({ keep: false, reason: "too-close" });
  });

  it("keeps a good fix with no accuracy field", () => {
    const prev = pt({ t: 0 });
    const d = sample(prev, pt({ lat: 0, lng: 0.001, t: 1000 }), policy);
    expect(d.keep).toBe(true);
  });

  it("uses the default policy when none is provided", () => {
    expect(DEFAULT_SAMPLING_POLICY.minDistanceM).toBe(10);
    const d = sample(undefined, pt({}));
    expect(d.keep).toBe(true);
  });
});
