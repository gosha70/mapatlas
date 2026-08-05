// SPDX-License-Identifier: Apache-2.0

import type { TrackPoint } from "./types.js";
import { projectMeters } from "./geo.js";

/** Perpendicular distance (meters) from point `p` to segment `a`–`b`. */
function perpDistanceM(
  p: TrackPoint,
  a: TrackPoint,
  b: TrackPoint,
  refLat: number,
): number {
  const pp = projectMeters(p, refLat);
  const pa = projectMeters(a, refLat);
  const pb = projectMeters(b, refLat);

  const dx = pb.x - pa.x;
  const dy = pb.y - pa.y;
  const segLenSq = dx * dx + dy * dy;

  if (segLenSq === 0) {
    // Degenerate segment: distance to the coincident endpoint.
    const ex = pp.x - pa.x;
    const ey = pp.y - pa.y;
    return Math.hypot(ex, ey);
  }

  // Projection factor of p onto the segment, clamped to [0, 1].
  let t = ((pp.x - pa.x) * dx + (pp.y - pa.y) * dy) / segLenSq;
  t = Math.max(0, Math.min(1, t));

  const cx = pa.x + t * dx;
  const cy = pa.y + t * dy;
  return Math.hypot(pp.x - cx, pp.y - cy);
}

/**
 * Douglas–Peucker polyline simplification (api.md §1/§8, tasks T1.3).
 *
 * Reduces the number of points while preserving overall shape; the first and
 * last points are always kept. Distances are computed in meters via a local
 * equirectangular projection, so `toleranceM` is a real-world tolerance.
 *
 * Original `TrackPoint` objects (with their timestamps/accuracy) are preserved
 * for the kept vertices.
 */
export function simplify(
  points: readonly TrackPoint[],
  toleranceM: number,
): TrackPoint[] {
  if (points.length <= 2) return points.slice();
  if (toleranceM <= 0) return points.slice();

  const refLat = points.reduce((sum, p) => sum + p.lat, 0) / points.length;

  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;

  // Iterative DP to avoid deep recursion on long tracks.
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [start, end] = stack.pop()!;
    if (end - start < 2) continue;

    let maxDist = -1;
    let maxIndex = -1;
    const a = points[start]!;
    const b = points[end]!;
    for (let i = start + 1; i < end; i++) {
      const d = perpDistanceM(points[i]!, a, b, refLat);
      if (d > maxDist) {
        maxDist = d;
        maxIndex = i;
      }
    }

    if (maxDist > toleranceM && maxIndex !== -1) {
      keep[maxIndex] = true;
      stack.push([start, maxIndex]);
      stack.push([maxIndex, end]);
    }
  }

  const out: TrackPoint[] = [];
  for (let i = 0; i < points.length; i++) {
    if (keep[i]) out.push(points[i]!);
  }
  return out;
}
