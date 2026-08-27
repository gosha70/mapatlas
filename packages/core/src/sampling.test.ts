// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { haversineDistanceMeters } from "./geo.js";
import {
  DEFAULT_MAX_ACCURACY_M,
  DEFAULT_MAX_INTERVAL_MS,
  DEFAULT_MIN_DISTANCE_M,
  DEFAULT_SAMPLING_POLICY,
  resolveSamplingPolicy,
  sample,
} from "./sampling.js";
import type { SamplingPolicy } from "./sampling.js";
import type { TrackPoint } from "./track.js";

const POLICY: SamplingPolicy = { minDistanceM: 10, maxIntervalMs: 15_000, maxAccuracyM: 50 };

const T0 = 1_700_000_000_000;
const ORIGIN = { lat: 59.33, lng: 18.06 };

/** A point `metresNorth` from the origin, `afterMs` later. */
function point(metresNorth: number, afterMs: number, accuracyM?: number): TrackPoint {
  const degreesPerMetre = 1 / 111_195; // metres per degree of latitude, near enough
  return {
    lat: ORIGIN.lat + metresNorth * degreesPerMetre,
    lng: ORIGIN.lng,
    t: T0 + afterMs,
    ...(accuracyM === undefined ? {} : { accuracyM }),
  };
}

const PREVIOUS: TrackPoint = { ...ORIGIN, t: T0 };

describe("the fixture itself", () => {
  it("places points where it claims to, within a centimetre", () => {
    expect(haversineDistanceMeters(PREVIOUS, point(10, 0))).toBeCloseTo(10, 2);
    expect(haversineDistanceMeters(PREVIOUS, point(100, 0))).toBeCloseTo(100, 2);
  });
});

describe("accuracy branch — absolute, and checked first", () => {
  it("drops a fix worse than the limit", () => {
    const decision = sample(PREVIOUS, point(500, 1000, 80), POLICY);
    expect(decision).toEqual({ keep: false, reason: "inaccurate" });
  });

  it("keeps a fix exactly at the limit — the contract drops `> maxAccuracyM`, not `>=`", () => {
    const decision = sample(PREVIOUS, point(500, 1000, POLICY.maxAccuracyM), POLICY);
    expect(decision.keep).toBe(true);
  });

  it("drops a fix one metre past the limit", () => {
    expect(sample(PREVIOUS, point(500, 1000, POLICY.maxAccuracyM + 1), POLICY).keep).toBe(false);
  });

  it("outranks the interval: a stale heartbeat is not worth a known-bad position", () => {
    // Moved nowhere, interval long past — the fix would otherwise be kept.
    const decision = sample(PREVIOUS, point(0, POLICY.maxIntervalMs * 10, 999), POLICY);
    expect(decision).toEqual({ keep: false, reason: "inaccurate" });
  });

  it("outranks distance too", () => {
    expect(sample(PREVIOUS, point(5000, 1000, 999), POLICY).reason).toBe("inaccurate");
  });

  it("keeps a fix that reports no accuracy at all", () => {
    // Not "worse than the limit". Some devices never report accuracy, and rejecting them
    // would be a policy the contract does not state.
    expect(sample(PREVIOUS, point(500, 1000), POLICY).keep).toBe(true);
  });

  it("applies to the first point as well", () => {
    expect(sample(undefined, point(0, 0, 999), POLICY)).toEqual({
      keep: false,
      reason: "inaccurate",
    });
  });
});

describe("first-point branch", () => {
  it("keeps the first acceptable fix, with nothing to compare against", () => {
    const decision = sample(undefined, point(0, 0, 5), POLICY);
    expect(decision).toEqual({ keep: true, reason: "first-point" });
    expect(decision.distanceM).toBeUndefined();
    expect(decision.elapsedMs).toBeUndefined();
  });
});

describe("distance branch — strictly greater than minDistanceM", () => {
  it("keeps a fix that moved further than the minimum", () => {
    const decision = sample(PREVIOUS, point(25, 1000), POLICY);
    expect(decision.keep).toBe(true);
    expect(decision.reason).toBe("moved");
    expect(decision.distanceM).toBeCloseTo(25, 1);
    expect(decision.elapsedMs).toBe(1000);
  });

  it("rejects a fix exactly at minDistanceM — the contract says moved `>`, not `>=`", () => {
    // The threshold is derived from the measured distance rather than by trying to place a
    // point at exactly 10 m: metres-per-degree is an approximation, and a boundary test
    // that depends on a fixture's rounding is testing the fixture, not the contract.
    const candidate = point(10, 1000);
    const exactly = haversineDistanceMeters(PREVIOUS, candidate);

    const decision = sample(PREVIOUS, candidate, { ...POLICY, minDistanceM: exactly });
    expect(decision.keep).toBe(false);
    expect(decision.reason).toBe("too-close");
  });

  it("keeps a fix a hair past the minimum", () => {
    const candidate = point(10, 1000);
    const exactly = haversineDistanceMeters(PREVIOUS, candidate);
    const decision = sample(PREVIOUS, candidate, { ...POLICY, minDistanceM: exactly - 0.001 });
    expect(decision.keep).toBe(true);
    expect(decision.reason).toBe("moved");
  });
});

describe("interval branch — elapsed, so `>=`", () => {
  it("keeps a stationary fix once the interval has elapsed", () => {
    const decision = sample(PREVIOUS, point(0, POLICY.maxIntervalMs + 1), POLICY);
    expect(decision.keep).toBe(true);
    expect(decision.reason).toBe("interval-elapsed");
    expect(decision.distanceM).toBeCloseTo(0, 3);
  });

  it("keeps a fix landing exactly on the interval — an interval has elapsed at `==`", () => {
    const decision = sample(PREVIOUS, point(0, POLICY.maxIntervalMs), POLICY);
    expect(decision.keep).toBe(true);
    expect(decision.reason).toBe("interval-elapsed");
  });

  it("rejects a stationary fix one millisecond early", () => {
    const decision = sample(PREVIOUS, point(0, POLICY.maxIntervalMs - 1), POLICY);
    expect(decision.keep).toBe(false);
    expect(decision.reason).toBe("too-close");
  });

  it("reports `moved` when both branches would admit — distance is the better reason", () => {
    expect(sample(PREVIOUS, point(500, POLICY.maxIntervalMs * 2), POLICY).reason).toBe("moved");
  });
});

describe("rejection carries its measurements, so a caller can explain the gap", () => {
  it("reports how far and how long, even when rejecting", () => {
    const decision = sample(PREVIOUS, point(2, 3000), POLICY);
    expect(decision.keep).toBe(false);
    expect(decision.distanceM).toBeCloseTo(2, 1);
    expect(decision.elapsedMs).toBe(3000);
  });
});

describe("the anchored-boat case this exists for", () => {
  it("keeps four points from an hour of GPS noise, not thousands", () => {
    const policy: SamplingPolicy = {
      minDistanceM: 10,
      maxIntervalMs: 15 * 60_000,
      maxAccuracyM: 50,
    };
    let kept: TrackPoint | undefined;
    const keptPoints: TrackPoint[] = [];

    // One fix a second for an hour, drifting ±3 m around a mooring.
    for (let second = 0; second < 3600; second += 1) {
      const jitter = Math.sin(second) * 3;
      const candidate = point(jitter, second * 1000, 8);
      if (sample(kept, candidate, policy).keep) {
        kept = candidate;
        keptPoints.push(candidate);
      }
    }

    expect(keptPoints.length).toBe(4); // the first, then one per 15-minute heartbeat
    expect(keptPoints.length / 3600).toBeLessThan(0.01);
  });
});

describe("out-of-order fixes", () => {
  it("still admits one that moved far enough, and reports negative elapsed rather than hiding it", () => {
    // GPS can deliver fixes out of order. The contract says nothing about rejecting them,
    // so this does not invent a policy — it surfaces the anomaly for the caller.
    const decision = sample(PREVIOUS, point(500, -5000), POLICY);
    expect(decision.keep).toBe(true);
    expect(decision.reason).toBe("moved");
    expect(decision.elapsedMs).toBe(-5000);
  });

  it("does not let a negative elapsed satisfy the interval", () => {
    expect(sample(PREVIOUS, point(0, -60_000), POLICY).keep).toBe(false);
  });
});

describe("policy resolution", () => {
  it("defaults to the documented values", () => {
    expect(DEFAULT_SAMPLING_POLICY).toEqual({
      minDistanceM: DEFAULT_MIN_DISTANCE_M,
      maxIntervalMs: DEFAULT_MAX_INTERVAL_MS,
      maxAccuracyM: DEFAULT_MAX_ACCURACY_M,
    });
    expect(DEFAULT_MIN_DISTANCE_M).toBe(10);
    expect(DEFAULT_MAX_INTERVAL_MS).toBe(15_000);
    expect(DEFAULT_MAX_ACCURACY_M).toBe(50);
  });

  it("cannot be mutated by a consumer", () => {
    expect(Object.isFrozen(DEFAULT_SAMPLING_POLICY)).toBe(true);
  });

  it("fills a partial policy and leaves the rest alone", () => {
    expect(resolveSamplingPolicy({ minDistanceM: 1 })).toEqual({
      minDistanceM: 1,
      maxIntervalMs: DEFAULT_MAX_INTERVAL_MS,
      maxAccuracyM: DEFAULT_MAX_ACCURACY_M,
    });
    expect(resolveSamplingPolicy()).toEqual(DEFAULT_SAMPLING_POLICY);
  });

  it("uses the defaults when no policy is passed at all", () => {
    expect(sample(PREVIOUS, point(0, DEFAULT_MAX_INTERVAL_MS)).reason).toBe("interval-elapsed");
    expect(sample(PREVIOUS, point(0, 0, DEFAULT_MAX_ACCURACY_M + 1)).reason).toBe("inaccurate");
  });
});
