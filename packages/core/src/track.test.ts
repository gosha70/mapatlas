// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import type { TrackPoint } from "./types.js";
import { finalizeTrack } from "./track.js";

describe("finalizeTrack", () => {
  it("computes haversine distance within tolerance of a known fixture", () => {
    // Two 1° longitude hops at the equator ≈ 2 × 111.195 km.
    const points: TrackPoint[] = [
      { lat: 0, lng: 0, t: 0 },
      { lat: 0, lng: 1, t: 1000 },
      { lat: 0, lng: 2, t: 2000 },
    ];
    const { distanceM } = finalizeTrack(points);
    const expected = 2 * 111_195;
    expect(Math.abs(distanceM - expected)).toBeLessThan(50); // < 50 m error
  });

  it("populates a simplified polyline preserving endpoints", () => {
    const points: TrackPoint[] = [];
    for (let i = 0; i <= 30; i++) {
      points.push({ lat: 0.0001 * i, lng: 0.001 * i, t: i });
    }
    const { simplified } = finalizeTrack(points, 10);
    expect(simplified.length).toBeLessThanOrEqual(points.length);
    expect(simplified[0]).toEqual(points[0]);
    expect(simplified[simplified.length - 1]).toEqual(
      points[points.length - 1],
    );
  });

  it("returns zero distance for a single point", () => {
    const { distanceM, simplified } = finalizeTrack([{ lat: 1, lng: 1, t: 0 }]);
    expect(distanceM).toBe(0);
    expect(simplified).toHaveLength(1);
  });
});
