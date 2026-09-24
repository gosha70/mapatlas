// SPDX-License-Identifier: Apache-2.0

/**
 * The vertical fixture's recorded track (T4.6), and the views the renderer proofs take of it.
 *
 * Generated from a seed rather than checked in, so every consumer reads the *same* track without
 * a large JSON artifact in the repository — and so a reviewer can see what it is instead of
 * scrolling past five thousand coordinates. It was `/lab`'s recording until T8.3 retired that
 * route; now it is the harness's data, generated in Node and handed to the browser, so only one
 * runtime ever generates it.
 *
 * **Determinism is Node-to-Node.** The same seed gives the same track in one runtime; the
 * coordinate walk uses `atan2`, `cos`, `sin` and `hypot` and accumulates floating-point
 * positions, none of which is required to agree bit-for-bit across engines. The seeded generator
 * itself is integer arithmetic, which is why `Math.random` is unusable here. Cross-runtime
 * identity is not claimed and, with a single generating runtime, no longer needed.
 *
 * **It is finalised by the engine.** `generateFixtureTrack` hands raw points and segments to
 * `finalizeTrack`, so `stats` and `simplifiedSegments` are the engine's own output and the
 * geometry has passed `assertValidTrackGeometry`. A hand-assembled object would happily carry
 * shapes the engine rejects, and the fixture would then be testing itself.
 */

import { finalizeTrack, type Track, type TrackPoint } from "@mapatlas/core";

/**
 * The declared region the terrain and contour archives cover. The track stays inside it.
 *
 * A copy of `fixtures/vertical/region.json`, because a browser bundle cannot read the file — so
 * the Node suite loads that JSON and asserts this constant still matches it. Without that, the
 * generator and its own containment check would share this copy and drift together: both would
 * agree the track was inside a region the archives no longer cover, and it would render over
 * blank tiles with every test green.
 */
export const FIXTURE_REGION = Object.freeze({
  west: 6.825,
  south: 45.815,
  east: 6.905,
  north: 45.865,
});

/**
 * The walk's pace and sampling rate.
 *
 * Two seconds rather than one: at 1.4 m/s a one-second fix moves 1.4 m, and 5,400 of them cover
 * 7.5 km — a quarter of the region's width, which left three of its four edges untouched and the
 * containment check with nothing to observe. Two-second sampling is ordinary for a GPS logger
 * and covers 15 km, enough to traverse.
 */
const SAMPLE_INTERVAL_MS = 2_000;
const WALKING_SPEED_MPS = 1.4;

/**
 * Held at the count the fixture was cut with. The 5,000-point requirement it once met belonged
 * to the retired performance baseline (T8.3); the count stays because changing it changes the
 * track, and the renderer proof's compared pixel figures — legs, corridor — are of this track.
 */
const POINTS_PER_SEGMENT = 2_700;

/** How long the recorder is paused between the two segments. */
const PAUSE_MS = 7 * 60 * 1_000;

/** Metres per degree, near enough at 45.84°N for a fixture that must merely be plausible. */
const METRES_PER_DEGREE_LAT = 111_132;
const METRES_PER_DEGREE_LON = 77_500;

/**
 * A seeded generator whose arithmetic is entirely integer.
 *
 * `Math.random` is unusable here — the same seed has to produce the same track on every run, or
 * two renders compared against each other are looking at different fixtures. mulberry32 is
 * used rather than anything trigonometric for the same reason: `Math.sin`-based hashes are not
 * required to agree between engines, and a track that differs in its last decimal place is a
 * track whose serialisation differs.
 */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Keep a value inside `[min, max]`, reflecting off the edges so a walk never sticks to one. */
function reflect(value: number, min: number, max: number): number {
  if (value < min) return min + (min - value);
  if (value > max) return max - (value - max);
  return value;
}

interface Walk {
  points: TrackPoint[];
  lon: number;
  lat: number;
  heading: number;
  t: number;
  waypoint: number;
}

/**
 * A circuit that reaches near every edge of the region.
 *
 * Steered toward rather than diffused into. A random walk from the centre covers about the
 * square root of its path length, so 15 km of walking explored a quarter of the region and never
 * approached three of its four edges — leaving the containment check unable to observe a widened
 * bound. Expressed as fractions of the usable box so the circuit follows the region rather than
 * being a second copy of its coordinates.
 */
const CIRCUIT: ReadonlyArray<readonly [number, number]> = [
  [0.5, 0.95],
  [0.95, 0.55],
  [0.55, 0.05],
  [0.05, 0.45],
  [0.5, 0.9],
];

/**
 * Walk for a number of samples, turning gently, staying inside a margin of the region.
 *
 * The margin exists so a reflected step cannot land outside the archives' coverage: a track
 * leaving the region renders over blank basemap, which would make the offline scenario pass
 * while showing nothing.
 */
function walk(
  from: Omit<Walk, "points">,
  samples: number,
  random: () => number,
  marginDeg: number,
): Walk {
  const points: TrackPoint[] = [];
  let { lon, lat, heading, t, waypoint } = from;
  const stepM = (WALKING_SPEED_MPS * SAMPLE_INTERVAL_MS) / 1_000;
  const box = {
    west: FIXTURE_REGION.west + marginDeg,
    east: FIXTURE_REGION.east - marginDeg,
    south: FIXTURE_REGION.south + marginDeg,
    north: FIXTURE_REGION.north - marginDeg,
  };

  for (let i = 0; i < samples; i += 1) {
    const target = CIRCUIT[waypoint % CIRCUIT.length];
    const targetLon = box.west + (target?.[0] ?? 0.5) * (box.east - box.west);
    const targetLat = box.south + (target?.[1] ?? 0.5) * (box.north - box.south);
    const toTarget = Math.atan2(
      (targetLat - lat) * METRES_PER_DEGREE_LAT,
      (targetLon - lon) * METRES_PER_DEGREE_LON,
    );
    // Turn toward the waypoint by a fraction of the remaining angle, so the heading changes
    // smoothly rather than snapping — a GPS track that pivots instantly is not one.
    let delta = toTarget - heading;
    while (delta > Math.PI) delta -= 2 * Math.PI;
    while (delta < -Math.PI) delta += 2 * Math.PI;
    heading += delta * 0.05 + (random() - 0.5) * 0.22;

    const remainingM = Math.hypot(
      (targetLon - lon) * METRES_PER_DEGREE_LON,
      (targetLat - lat) * METRES_PER_DEGREE_LAT,
    );
    if (remainingM < 120) waypoint += 1;
    lon = reflect(
      lon + (Math.cos(heading) * stepM) / METRES_PER_DEGREE_LON,
      FIXTURE_REGION.west + marginDeg,
      FIXTURE_REGION.east - marginDeg,
    );
    lat = reflect(
      lat + (Math.sin(heading) * stepM) / METRES_PER_DEGREE_LAT,
      FIXTURE_REGION.south + marginDeg,
      FIXTURE_REGION.north - marginDeg,
    );
    points.push({
      lat,
      lng: lon,
      t,
      accuracyM: 4 + random() * 3,
      speedMps: WALKING_SPEED_MPS,
      headingDeg: ((heading * 180) / Math.PI + 360) % 360,
    });
    t += SAMPLE_INTERVAL_MS;
  }
  return { points, lon, lat, heading, t, waypoint };
}

/**
 * The fixture track: two recorded segments with a pause between them.
 *
 * @param seed Any integer. The same seed always yields the same track.
 */
export function generateFixtureTrack(seed = 20_260_831): Track {
  const random = seededRandom(seed);
  const startedAt = Date.UTC(2026, 7, 31, 8, 0, 0);
  const margin = 0.002;

  const first = walk(
    {
      lon: (FIXTURE_REGION.west + FIXTURE_REGION.east) / 2,
      lat: (FIXTURE_REGION.south + FIXTURE_REGION.north) / 2,
      heading: 0.7,
      t: startedAt,
      waypoint: 0,
    },
    POINTS_PER_SEGMENT,
    random,
    margin,
  );

  // **The walker keeps moving while the recorder is paused**, so the two segments do not meet.
  // A pause taken standing still renders identically whether or not a consumer bridges it, and
  // could not show that the gap is respected — which is the acceptance criterion.
  const resumeAt = first.t + PAUSE_MS;
  const displaced = walk(
    {
      lon: first.lon,
      lat: first.lat,
      heading: first.heading + 2.1,
      t: first.t,
      waypoint: first.waypoint,
    },
    Math.round(PAUSE_MS / SAMPLE_INTERVAL_MS / 6),
    random,
    margin,
  );

  const second = walk(
    {
      lon: displaced.lon,
      lat: displaced.lat,
      heading: displaced.heading,
      t: resumeAt,
      waypoint: displaced.waypoint,
    },
    POINTS_PER_SEGMENT,
    random,
    margin,
  );

  const points = [...first.points, ...second.points];
  // Read once and narrowed here rather than indexed inline: `exactOptionalPropertyTypes` will
  // not take `number | undefined` for `endedAt`, and threading that through three literals would
  // trade a real guarantee — both walks produced points — for three optional chains.
  const firstEnd = first.points.at(-1);
  const lastEnd = second.points.at(-1);
  if (firstEnd === undefined || lastEnd === undefined) {
    throw new Error("the fixture walk produced no points, so it has no segments to describe");
  }
  return finalizeTrack({
    id: "fixture-track",
    startedAt,
    endedAt: lastEnd.t,
    status: "finalized",
    origin: "recorded",
    points,
    segments: [
      {
        id: "fixture-segment-1",
        startIndex: 0,
        endIndex: first.points.length - 1,
        startedAt,
        endedAt: firstEnd.t,
      },
      {
        id: "fixture-segment-2",
        startIndex: first.points.length,
        endIndex: points.length - 1,
        startedAt: resumeAt,
        endedAt: lastEnd.t,
      },
    ],
  });
}

/** The part of a two-segment recording a renderer proof draws. */
export type SegmentView = "both" | "one" | "two" | "bridge";

/**
 * The zoom the pause is framed at.
 *
 * 17 puts the 94.6 m gap at roughly 105 px at this latitude — wide enough that a bridge is
 * unmistakable. At the whole-track zoom a line drawn straight across the gap lands entirely
 * inside the antialiased ends of the two segments and leaves **no** ink of its own — measured:
 * the bridged control's strictly-new pixels came to zero. A corridor that cannot hold a bridge
 * cannot show its absence either.
 */
export const PAUSE_FOCUS_ZOOM = 17;

/** The two points either side of the pause — a property of the input, read from the input. */
export function pauseEndpoints(track: Track): { from: TrackPoint; to: TrackPoint } {
  const first = track.segments[0];
  const second = track.segments[1];
  if (first === undefined || second === undefined) {
    throw new Error("a pause needs a two-segment recording");
  }
  const from = track.points[first.endIndex];
  const to = track.points[second.startIndex];
  if (from === undefined || to === undefined) {
    throw new Error("the recording's segments do not index its own points");
  }
  return { from, to };
}

/**
 * The part of a recording a view draws, as a track in its own right.
 *
 * Rebuilt through `finalizeTrack` rather than assembled by hand: the renderer reads
 * `simplifiedSegments`, so a track carrying the whole recording's cache under one segment's
 * points would draw geometry the caller never selected.
 *
 * `"bridge"` renders the two points either side of the pause as one two-point segment — the
 * track the renderer **must** draw across, whose strictly-new ink is the pause corridor.
 */
export function selectSegments(track: Track, view: SegmentView): Track {
  if (view === "both") return track;

  const first = track.segments[0];
  const second = track.segments[1];
  if (first === undefined || second === undefined) {
    throw new Error(`segments=${view} needs a two-segment recording`);
  }

  if (view === "bridge") {
    const { from, to } = pauseEndpoints(track);
    return finalizeTrack({
      ...track,
      points: [from, to],
      segments: [{ ...first, startIndex: 0, endIndex: 1 }],
    });
  }

  const segment = view === "one" ? first : second;
  return finalizeTrack({
    ...track,
    points: track.points.slice(segment.startIndex, segment.endIndex + 1),
    segments: [{ ...segment, startIndex: 0, endIndex: segment.endIndex - segment.startIndex }],
  });
}
