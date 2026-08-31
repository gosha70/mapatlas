// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";

import { assertValidTrackGeometry } from "@mapatlas/core";
import { describe, expect, it } from "vitest";

import { FIXTURE_REGION, generateFixtureEvents, generateFixtureTrack } from "./fixture-track.js";

const track = generateFixtureTrack();

describe("the fixture track is reproducible", () => {
  it("produces an identical track for the same seed", () => {
    // `/lab` and the offline scenario generate this independently. If they diverged, each would
    // be testing a different fixture while both reported success. Compared as whole serialised
    // tracks rather than by sampling, because a divergence in one late coordinate is exactly
    // what a spot check misses.
    expect(JSON.stringify(generateFixtureTrack())).toBe(JSON.stringify(generateFixtureTrack()));
  });

  it("produces a different track for a different seed", () => {
    // Otherwise the first assertion holds trivially — a generator ignoring its seed passes it.
    expect(JSON.stringify(generateFixtureTrack(1))).not.toBe(
      JSON.stringify(generateFixtureTrack(2)),
    );
  });

  it.todo(
    "produces a byte-identical track in a browser — pending the offline scenario serialising " +
      "the browser's own track for Node to compare",
    // **Deliberately not asserted here, because it is not true of this code yet.** An earlier
    // version claimed "integer arithmetic only" and checked it with
    // `generateFixtureTrack.toString()`, which contains neither `seededRandom` nor `walk` — so
    // it inspected the wrong function, to verify a property the walk does not have: the
    // coordinates come from `atan2`, `cos`, `sin` and `hypot` over accumulated floats, none of
    // which is required to agree bit-for-bit across engines. The seeded stream is portable; the
    // track built on it is unproven. A unit suite cannot run two runtimes, so this stays open
    // rather than being asserted by something that cannot see it.
  );
});

describe("it is a real Track, not a shape resembling one", () => {
  it("passes the engine's own geometry validation", () => {
    expect(() => {
      assertValidTrackGeometry(track);
    }).not.toThrow();
  });

  it("carries the engine's derived output rather than hand-written values", () => {
    // `finalizeTrack` produced these; a hand-assembled fixture would carry whatever its author
    // typed, and would drift from what the engine computes the moment either changed.
    expect(track.simplifiedSegments).toHaveLength(2);
    expect(track.stats?.distanceM).toBeGreaterThan(0);
    expect(track.stats?.movingTimeMs).toBeLessThan(track.stats?.durationMs ?? 0);
  });
});

describe("it is large enough for the baseline to mean something", () => {
  it("carries at least the 5,000 raw points T4.6 asks for", () => {
    // The count is the point: it is what makes the frame-time baseline a signal, and a fixture
    // that quietly shrank would make a regression look like an improvement.
    expect(track.points.length).toBeGreaterThanOrEqual(5_000);
  });
});

describe("the pause is a gap in time and in space", () => {
  const [first, second] = track.segments;

  it("splits the track into exactly two segments", () => {
    expect(track.segments).toHaveLength(2);
    expect(first?.endIndex).toBe((second?.startIndex ?? 0) - 1);
  });

  it("records nothing during the pause", () => {
    const gapMs = (second?.startedAt ?? 0) - (first?.endedAt ?? 0);
    expect(gapMs).toBeGreaterThan(60_000);
    // No point falls inside the gap: the recorder was off, not merely sparse.
    const inside = track.points.filter(
      (p) => p.t > (first?.endedAt ?? 0) && p.t < (second?.startedAt ?? 0),
    );
    expect(inside).toEqual([]);
  });

  it("resumes somewhere the first segment did not end", () => {
    // **The property the acceptance criterion turns on.** A pause taken standing still renders
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

describe("it stays where the archives cover", () => {
  /**
   * The region as the **archives** declare it, loaded from the checked-in file.
   *
   * `FIXTURE_REGION` is a copy the browser bundle needs, and the generator uses it. Judging
   * containment against that same copy would let the two drift together: widen the copy and the
   * track follows it out of the archives' coverage, with the check still passing. The archive
   * declaration is the authority, so the test reads it.
   */
  const declared = JSON.parse(
    readFileSync(new URL("../../../../fixtures/vertical/region.json", import.meta.url), "utf8"),
  ) as { bounds: [number, number, number, number] };
  const [west, south, east, north] = declared.bounds;

  it("uses the same region the archives were cut for", () => {
    expect([
      FIXTURE_REGION.west,
      FIXTURE_REGION.south,
      FIXTURE_REGION.east,
      FIXTURE_REGION.north,
    ]).toEqual(declared.bounds);
  });

  it("keeps every point inside the region the archives declare", () => {
    // Outside it there is no terrain and no contour tile, so the offline scenario would pass
    // while showing blank basemap. Judged against the loaded declaration, not the bundled copy.
    for (const point of track.points) {
      expect(point.lng).toBeGreaterThanOrEqual(west);
      expect(point.lng).toBeLessThanOrEqual(east);
      expect(point.lat).toBeGreaterThanOrEqual(south);
      expect(point.lat).toBeLessThanOrEqual(north);
    }
  });

  it("traverses most of the region rather than hugging one corner", () => {
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

describe("the event marks", () => {
  const events = generateFixtureEvents(track);

  it("places two marks, one in each segment", () => {
    expect(events).toHaveLength(2);
    const [first, second] = track.segments;
    const times = events.map((e) => e.occurredAt);
    expect(times[0]).toBeLessThanOrEqual(first?.endedAt ?? 0);
    expect(times[1]).toBeGreaterThanOrEqual(second?.startedAt ?? 0);
  });

  it("puts each mark on a point the track actually contains", () => {
    // Positioned by index rather than by coordinate, so a mark cannot drift off the line when
    // the seed or the walk changes.
    for (const event of events) {
      expect(
        track.points.some((p) => p.lat === event.position.lat && p.lng === event.position.lng),
      ).toBe(true);
    }
  });

  it("carries a category and no domain vocabulary", () => {
    // The presentation seam keys off `category`; what a consumer calls its events is the
    // consumer's business, and naming a domain here would put one in the engine's own fixtures.
    for (const event of events) expect(event.category).toBeTruthy();
    expect(new Set(events.map((e) => e.category)).size).toBe(2);
  });
});

describe("speeds and times are plausible", () => {
  it("keeps every step at a walking pace", () => {
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

  it("advances time strictly", () => {
    for (let i = 1; i < track.points.length; i += 1) {
      expect(track.points[i]?.t).toBeGreaterThan(track.points[i - 1]?.t ?? 0);
    }
  });
});
