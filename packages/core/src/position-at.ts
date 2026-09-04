// SPDX-License-Identifier: Apache-2.0

import type { LatLng } from "./geo.js";
import type { Track, TrackPoint, TrackSegment } from "./track.js";

/**
 * Where the track was at a moment — a pure projection over its own geometry (ADR-0032).
 *
 * **In core, not in the replay component.** "Do not invent travel through a pause" is already a
 * cross-surface rule: the rendered line refuses it, the channel charts refuse it (ADR-0031), and
 * replay must too. A third implementation inside React is the drift a single shared
 * `computeStats` exists to prevent, and a consumer building their own replay would have no way
 * to match the engine's semantics. There is no renderer, clock or playback state here.
 *
 * **Assumes canonical geometry has already been validated**, exactly as `computeStats` does. It
 * is called once per cursor tick during replay; re-validating there would put the cost in the
 * hot path and split an ownership that belongs to `finalizeTrack` alone.
 */
export function positionAt(
  track: Pick<Track, "points" | "segments">,
  t: number,
): LatLng | undefined {
  if (!Number.isFinite(t)) {
    throw new RangeError(`positionAt: t must be finite, received ${String(t)}`);
  }
  const { points, segments } = track;
  const first = points[0];
  const last = points[points.length - 1];
  if (first === undefined || last === undefined) return undefined;
  // Outside the trip there is no truthful answer, so none is invented. Clamping would report a
  // position the track never claims to have observed at that time.
  if (t < first.t || t > last.t) return undefined;

  // Later segments first: at a boundary instant the next segment has begun, so it owns `t` —
  // including when the previous one ended at exactly the same millisecond, where it is the
  // current observation. Scanning backwards makes that the natural first match rather than a
  // special case.
  for (let s = segments.length - 1; s >= 0; s -= 1) {
    const segment = segments[s];
    if (segment === undefined) continue;
    const startPoint = points[segment.startIndex];
    if (startPoint === undefined) continue;
    if (t >= startPoint.t) {
      // No `t <= endPoint.t` branch here: `within` already refuses to look past its segment's
      // last sample, so a `t` in the pause after this segment resolves to that sample either
      // way. Two guards enforcing one rule meant a mutation deleting this one survived — the
      // rule now has a single home, and the mutation that matters is against `within`.
      return within(points, segment, t);
    }
  }
  return undefined;
}

/**
 * The position inside one segment, interpolated only between the two samples bracketing `t`.
 *
 * Linear in lat/lng, which is the piecewise geometry the track itself supplies. A geodesic path
 * introduced for animation would be a second opinion about where the trip went, and if the
 * antimeridian ever becomes a real requirement it changes here, once.
 */
function within(points: readonly TrackPoint[], segment: TrackSegment, t: number): LatLng {
  // The *last* sample at or before `t`: adjacent samples may share a timestamp, and at that
  // instant the later one is the current observation — which also keeps the interval below
  // non-zero, so there is no division by zero to guard against separately.
  let index = segment.startIndex;
  for (let i = segment.startIndex; i <= segment.endIndex; i += 1) {
    const point = points[i];
    if (point === undefined) continue;
    if (point.t <= t) index = i;
  }
  const at = points[index];
  const next = points[index + 1];
  if (at === undefined) throw new RangeError("positionAt: segment range escapes the point array");
  if (at.t === t || next === undefined || index >= segment.endIndex) {
    return { lat: at.lat, lng: at.lng };
  }
  // No zero-span guard, and its absence is load-bearing rather than an omission. `index` is the
  // *last* sample at or before `t`, so `next.t > t >= at.t` and the span is positive by
  // construction — a guard here would be unfalsifiable, and a mutation deleting one survived.
  // The duplicate-timestamp rule is enforced where it actually lives: in that index selection.
  const span = next.t - at.t;
  const ratio = (t - at.t) / span;
  return {
    lat: at.lat + (next.lat - at.lat) * ratio,
    lng: at.lng + (next.lng - at.lng) * ratio,
  };
}
