// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";

import { assertValidTrackGeometry } from "@mapatlas/core";
import { expect, test } from "@playwright/test";

import { FIXTURE_REGION, generateFixtureTrack } from "./fixtures/fixture-track.js";

/**
 * The fixture track's own properties — the ones the renderer proofs in `map-controller.e2e.ts`
 * and the archive framing rely on.
 *
 * **A Playwright spec that never opens a browser**, like the hue test and `structure-oracle`:
 * the generator lives in `e2e/fixtures/`, which the unit lane excludes, and this is where a
 * fixture declaration is checked in this repository. Twelve of the sixteen unit tests it had as
 * `/lab`'s module moved here unchanged in substance (T8.3); the four that served the retired
 * performance baseline and the retired route's marks were retired with them, and so was a todo
 * about cross-runtime byte identity, which a single generating runtime no longer needs.
 */

const track = generateFixtureTrack();

test.describe("the fixture track is reproducible", () => {
  test("produces an identical track for the same seed", () => {
    // Every consumer generates this independently. If two diverged, each would be testing a
    // different fixture while both reported success. Compared as whole serialised tracks rather
    // than by sampling, because a divergence in one late coordinate is exactly what a spot
    // check misses.
    expect(JSON.stringify(generateFixtureTrack())).toBe(JSON.stringify(generateFixtureTrack()));
  });

  test("produces a different track for a different seed", () => {
    // Otherwise the first assertion holds trivially — a generator ignoring its seed passes it.
    expect(JSON.stringify(generateFixtureTrack(1))).not.toBe(
      JSON.stringify(generateFixtureTrack(2)),
    );
  });
});

test.describe("it is a real Track, not a shape resembling one", () => {
  test("passes the engine's own geometry validation", () => {
    expect(() => {
      assertValidTrackGeometry(track);
    }).not.toThrow();
  });

  test("carries the engine's derived output rather than hand-written values", () => {
    // `finalizeTrack` produced these; a hand-assembled fixture would carry whatever its author
    // typed, and would drift from what the engine computes the moment either changed.
    expect(track.simplifiedSegments).toHaveLength(2);
    expect(track.stats?.distanceM).toBeGreaterThan(0);
    expect(track.stats?.movingTimeMs).toBeLessThan(track.stats?.durationMs ?? 0);
  });
});

test.describe("the pause is a gap in time and in space", () => {
  const [first, second] = track.segments;

  test("splits the track into exactly two segments", () => {
    expect(track.segments).toHaveLength(2);
    expect(first?.endIndex).toBe((second?.startIndex ?? 0) - 1);
  });

  test("records nothing during the pause", () => {
    const gapMs = (second?.startedAt ?? 0) - (first?.endedAt ?? 0);
    expect(gapMs).toBeGreaterThan(60_000);
    // No point falls inside the gap: the recorder was off, not merely sparse.
    const inside = track.points.filter(
      (p) => p.t > (first?.endedAt ?? 0) && p.t < (second?.startedAt ?? 0),
    );
    expect(inside).toEqual([]);
  });

  test("resumes somewhere the first segment did not end", () => {
    // **The property the renderer proof turns on.** A pause taken standing still renders
    // identically whether a consumer bridges the gap or not, so it could not show that the gap
    // is respected. The walker moves across it, so a bridged pause draws a straight line no
    // sampled point lies on.
    const last = track.points[first?.endIndex ?? 0];
    const resumed = track.points[second?.startIndex ?? 0];
    const metres = Math.hypot(
      ((resumed?.lng ?? 0) - (last?.lng ?? 0)) * 77_500,
      ((resumed?.lat ?? 0) - (last?.lat ?? 0)) * 111_132,
    );
    expect(metres).toBeGreaterThan(50);
  });
});

test.describe("it stays where the archives cover", () => {
  /**
   * The region as the **archives** declare it, loaded from the checked-in file.
   *
   * `FIXTURE_REGION` is a copy the generator uses. Judging containment against that same copy
   * would let the two drift together: widen the copy and the track follows it out of the
   * archives' coverage, with the check still passing. The archive declaration is the authority,
   * so the test reads it.
   */
  const declared = JSON.parse(
    readFileSync(new URL("../fixtures/vertical/region.json", import.meta.url), "utf8"),
  ) as { bounds: [number, number, number, number] };
  const [west, south, east, north] = declared.bounds;

  test("uses the same region the archives were cut for", () => {
    expect([
      FIXTURE_REGION.west,
      FIXTURE_REGION.south,
      FIXTURE_REGION.east,
      FIXTURE_REGION.north,
    ]).toEqual(declared.bounds);
  });

  test("keeps every point inside the region the archives declare", () => {
    // Outside it there is no terrain and no contour tile, so a proof over the archives would
    // pass while showing blank tiles. Judged against the loaded declaration, not the copy.
    for (const point of track.points) {
      expect(point.lng).toBeGreaterThanOrEqual(west);
      expect(point.lng).toBeLessThanOrEqual(east);
      expect(point.lat).toBeGreaterThanOrEqual(south);
      expect(point.lat).toBeLessThanOrEqual(north);
    }
  });

  test("traverses most of the region rather than hugging one corner", () => {
    // **Containment is only meaningful if the track approaches the bounds.** A diffusing walk
    // from the centre covered a quarter of the region and came nowhere near three of its four
    // edges, so widening any of those bounds changed nothing observable — the check passed
    // while testing nothing. The circuit now spans about 88% of each axis; 60% leaves room for
    // the walk to vary without letting it quietly shrink back.
    const lngs = track.points.map((p) => p.lng);
    const lats = track.points.map((p) => p.lat);
    const spanLng =
      (Math.max(...lngs) - Math.min(...lngs)) / (FIXTURE_REGION.east - FIXTURE_REGION.west);
    const spanLat =
      (Math.max(...lats) - Math.min(...lats)) / (FIXTURE_REGION.north - FIXTURE_REGION.south);
    expect(spanLng).toBeGreaterThan(0.6);
    expect(spanLat).toBeGreaterThan(0.6);
  });
});

test.describe("speeds and times are plausible", () => {
  test("keeps every step at a walking pace", () => {
    // Stats computed from a track implying 300 m/s are stats no reviewer can sanity-check, and
    // make `maxSpeedMps` useless as a regression signal.
    let worst = 0;
    for (let i = 1; i < track.points.length; i += 1) {
      const a = track.points[i - 1];
      const b = track.points[i];
      if (a === undefined || b === undefined) continue;
      const dt = (b.t - a.t) / 1_000;
      if (dt <= 0) continue;
      const metres = Math.hypot((b.lng - a.lng) * 77_500, (b.lat - a.lat) * 111_132);
      worst = Math.max(worst, metres / dt);
    }
    expect(worst).toBeLessThan(3);
  });

  test("advances time strictly", () => {
    for (let i = 1; i < track.points.length; i += 1) {
      expect(track.points[i]?.t).toBeGreaterThan(track.points[i - 1]?.t ?? 0);
    }
  });
});
