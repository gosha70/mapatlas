// SPDX-License-Identifier: Apache-2.0
import type { LatLng, TrackPoint } from "./types";

const DEG_TO_RAD = Math.PI / 180;
const M_PER_DEG_LAT = 111320;

interface XY {
  x: number;
  y: number;
}

/** Local equirectangular projection to metres, relative to an origin. */
function project(origin: LatLng, p: LatLng): XY {
  const mPerDegLng = M_PER_DEG_LAT * Math.cos(origin.lat * DEG_TO_RAD);
  return {
    x: (p.lng - origin.lng) * mPerDegLng,
    y: (p.lat - origin.lat) * M_PER_DEG_LAT,
  };
}

/** Perpendicular distance (metres) from point `p` to the infinite line a–b. */
function perpendicularDistanceM(p: LatLng, a: LatLng, b: LatLng): number {
  const pa = project(a, p);
  const ba = project(a, b);
  const segLen2 = ba.x * ba.x + ba.y * ba.y;
  if (segLen2 === 0) {
    return Math.hypot(pa.x, pa.y);
  }
  const cross = pa.x * ba.y - pa.y * ba.x;
  return Math.abs(cross) / Math.sqrt(segLen2);
}

/**
 * Douglas–Peucker line simplification. Keeps the first and last points and any
 * point whose perpendicular distance from the retained line exceeds
 * `toleranceM`; drops the rest. Original point objects (with their timestamps
 * and per-fix metadata) are preserved by reference.
 */
export function simplify(
  points: TrackPoint[],
  toleranceM: number,
): TrackPoint[] {
  const n = points.length;
  if (n <= 2 || toleranceM <= 0) {
    return points.slice();
  }

  const keep = new Array<boolean>(n).fill(false);
  keep[0] = true;
  keep[n - 1] = true;

  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length > 0) {
    const range = stack.pop();
    if (!range) break;
    const [start, end] = range;
    const a = points[start];
    const b = points[end];
    if (!a || !b) continue;

    let maxDist = 0;
    let idx = -1;
    for (let i = start + 1; i < end; i++) {
      const p = points[i];
      if (!p) continue;
      const d = perpendicularDistanceM(p, a, b);
      if (d > maxDist) {
        maxDist = d;
        idx = i;
      }
    }

    if (maxDist > toleranceM && idx !== -1) {
      keep[idx] = true;
      stack.push([start, idx], [idx, end]);
    }
  }

  const out: TrackPoint[] = [];
  for (let i = 0; i < n; i++) {
    if (keep[i]) {
      const p = points[i];
      if (p) out.push(p);
    }
  }
  return out;
}
