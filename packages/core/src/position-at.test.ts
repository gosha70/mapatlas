// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import * as barrel from "./index.js";
import { positionAt } from "./position-at.js";
import type { LatLng } from "./geo.js";
import type { Track, TrackPoint, TrackSegment } from "./track.js";

/**
 * `api.md` §4, transcribed — the section where `positionAt` is declared, beside finalization and
 * statistics. Mutual assignability is not enough: an extra optional parameter or a widened
 * return would pass it, so the comparison is exact, as the React barrel's is.
 */
type PublishedPositionAt = (
  track: Pick<Track, "points" | "segments">,
  t: number,
) => LatLng | undefined;

type Exactly<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

const conformsToSection4: [
  Exactly<Parameters<typeof barrel.positionAt>, Parameters<PublishedPositionAt>>,
  Exactly<ReturnType<typeof barrel.positionAt>, ReturnType<PublishedPositionAt>>,
] = [true, true];

/**
 * Every semantic ADR-0032 pins gets its own test, because publishing the symbol made each of
 * them a promise — one implementation satisfying the headline rule could fail any of the others.
 */
const p = (t: number, lat: number, lng: number): TrackPoint => ({ lat, lng, t });
const seg = (startIndex: number, endIndex: number, startedAt: number): TrackSegment => ({
  id: `s${String(startIndex)}`,
  startIndex,
  endIndex,
  startedAt,
});

/** A ends at t=100, B begins at t=200 — the worked example in ADR-0032. */
const PAUSED: Pick<Track, "points" | "segments"> = {
  points: [p(0, 10, 20), p(100, 11, 20), p(200, 30, 40), p(300, 31, 40)],
  segments: [seg(0, 1, 0), seg(2, 3, 200)],
};

describe("positionAt", () => {
  it("takes exactly the parameters and returns exactly the shape api.md §4 publishes", () => {
    // The compile-time rows above are the real check; asserting them here keeps them from being
    // deleted as unused and states what they mean.
    expect(conformsToSection4).toEqual([true, true]);
    expect(barrel.positionAt, "callable through the barrel, not merely a name").toBeTypeOf(
      "function",
    );
  });

  it("returns a recorded point's own coordinates at its exact timestamp", () => {
    expect(positionAt(PAUSED, 0)).toEqual({ lat: 10, lng: 20 });
    expect(positionAt(PAUSED, 100)).toEqual({ lat: 11, lng: 20 });
    expect(positionAt(PAUSED, 300)).toEqual({ lat: 31, lng: 40 });
  });

  it("interpolates linearly between the two samples bracketing t", () => {
    // Halfway in time is halfway in lat/lng — the piecewise geometry the track supplies, with
    // no geodesic path invented for animation's sake.
    expect(positionAt(PAUSED, 50)).toEqual({ lat: 10.5, lng: 20 });
    expect(positionAt(PAUSED, 250)).toEqual({ lat: 30.5, lng: 40 });
  });

  it("holds at the last point before a pause, for the whole gap", () => {
    // The bar. Returning B's first point would leak a future observation backwards in time;
    // holding says only that there is no evidence of movement after this point, which is what
    // the map says by drawing nothing across the gap.
    expect(positionAt(PAUSED, 150), "mid-pause").toEqual({ lat: 11, lng: 20 });
    expect(positionAt(PAUSED, 199), "the instant before B begins").toEqual({ lat: 11, lng: 20 });
    expect(positionAt(PAUSED, 200), "the instant B begins").toEqual({ lat: 30, lng: 40 });
  });

  it("gives a boundary instant to the later segment when the two are equal", () => {
    // A ends and B begins at the same millisecond. B is the current observation there — the
    // generalisation of "held until the next segment begins".
    const touching: Pick<Track, "points" | "segments"> = {
      points: [p(0, 10, 20), p(100, 11, 20), p(100, 50, 60), p(200, 51, 60)],
      segments: [seg(0, 1, 0), seg(2, 3, 100)],
    };
    expect(positionAt(touching, 100)).toEqual({ lat: 50, lng: 60 });
  });

  it("never interpolates across a segment boundary", () => {
    // If it did, t=150 would land halfway between (11,20) and (30,40) — around (20.5,30).
    const held = positionAt(PAUSED, 150);
    expect(held).not.toEqual({ lat: 20.5, lng: 30 });
    expect(held?.lat, "a value between the segments means the boundary was crossed").toBe(11);
  });

  it("returns undefined outside the trip rather than clamping to an endpoint", () => {
    // A position at a time outside the trip has no truthful answer, and clamping would report
    // one the track never claims to have observed then.
    expect(positionAt(PAUSED, -1)).toBeUndefined();
    expect(positionAt(PAUSED, 301)).toBeUndefined();
  });

  it("resolves duplicate timestamps to the later sample, without dividing by zero", () => {
    const duplicated: Pick<Track, "points" | "segments"> = {
      points: [p(0, 10, 20), p(100, 11, 20), p(100, 12, 25), p(200, 13, 30)],
      segments: [seg(0, 3, 0)],
    };
    const at = positionAt(duplicated, 100);
    expect(at, "the later sample at that instant").toEqual({ lat: 12, lng: 25 });
    expect(Number.isFinite(at?.lat), "a NaN would be worse than a wrong answer").toBe(true);
  });

  it("returns undefined for a track with no points", () => {
    expect(positionAt({ points: [], segments: [] }, 0)).toBeUndefined();
  });

  it("throws a RangeError for a non-finite t", () => {
    expect(() => positionAt(PAUSED, Number.NaN)).toThrow(RangeError);
    expect(() => positionAt(PAUSED, Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it("handles a single-point track and an instantaneous segment", () => {
    const single: Pick<Track, "points" | "segments"> = {
      points: [p(500, 1, 2)],
      segments: [seg(0, 0, 500)],
    };
    expect(positionAt(single, 500)).toEqual({ lat: 1, lng: 2 });
    expect(positionAt(single, 499)).toBeUndefined();
    expect(positionAt(single, 501)).toBeUndefined();
  });
});
