// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import type { LatLng } from "./geo.js";

import { geodesicDistanceMeters, haversineDistanceMeters } from "./geo.js";

describe("haversineDistanceMeters", () => {
  it("is zero for the same position", () => {
    expect(haversineDistanceMeters({ lat: 59.33, lng: 18.06 }, { lat: 59.33, lng: 18.06 })).toBe(0);
  });

  it("treats every meridian degree as equal — a sphere has no flattening", () => {
    // This asserts the model, not the planet. On WGS84 a degree of latitude runs from
    // 110.57 km at the equator to 111.69 km at the pole; on our sphere it is 111.195 km
    // everywhere. That difference is the approximation we accepted, bounded below.
    expect(haversineDistanceMeters({ lat: 0, lng: 0 }, { lat: 1, lng: 0 })).toBeCloseTo(
      111_195,
      -2,
    );
    expect(haversineDistanceMeters({ lat: 70, lng: 25 }, { lat: 71, lng: 25 })).toBeCloseTo(
      111_195,
      -2,
    );
  });

  it("shrinks a degree of longitude with latitude — the reason a flat approximation fails", () => {
    const atEquator = haversineDistanceMeters({ lat: 0, lng: 0 }, { lat: 0, lng: 1 });
    const atSixty = haversineDistanceMeters({ lat: 60, lng: 0 }, { lat: 60, lng: 1 });
    expect(atEquator).toBeCloseTo(111_195, -2);
    expect(atSixty / atEquator).toBeCloseTo(Math.cos((60 * Math.PI) / 180), 3);
  });

  it("stays inside the documented ~0.5% of the true ellipsoidal distance", () => {
    // Ground truth computed with Vincenty's inverse method on WGS84, not recalled from
    // memory: Stockholm to London is 1436.491 km. Haversine on a sphere gives 1432.78 km,
    // 0.26% short. The doc comment promises ~0.5%; this holds it to that promise, and
    // fails if anyone changes the radius or the formula for the worse.
    const stockholm = { lat: 59.3293, lng: 18.0686 };
    const london = { lat: 51.5074, lng: -0.1278 };
    const ELLIPSOIDAL_M = 1_436_491;

    const computed = haversineDistanceMeters(stockholm, london);
    expect(Math.abs(computed - ELLIPSOIDAL_M) / ELLIPSOIDAL_M).toBeLessThan(0.005);
  });

  it("keeps a short field-scale leg well inside a metre of the ellipsoid", () => {
    // What the engine actually measures: consecutive kept points, tens of metres apart.
    // Vincenty puts this leg at 111.24 m; the systematic error at track scale is what
    // matters for a distance total, not the long-haul case.
    const a = { lat: 59.3293, lng: 18.0686 };
    const b = { lat: 59.3303, lng: 18.0686 };
    expect(haversineDistanceMeters(a, b)).toBeCloseTo(111.2, 0);
  });

  it("is symmetric", () => {
    const a = { lat: 12.34, lng: -56.78 };
    const b = { lat: -43.21, lng: 87.65 };
    expect(haversineDistanceMeters(a, b)).toBeCloseTo(haversineDistanceMeters(b, a), 6);
  });

  it("handles antipodes without NaN — the clamp inside asin earning its keep", () => {
    const d = haversineDistanceMeters({ lat: 0, lng: 0 }, { lat: 0, lng: 180 });
    expect(Number.isFinite(d)).toBe(true);
    expect(d / 1000).toBeCloseTo(20_015, 0);
  });

  it("crosses the antimeridian by the short way, not the long way", () => {
    const west = { lat: 0, lng: 179.9 };
    const east = { lat: 0, lng: -179.9 };
    // 0.2° apart across the line, not 359.8° around the globe. (Vincenty: 22 263.9 m.)
    expect(haversineDistanceMeters(west, east)).toBeCloseTo(22_239, -2);
  });

  it("survives sub-metre differences without cancellation error", () => {
    const a = { lat: 59.3293, lng: 18.0686 };
    const b = { lat: 59.3293, lng: 18.068_618 };
    const d = haversineDistanceMeters(a, b);
    expect(d).toBeGreaterThan(0.5);
    expect(d).toBeLessThan(2);
  });
});

describe("geodesicDistanceMeters (Vincenty on WGS84)", () => {
  /**
   * Ground truth computed independently of Vincenty: the meridian arcs by Simpson
   * integration of the meridional radius of curvature over the ellipse, and the equatorial
   * arcs in closed form, since the equator is a circle of radius `a`. Neither uses an
   * auxiliary sphere or an iteration, so agreement here is evidence the implementation is
   * right rather than evidence it agrees with itself.
   *
   * The 10 001 965.729 m quarter-meridian also matches the published WGS84 constant, which
   * is the cross-check on the integration.
   */
  const REFERENCE: [name: string, from: LatLng, to: LatLng, metres: number][] = [
    ["equator to pole along a meridian", { lat: 0, lng: 0 }, { lat: 90, lng: 0 }, 10_001_965.7293],
    ["one degree of latitude at the equator", { lat: 0, lng: 0 }, { lat: 1, lng: 0 }, 110_574.3886],
    ["equator to 60°N", { lat: 0, lng: 0 }, { lat: 60, lng: 0 }, 6_654_072.8195],
    [
      "one degree of longitude at the equator",
      { lat: 0, lng: 0 },
      { lat: 0, lng: 1 },
      111_319.4908,
    ],
    ["a quarter of the equator", { lat: 0, lng: 0 }, { lat: 0, lng: 90 }, 10_018_754.1714],
  ];

  it.each(REFERENCE)("matches ground truth for %s", (_name, from, to, metres) => {
    expect(Math.abs(geodesicDistanceMeters(from, to) - metres)).toBeLessThan(0.001);
  });

  it("is the ellipsoidal answer the sphere was missing", () => {
    // The pair that exposed the difference: haversine reads 1432.780 km, ground truth is
    // 1436.491 km. This is why stats.distanceM does not come from haversine. (ADR-0019)
    const stockholm = { lat: 59.3293, lng: 18.0686 };
    const london = { lat: 51.5074, lng: -0.1278 };
    expect(geodesicDistanceMeters(stockholm, london) / 1000).toBeCloseTo(1436.491, 3);
    expect(haversineDistanceMeters(stockholm, london) / 1000).toBeCloseTo(1432.78, 2);
  });

  it("returns exactly zero for identical positions", () => {
    expect(geodesicDistanceMeters({ lat: 59.33, lng: 18.06 }, { lat: 59.33, lng: 18.06 })).toBe(0);
    expect(geodesicDistanceMeters({ lat: 0, lng: 0 }, { lat: 0, lng: 0 })).toBe(0);
  });

  it("is symmetric", () => {
    const a = { lat: 12.34, lng: -56.78 };
    const b = { lat: -43.21, lng: 87.65 };
    expect(geodesicDistanceMeters(a, b)).toBeCloseTo(geodesicDistanceMeters(b, a), 6);
  });

  it("beats haversine at track scale, where the engine actually measures", () => {
    // A single leg between kept points. The absolute error is small, but it is systematic:
    // every leg of every track leans the same way, which is what makes it compound.
    const a = { lat: 59.3293, lng: 18.0686 };
    const b = { lat: 59.3303, lng: 18.0696 };
    const geodesic = geodesicDistanceMeters(a, b);
    const spherical = haversineDistanceMeters(a, b);
    expect(geodesic).toBeGreaterThan(spherical);
    expect((geodesic - spherical) / geodesic).toBeLessThan(0.01);
  });

  describe("non-convergence fallback", () => {
    // Vincenty's known weakness. None of these can occur between adjacent points of a
    // track, but the function must stay total regardless of what a consumer hands it.
    const ANTIPODAL: [string, LatLng, LatLng][] = [
      ["exact antipodes on the equator", { lat: 0, lng: 0 }, { lat: 0, lng: 180 }],
      ["near-antipodal", { lat: 0, lng: 0 }, { lat: 0.5, lng: 179.7 }],
      ["near-antipodal at mid latitude", { lat: 30, lng: 0 }, { lat: -30.1, lng: 179.9 }],
    ];

    it.each(ANTIPODAL)("falls back to the sphere rather than returning NaN: %s", (_n, a, b) => {
      const result = geodesicDistanceMeters(a, b);
      expect(Number.isFinite(result)).toBe(true);
      // Proof the fallback fired, not merely that the answer looks plausible.
      expect(result).toBe(haversineDistanceMeters(a, b));
    });

    it("still converges just short of antipodal, so the fallback is not over-eager", () => {
      const a = { lat: 0, lng: 0 };
      const b = { lat: 0.0001, lng: 180 };
      expect(geodesicDistanceMeters(a, b)).not.toBe(haversineDistanceMeters(a, b));
    });
  });

  it("handles the antimeridian by the short way", () => {
    const west = { lat: 0, lng: 179.9 };
    const east = { lat: 0, lng: -179.9 };
    expect(geodesicDistanceMeters(west, east)).toBeCloseTo(22_263.9, 0);
  });

  it("handles high latitude, where a degree of longitude is a few hundred metres", () => {
    const a = { lat: 89.9, lng: 0 };
    const b = { lat: 89.9, lng: 1 };
    const distance = geodesicDistanceMeters(a, b);
    expect(distance).toBeGreaterThan(190);
    expect(distance).toBeLessThan(200);
  });
});
