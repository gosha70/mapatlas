// SPDX-License-Identifier: Apache-2.0

/**
 * The vertical fixture's recorded track (T4.6).
 *
 * Generated from a seed rather than checked in, so `/lab` and the offline browser scenario read
 * the *same* track without a large JSON artifact in the repository — and so a reviewer can see
 * what it is instead of scrolling past five thousand coordinates.
 *
 * **Determinism is Node-to-Node, not yet Node-to-browser.** The same seed gives the same track
 * in one runtime; the coordinate walk uses `atan2`, `cos`, `sin` and `hypot` and accumulates
 * floating-point positions, none of which is required to agree bit-for-bit across engines. The
 * seeded generator itself is integer arithmetic, which is why `Math.random` is unusable here,
 * but that alone does not make the *track* identical everywhere. Establishing that needs the
 * browser to serialise its own track and Node to compare — the offline scenario's job, and open
 * until then.
 *
 * **It is finalised by the engine.** `generateFixtureTrack` hands raw points and segments to
 * `finalizeTrack`, so `stats` and `simplifiedSegments` are the engine's own output and the
 * geometry has passed `assertValidTrackGeometry`. A hand-assembled object would happily carry
 * shapes the engine rejects, and the fixture would then be testing itself.
 *
 * Domain-free by construction: the two event marks carry neutral categories, because no domain
 * vocabulary may enter this repository — not in code, not in fixtures.
 */

import { finalizeTrack, type MapEvent, type Track, type TrackPoint } from "@mapatlas/core";

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

/** T4.6 asks for at least five thousand raw points; two segments of this many clear it. */
const POINTS_PER_SEGMENT = 2_700;

/** How long the recorder is paused between the two segments. */
const PAUSE_MS = 7 * 60 * 1_000;

/** Metres per degree, near enough at 45.84°N for a fixture that must merely be plausible. */
const METRES_PER_DEGREE_LAT = 111_132;
const METRES_PER_DEGREE_LON = 77_500;

/**
 * A seeded generator whose arithmetic is entirely integer.
 *
 * `Math.random` is unusable here — the same seed has to produce the same track in Node and in a
 * browser, or `/lab` and the offline scenario are looking at different fixtures. mulberry32 is
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

/**
 * Two consumer-defined marks, positioned on the track by index so they cannot drift off it.
 *
 * Categories are neutral: the presentation seam keys off `category` (§8), and what a consumer
 * calls its events is the consumer's business. Naming them here would put domain vocabulary in
 * the engine's own fixtures, which is the one thing this repository does not allow.
 */
export function generateFixtureEvents(track: Track): MapEvent[] {
  const marks = [
    { index: Math.floor(POINTS_PER_SEGMENT * 0.4), category: "observation", comment: "First mark" },
    {
      index: POINTS_PER_SEGMENT + Math.floor(POINTS_PER_SEGMENT * 0.6),
      category: "sample",
      comment: "Second mark, after the pause",
    },
  ];
  return marks.map(({ index, category, comment }, order) => {
    const point = track.points[index];
    if (point === undefined) {
      throw new Error(
        `fixture event ${String(order)} refers to point ${String(index)}, which the track does not have`,
      );
    }
    return {
      id: `fixture-event-${String(order + 1)}`,
      trackId: track.id,
      position: { lat: point.lat, lng: point.lng },
      occurredAt: point.t,
      comment,
      media: [],
      tags: [],
      category,
    };
  });
}
