// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { simplify } from "./simplify";
import type { TrackPoint } from "./types";

const DEG_TO_RAD = Math.PI / 180;
const M_PER_DEG_LAT = 111320;

/** A deterministic ~80-point track: a gentle curve with a few metres of jitter. */
function noisyFixture(): TrackPoint[] {
  const pts: TrackPoint[] = [];
  for (let i = 0; i <= 80; i++) {
    const lng = i * 0.0002;
    const base = 0.0004 * Math.sin(i * 0.15);
    const jitter = 0.00003 * Math.sin(i * 2.7) + 0.00002 * Math.cos(i * 5.1);
    pts.push({ lat: base + jitter, lng, t: i * 1000 });
  }
  return pts;
}

/** Clamped point→segment distance in metres, via local projection. */
function segDistM(p: TrackPoint, a: TrackPoint, b: TrackPoint): number {
  const m = M_PER_DEG_LAT * Math.cos(a.lat * DEG_TO_RAD);
  const px = (p.lng - a.lng) * m;
  const py = (p.lat - a.lat) * M_PER_DEG_LAT;
  const bx = (b.lng - a.lng) * m;
  const by = (b.lat - a.lat) * M_PER_DEG_LAT;
  const len2 = bx * bx + by * by;
  const t =
    len2 === 0 ? 0 : Math.max(0, Math.min(1, (px * bx + py * by) / len2));
  return Math.hypot(px - bx * t, py - by * t);
}

function maxDeviationM(original: TrackPoint[], line: TrackPoint[]): number {
  let worst = 0;
  for (const p of original) {
    let best = Infinity;
    for (let i = 1; i < line.length; i++) {
      best = Math.min(best, segDistM(p, line[i - 1]!, line[i]!));
    }
    worst = Math.max(worst, best);
  }
  return worst;
}

describe("simplify", () => {
  const tolerance = 5;
  const fixture = noisyFixture();
  const result = simplify(fixture, tolerance);

  it("reduces the point count 60–80%", () => {
    const reduction = 1 - result.length / fixture.length;
    expect(reduction).toBeGreaterThanOrEqual(0.6);
    expect(reduction).toBeLessThanOrEqual(0.8);
  });

  it("preserves the endpoints by reference", () => {
    expect(result[0]).toBe(fixture[0]);
    expect(result.at(-1)).toBe(fixture.at(-1));
  });

  it("does not visibly change the shape (all points within tolerance)", () => {
    expect(maxDeviationM(fixture, result)).toBeLessThanOrEqual(tolerance);
  });

  it("returns a copy for two-or-fewer points", () => {
    const two: TrackPoint[] = [
      { lat: 0, lng: 0, t: 0 },
      { lat: 1, lng: 1, t: 1 },
    ];
    const out = simplify(two, tolerance);
    expect(out).toEqual(two);
    expect(out).not.toBe(two);
  });

  it("does not simplify with a non-positive tolerance", () => {
    expect(simplify(fixture, 0)).toHaveLength(fixture.length);
  });

  it("handles a degenerate segment whose endpoints coincide", () => {
    // Start and end are identical, so the recursion measures distance to a
    // point rather than a line; the off-line middle point must be retained.
    const loop: TrackPoint[] = [
      { lat: 0, lng: 0, t: 0 },
      { lat: 0.001, lng: 0, t: 1 },
      { lat: 0, lng: 0, t: 2 },
    ];
    const out = simplify(loop, 1);
    expect(out).toHaveLength(3);
  });
});
