// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import type { TrackPoint } from "./types.js";
import { simplify } from "./simplify.js";

/** Deterministic small pseudo-random generator (LCG) for reproducible noise. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff; // [0, 1)
  };
}

/**
 * Build a noisy fixture: a meandering path of "real" vertices with several
 * near-collinear, slightly-noisy interpolated points between each pair. The
 * interpolated noise stays well under the simplification tolerance, so DP
 * should drop the fillers and keep (roughly) the real vertices.
 */
function noisyFixture(): { points: TrackPoint[]; realVertices: number } {
  const rand = lcg(42);
  const realVertices = 30;
  const interpPerSegment = 2;
  const real: TrackPoint[] = [];
  for (let i = 0; i < realVertices; i++) {
    real.push({
      lat: 0.01 * Math.sin(i * 0.9), // ~1.1 km amplitude meander
      lng: 0.002 * i,
      t: i * 1000,
    });
  }

  const points: TrackPoint[] = [];
  for (let i = 0; i < real.length - 1; i++) {
    const a = real[i]!;
    const b = real[i + 1]!;
    points.push(a);
    for (let k = 1; k <= interpPerSegment; k++) {
      const f = k / (interpPerSegment + 1);
      // ~±0.00002 deg ≈ ±2 m of noise, far below a 10 m tolerance.
      const noise = (rand() - 0.5) * 0.00004;
      points.push({
        lat: a.lat + (b.lat - a.lat) * f + noise,
        lng: a.lng + (b.lng - a.lng) * f + noise,
        t: a.t + (b.t - a.t) * f,
      });
    }
  }
  points.push(real[real.length - 1]!);
  return { points, realVertices };
}

describe("simplify", () => {
  it("returns input unchanged for 0, 1, or 2 points", () => {
    expect(simplify([], 10)).toEqual([]);
    const one = [{ lat: 1, lng: 1, t: 0 }];
    expect(simplify(one, 10)).toEqual(one);
    const two = [
      { lat: 1, lng: 1, t: 0 },
      { lat: 2, lng: 2, t: 1 },
    ];
    expect(simplify(two, 10)).toEqual(two);
  });

  it("reduces a noisy fixture 60–80% without changing its shape", () => {
    const { points } = noisyFixture();
    const out = simplify(points, 10);

    const reduction = 1 - out.length / points.length;
    expect(reduction).toBeGreaterThanOrEqual(0.6);
    expect(reduction).toBeLessThanOrEqual(0.8);

    // Endpoints preserved exactly.
    expect(out[0]).toEqual(points[0]);
    expect(out[out.length - 1]).toEqual(points[points.length - 1]);

    // Output is an ordered subsequence of the input (shape, not resampling).
    let j = 0;
    for (const p of out) {
      while (j < points.length && points[j] !== p) j++;
      expect(j).toBeLessThan(points.length);
      j++;
    }
  });

  it("keeps every point when tolerance is zero", () => {
    const { points } = noisyFixture();
    expect(simplify(points, 0)).toEqual(points);
  });

  it("collapses a straight, densely-sampled line to its endpoints", () => {
    const line: TrackPoint[] = [];
    for (let i = 0; i <= 20; i++) line.push({ lat: 0, lng: i * 0.001, t: i });
    const out = simplify(line, 10);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual(line[0]);
    expect(out[1]).toEqual(line[line.length - 1]);
  });
});
