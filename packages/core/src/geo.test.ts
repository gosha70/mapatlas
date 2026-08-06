// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { haversineMeters, pathLengthMeters } from "./geo";

describe("haversineMeters", () => {
  it("is zero for identical points", () => {
    expect(haversineMeters({ lat: 40, lng: -70 }, { lat: 40, lng: -70 })).toBe(
      0,
    );
  });

  it("matches a known distance (London → Paris ≈ 343.5 km)", () => {
    const london = { lat: 51.5074, lng: -0.1278 };
    const paris = { lat: 48.8566, lng: 2.3522 };
    const d = haversineMeters(london, paris);
    expect(d).toBeGreaterThan(342_000);
    expect(d).toBeLessThan(345_000);
  });

  it("approximates 1° of latitude as ≈ 111 km", () => {
    const d = haversineMeters({ lat: 0, lng: 0 }, { lat: 1, lng: 0 });
    expect(d).toBeGreaterThan(110_000);
    expect(d).toBeLessThan(112_000);
  });
});

describe("pathLengthMeters", () => {
  it("is zero for fewer than two points", () => {
    expect(pathLengthMeters([])).toBe(0);
    expect(pathLengthMeters([{ lat: 1, lng: 1 }])).toBe(0);
  });

  it("sums consecutive segments", () => {
    const a = { lat: 0, lng: 0 };
    const b = { lat: 0, lng: 1 };
    const c = { lat: 0, lng: 2 };
    const expected = haversineMeters(a, b) + haversineMeters(b, c);
    expect(pathLengthMeters([a, b, c])).toBeCloseTo(expected, 6);
  });
});
