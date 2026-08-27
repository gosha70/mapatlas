// SPDX-License-Identifier: Apache-2.0

import type { LatLng } from "./geo.js";
import type { TrackPoint } from "./track.js";

/**
 * Ramer–Douglas–Peucker over **one continuous run of points**.
 *
 * Deliberately generic: it knows nothing about segments, pauses or tracks. `finalizeTrack`
 * is what maps it across `Track.segments` to build `simplifiedSegments`, which is where
 * pause semantics belong. Keeping the algorithm ignorant of them is what stops a future
 * caller from simplifying a concatenated `points[]` and smoothing straight through a gap.
 * (ADR-0010, ADR-0018)
 *
 * Retained points come through unchanged in value — `t`, `altitudeM` and `channels`
 * included — because a decimated line must never silently drop telemetry. The current
 * implementation returns the original objects rather than copies, but that is an
 * optimisation and not a promise: nothing should depend on reference identity.
 */

/** Metres per degree of latitude, near enough for a local tangent-plane projection. */
const METRES_PER_DEGREE_LAT = 111_195;

const DEGREES_TO_RADIANS = Math.PI / 180;

/**
 * Perpendicular distance from `point` to the segment `start`→`end`, in metres.
 *
 * Works on a local tangent plane rather than the sphere: over the span of a single track
 * the curvature error is far below the tolerances anyone simplifies at, and the alternative
 * — cross-track distance on a great circle — costs trigonometry per candidate in the hot
 * loop of an O(n log n) recursion. Longitude is scaled by cos(latitude) so the plane stays
 * locally equal-area; without that, simplification would be visibly wrong at high latitude.
 */
function perpendicularDistanceM(point: LatLng, start: LatLng, end: LatLng): number {
  const cosLat = Math.cos(((start.lat + end.lat) / 2) * DEGREES_TO_RADIANS);
  const toX = (p: LatLng): number => p.lng * cosLat * METRES_PER_DEGREE_LAT;
  const toY = (p: LatLng): number => p.lat * METRES_PER_DEGREE_LAT;

  const px = toX(point);
  const py = toY(point);
  const ax = toX(start);
  const ay = toY(start);
  const bx = toX(end);
  const by = toY(end);

  const dx = bx - ax;
  const dy = by - ay;

  // Degenerate span — start and end coincide, so "perpendicular" is just the distance to
  // the point they share. A closed loop hits this on its very first recursion.
  if (dx === 0 && dy === 0) {
    return Math.hypot(px - ax, py - ay);
  }

  const lengthSquared = dx * dx + dy * dy;
  const projection = ((px - ax) * dx + (py - ay) * dy) / lengthSquared;
  const clamped = Math.max(0, Math.min(1, projection));

  return Math.hypot(px - (ax + clamped * dx), py - (ay + clamped * dy));
}

/**
 * Reduce a run of points to those that carry its shape, within `toleranceM`.
 *
 * The first and last points always survive, and every point that is dropped is guaranteed
 * to lie within `toleranceM` of the returned polyline. The input array is never mutated.
 *
 * At a tolerance of `0` the guarantee becomes zero-error geometry: every point with any
 * deviation from the line between its neighbours survives, while an exactly collinear point
 * may be dropped — its deviation is precisely zero, so removing it changes nothing. Zero is
 * therefore not a promise to preserve every point.
 */
export function simplify(points: readonly TrackPoint[], toleranceM: number): TrackPoint[] {
  if (!Number.isFinite(toleranceM) || toleranceM < 0) {
    throw new RangeError(`tolerance must be a non-negative number of metres: ${toleranceM}`);
  }

  // Nothing to decide: a run of two or fewer points is already only its endpoints.
  if (points.length <= 2) return [...points];

  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;

  // Explicit stack rather than recursion: a long track can be tens of thousands of points,
  // and the recursion depth of an unbalanced split would overflow.
  const stack: [number, number][] = [[0, points.length - 1]];

  while (stack.length > 0) {
    const span = stack.pop();
    if (span === undefined) break;
    const [first, last] = span;
    if (last <= first + 1) continue;

    const start = points[first];
    const end = points[last];
    if (start === undefined || end === undefined) continue;

    let furthest = -1;
    let furthestDistance = 0;

    for (let i = first + 1; i < last; i += 1) {
      const candidate = points[i];
      if (candidate === undefined) continue;
      const distance = perpendicularDistanceM(candidate, start, end);
      if (distance > furthestDistance) {
        furthestDistance = distance;
        furthest = i;
      }
    }

    if (furthest !== -1 && furthestDistance > toleranceM) {
      keep[furthest] = 1;
      stack.push([first, furthest], [furthest, last]);
    }
  }

  const out: TrackPoint[] = [];
  for (let i = 0; i < points.length; i += 1) {
    const point = points[i];
    if (keep[i] === 1 && point !== undefined) out.push(point);
  }
  return out;
}
