// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { simplify } from "./simplify.js";
import type { TrackPoint } from "./track.js";

const T0 = 1_700_000_000_000;
const ORIGIN = { lat: 59.33, lng: 18.06 };
const DEG_PER_M = 1 / 111_195;

/** A point `north` and `east` metres from the origin, `afterMs` later. */
function at(
  north: number,
  east: number,
  afterMs: number,
  extra: Partial<TrackPoint> = {},
): TrackPoint {
  return {
    lat: ORIGIN.lat + north * DEG_PER_M,
    lng: ORIGIN.lng + (east * DEG_PER_M) / Math.cos(ORIGIN.lat * (Math.PI / 180)),
    t: T0 + afterMs,
    ...extra,
  };
}

/**
 * A 2 km winding path sampled every 5 m with ±5 m of deterministic jitter — real curvature
 * at roughly a 60 m scale, plus the noise a phone GPS actually produces.
 */
function noisyWindingPath(): TrackPoint[] {
  const points: TrackPoint[] = [];
  for (let i = 0; i < 400; i += 1) {
    const alongM = i * 5;
    const curveM = Math.sin(alongM / 60) * 40;
    points.push(
      at(curveM + Math.cos(i * 78.233) * 5, alongM + Math.sin(i * 12.9898) * 5, i * 1000),
    );
  }
  return points;
}

/**
 * Greatest distance from any original point to the simplified polyline, in metres.
 *
 * Deliberately an independent implementation — a plain equirectangular projection and a
 * segment-distance loop — rather than reusing the module's own helper. A test that borrows
 * the code under test cannot catch that code being wrong.
 */
function maxDeviationM(original: readonly TrackPoint[], simplified: readonly TrackPoint[]): number {
  const metresPerDegLat = 111_132;
  const cosLat = Math.cos(ORIGIN.lat * (Math.PI / 180));
  const project = (p: TrackPoint): [number, number] => [
    p.lng * cosLat * metresPerDegLat,
    p.lat * metresPerDegLat,
  ];

  const line = simplified.map(project);
  let worst = 0;

  for (const point of original) {
    const [px, py] = project(point);
    let nearest = Number.POSITIVE_INFINITY;

    for (let i = 0; i < line.length - 1; i += 1) {
      const a = line[i];
      const b = line[i + 1];
      if (a === undefined || b === undefined) continue;
      const [ax, ay] = a;
      const [bx, by] = b;
      const dx = bx - ax;
      const dy = by - ay;
      const lengthSquared = dx * dx + dy * dy;
      const u =
        lengthSquared === 0
          ? 0
          : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
      nearest = Math.min(nearest, Math.hypot(px - (ax + u * dx), py - (ay + u * dy)));
    }

    worst = Math.max(worst, nearest);
  }

  return worst;
}

/** A dead-straight run east — every interior point is redundant. */
function straightLine(count: number): TrackPoint[] {
  return Array.from({ length: count }, (_, i) => at(0, i * 10, i * 1000));
}

describe("endpoints", () => {
  it("always keeps the first and last point", () => {
    const points = straightLine(50);
    const result = simplify(points, 5);
    expect(result[0]).toEqual(points[0]);
    expect(result.at(-1)).toEqual(points.at(-1));
  });

  it("keeps them even at an enormous tolerance", () => {
    const points = straightLine(500);
    const result = simplify(points, 100_000);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(points[0]);
    expect(result[1]).toEqual(points.at(-1));
  });
});

describe("degenerate inputs", () => {
  it("returns an empty array for no points", () => {
    expect(simplify([], 10)).toEqual([]);
  });

  it("returns the single point for a one-point run", () => {
    const points = [at(0, 0, 0)];
    expect(simplify(points, 10)).toEqual(points);
  });

  it("returns both points for a two-point run", () => {
    const points = [at(0, 0, 0), at(0, 500, 1000)];
    expect(simplify(points, 10)).toEqual(points);
  });

  it("handles a run whose points all coincide", () => {
    // The degenerate-span branch: start and end are the same place, so there is no line
    // to be perpendicular to. A stationary recording produces exactly this.
    const points = Array.from({ length: 20 }, (_, i) => at(0, 0, i * 1000));
    const result = simplify(points, 1);
    expect(result).toHaveLength(2);
  });

  it("handles a closed loop returning to its start", () => {
    const points = [
      at(0, 0, 0),
      at(100, 0, 1000),
      at(100, 100, 2000),
      at(0, 100, 3000),
      at(0, 0, 4000),
    ];
    const result = simplify(points, 1);
    expect(result).toHaveLength(5);
    expect(result[0]).toEqual(points[0]);
    expect(result.at(-1)).toEqual(points.at(-1));
  });
});

describe("shape preservation", () => {
  it("collapses a straight line to its endpoints", () => {
    expect(simplify(straightLine(100), 1)).toHaveLength(2);
  });

  it("keeps a corner that carries the shape", () => {
    const points = [
      at(0, 0, 0),
      at(0, 50, 1000),
      at(0, 100, 2000),
      at(100, 100, 3000),
      at(200, 100, 4000),
    ];
    const result = simplify(points, 5);
    // Both collinear runs collapse; the corner at (0,100) must survive.
    expect(result).toHaveLength(3);
    expect(result[1]).toEqual(points[2]);
  });

  it("keeps a deviation above the tolerance and drops one below it", () => {
    const withBump = (bumpM: number): TrackPoint[] => [
      at(0, 0, 0),
      at(bumpM, 50, 1000),
      at(0, 100, 2000),
    ];
    expect(simplify(withBump(20), 10)).toHaveLength(3);
    expect(simplify(withBump(2), 10)).toHaveLength(2);
  });

  it("reduces a representative noisy route by 60-80% [fixture-level signal]", () => {
    // The T1.3 acceptance criterion, and deliberately loose. This is a regression signal
    // about *this fixture*, not a Douglas-Peucker invariant: the ratio is knife-edge
    // against the tolerance — at ±3 m jitter, 4 m gives 61% and 5 m gives 90% — so it says
    // more about where the fixture sits relative to a threshold than about correctness.
    // The correctness proof is the deviation bound below.
    const points = noisyWindingPath();
    const reduction = 1 - simplify(points, 7).length / points.length;
    expect(reduction).toBeGreaterThan(0.6);
    expect(reduction).toBeLessThan(0.8);
  });

  it("keeps every original point within toleranceM of the simplified polyline [the invariant]", () => {
    // What "without visibly changing shape" means, made falsifiable:
    //
    //   max over original points( distance to nearest segment of simplified polyline ) <= tolerance
    //
    // Measured against the whole retained polyline, not just neighbouring vertices, and by
    // an independent implementation — see maxDeviationM.
    const points = noisyWindingPath();
    for (const tolerance of [0.5, 1, 3, 7, 15, 40]) {
      expect(maxDeviationM(points, simplify(points, tolerance))).toBeLessThanOrEqual(tolerance);
    }
  });

  it("holds the deviation bound on a hairpin, where cutting the corner would be tempting", () => {
    const hairpin: TrackPoint[] = [];
    for (let i = 0; i < 60; i += 1) hairpin.push(at(i * 5, 0, i * 1000));
    for (let i = 0; i < 60; i += 1) hairpin.push(at(300 - i * 5, 8, (60 + i) * 1000));

    for (const tolerance of [1, 5, 20]) {
      expect(maxDeviationM(hairpin, simplify(hairpin, tolerance))).toBeLessThanOrEqual(tolerance);
    }
  });

  it("keeps more points as the tolerance tightens", () => {
    const points: TrackPoint[] = [];
    for (let i = 0; i < 200; i += 1) points.push(at(Math.sin(i * 1.3) * 6, i * 5, i * 1000));

    const loose = simplify(points, 20).length;
    const middling = simplify(points, 5).length;
    const tight = simplify(points, 1).length;
    expect(loose).toBeLessThan(middling);
    expect(middling).toBeLessThan(tight);
  });
});

describe("tolerance 0", () => {
  // The contract at zero tolerance is *not* "preserve every point". It is: endpoints
  // survive, any point with nonzero geometric deviation survives, and exactly redundant
  // collinear points may legitimately disappear — their deviation is exactly zero, so
  // dropping them still yields zero-error geometry.

  it("keeps every point that deviates from the line between its neighbours", () => {
    const points: TrackPoint[] = [];
    for (let i = 0; i < 50; i += 1) points.push(at(Math.sin(i) * 5, i * 10, i * 1000));
    expect(simplify(points, 0)).toHaveLength(points.length);
  });

  it("produces zero-error geometry, which is the actual guarantee", () => {
    const points: TrackPoint[] = [];
    for (let i = 0; i < 50; i += 1) points.push(at(Math.sin(i) * 5, i * 10, i * 1000));
    expect(maxDeviationM(points, simplify(points, 0))).toBeCloseTo(0, 6);
  });

  it("may drop an exactly collinear point, and that is not a defect", () => {
    const result = simplify(straightLine(20), 0);
    expect(result.length).toBeLessThanOrEqual(20);
    expect(maxDeviationM(straightLine(20), result)).toBeCloseTo(0, 6);
  });

  it("rejects a negative or non-finite tolerance rather than guessing", () => {
    expect(() => simplify(straightLine(5), -1)).toThrow(RangeError);
    expect(() => simplify(straightLine(5), Number.NaN)).toThrow(RangeError);
    expect(() => simplify(straightLine(5), Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe("payload preservation", () => {
  it("returns points unchanged in value, each matching one of the originals", () => {
    // Value equality, deliberately not object identity. The implementation does return the
    // original objects, but promising that would stop a future version from cloning
    // immutable values, and no consumer has reason to depend on it.
    const points = straightLine(30);
    for (const kept of simplify(points, 5)) {
      expect(points.some((original) => JSON.stringify(original) === JSON.stringify(kept))).toBe(
        true,
      );
    }
  });

  it("carries timestamps, altitude and channels through with their exact values", () => {
    const points: TrackPoint[] = [
      at(0, 0, 0, { altitudeM: 12, channels: { heartRateBpm: 120 }, accuracyM: 4 }),
      at(60, 50, 1000, { altitudeM: 31, channels: { heartRateBpm: 148 }, accuracyM: 6 }),
      at(0, 100, 2000, { altitudeM: 15, channels: { heartRateBpm: 155 }, accuracyM: 5 }),
    ];
    const result = simplify(points, 5);
    expect(result).toHaveLength(3);
    expect(result[1]?.altitudeM).toBe(31);
    expect(result[1]?.channels).toEqual({ heartRateBpm: 148 });
    expect(result[1]?.accuracyM).toBe(6);
    expect(result[1]?.t).toBe(T0 + 1000);
  });

  it("never mutates the input array or its points", () => {
    const points = straightLine(40);
    const snapshot = structuredClone(points);
    const length = points.length;

    simplify(points, 10);

    expect(points).toHaveLength(length);
    expect(points).toEqual(snapshot);
  });

  it("accepts a readonly array", () => {
    const points: readonly TrackPoint[] = Object.freeze(straightLine(10));
    expect(() => simplify(points, 5)).not.toThrow();
  });
});

describe("scale", () => {
  it("handles a long track without overflowing the stack", () => {
    // An all-day recording. Recursion on an unbalanced split would blow up here, which is
    // why the implementation uses an explicit stack.
    const points: TrackPoint[] = [];
    for (let i = 0; i < 50_000; i += 1) points.push(at(Math.sin(i / 500) * 40, i * 2, i * 1000));

    const result = simplify(points, 5);
    expect(result.length).toBeGreaterThan(2);
    expect(result.length).toBeLessThan(points.length);
    expect(result[0]).toEqual(points[0]);
    expect(result.at(-1)).toEqual(points.at(-1));
  });
});

describe("high latitude", () => {
  it("does not distort near the pole, where a degree of longitude is a few hundred metres", () => {
    // Without the cos(latitude) scaling, an east-west wiggle at 80°N would measure ~6x too
    // large and simplification would keep points it should drop.
    const polar = { lat: 80, lng: 25 };
    const points: TrackPoint[] = Array.from({ length: 3 }, (_, i) => ({
      lat: polar.lat,
      // ~10 m apart in real distance, but a large longitude delta at this latitude.
      lng: polar.lng + (i * 10 * DEG_PER_M) / Math.cos(80 * (Math.PI / 180)),
      t: T0 + i * 1000,
    }));

    // All three are collinear along a parallel, so the middle one carries no shape.
    expect(simplify(points, 1)).toHaveLength(2);
  });
});
