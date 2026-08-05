// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { haversineM, polylineLengthM } from "./geo.js";

describe("haversineM", () => {
  it("is zero for identical points", () => {
    expect(haversineM({ lat: 10, lng: 20 }, { lat: 10, lng: 20 })).toBe(0);
  });

  it("matches one degree of longitude at the equator (~111.2 km)", () => {
    const d = haversineM({ lat: 0, lng: 0 }, { lat: 0, lng: 1 });
    expect(d).toBeCloseTo(111_195, -1); // within ~10 m
  });

  it("is symmetric", () => {
    const a = { lat: 51.5, lng: -0.12 };
    const b = { lat: 48.85, lng: 2.35 };
    expect(haversineM(a, b)).toBeCloseTo(haversineM(b, a), 6);
  });
});

describe("polylineLengthM", () => {
  it("sums segment lengths", () => {
    const pts = [
      { lat: 0, lng: 0 },
      { lat: 0, lng: 1 },
      { lat: 0, lng: 2 },
    ];
    expect(polylineLengthM(pts)).toBeCloseTo(2 * 111_195, -1);
  });

  it("is zero for a single point or empty", () => {
    expect(polylineLengthM([{ lat: 1, lng: 1 }])).toBe(0);
    expect(polylineLengthM([])).toBe(0);
  });
});
