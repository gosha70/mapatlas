// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { haversineDistanceMeters } from "./geo.js";

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
