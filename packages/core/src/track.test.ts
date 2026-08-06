// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { finalizeTrack, DEFAULT_SIMPLIFY_TOLERANCE_M } from "./track";
import { haversineMeters } from "./geo";
import type { TrackPoint } from "./types";

/**
 * A straight ~1 km eastward leg at the equator, densely sampled with a couple
 * of metres of perpendicular jitter. The true travelled distance is the
 * great-circle distance between the endpoints.
 */
function straightLeg(): { points: TrackPoint[]; trueDistanceM: number } {
  const points: TrackPoint[] = [];
  for (let i = 0; i <= 100; i++) {
    const lng = i * 0.0001; // ~11 m per step
    const jitter = 0.00002 * Math.sin(i * 1.3); // ~2 m of noise
    points.push({ lat: jitter, lng, t: i * 1000 });
  }
  const first = points[0]!;
  const last = points.at(-1)!;
  return { points, trueDistanceM: haversineMeters(first, last) };
}

describe("finalizeTrack", () => {
  it("returns simplified geometry and a distance within tolerance of a fixture", () => {
    const { points, trueDistanceM } = straightLeg();
    const { simplified, distanceM } = finalizeTrack(points);

    // Simplification collapses the jittered straight leg toward its endpoints.
    expect(simplified.length).toBeLessThan(points.length);
    expect(simplified[0]).toBe(points[0]);
    expect(simplified.at(-1)).toBe(points.at(-1));

    // Distance is within 1% of the true endpoint-to-endpoint distance.
    expect(Math.abs(distanceM - trueDistanceM)).toBeLessThan(
      trueDistanceM * 0.01,
    );
  });

  it("honours a custom tolerance", () => {
    const { points } = straightLeg();
    const coarse = finalizeTrack(points, 50);
    const fine = finalizeTrack(points, 0.1);
    expect(coarse.simplified.length).toBeLessThanOrEqual(
      fine.simplified.length,
    );
  });

  it("exposes the default tolerance", () => {
    expect(DEFAULT_SIMPLIFY_TOLERANCE_M).toBe(5);
  });

  it("handles a single point", () => {
    const one: TrackPoint[] = [{ lat: 1, lng: 1, t: 0 }];
    const { simplified, distanceM } = finalizeTrack(one);
    expect(simplified).toHaveLength(1);
    expect(distanceM).toBe(0);
  });
});
