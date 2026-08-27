// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import {
  DEFAULT_FINALIZE_POLICY,
  DEFAULT_SIMPLIFY_TOLERANCE_M,
  finalizeTrack,
  resolveFinalizePolicy,
} from "./finalize.js";
import { newId } from "./ids.js";
import type { Track, TrackPoint, TrackSegment } from "./track.js";
import { TrackSegmentRangeError, TrackTemporalOrderError } from "./validate.js";

const T0 = 1_700_000_000_000;
const ORIGIN = { lat: 59.33, lng: 18.06 };
const DEG_PER_M = 1 / 111_195;

const COS_LAT = Math.cos(ORIGIN.lat * (Math.PI / 180));

/** A point `north`/`east` metres from the origin at `afterMs`. */
const at = (
  north: number,
  afterMs: number,
  extra: Partial<TrackPoint> = {},
  east = 0,
): TrackPoint => ({
  lat: ORIGIN.lat + north * DEG_PER_M,
  lng: ORIGIN.lng + (east * DEG_PER_M) / COS_LAT,
  t: T0 + afterMs,
  ...extra,
});

/**
 * A wandering run of `count` points with genuine two-dimensional shape.
 *
 * The lateral term matters: a fixture that varies only latitude is a straight line along a
 * meridian, every interior point is collinear, and Douglas-Peucker collapses it to two
 * points at any tolerance — which makes a "simplification reduced the count" assertion pass
 * for the wrong reason and a "tolerance changes the result" assertion impossible.
 */
function wander(count: number, startIndexMs = 0, lateralOffsetM = 0): TrackPoint[] {
  return Array.from({ length: count }, (_, i) =>
    at(
      i * 10,
      startIndexMs + i * 1000,
      { altitudeM: 100 + i * 0.5 },
      lateralOffsetM + Math.sin(i / 6) * 30 + Math.sin(i * 3.1) * 4,
    ),
  );
}

const oneSegment = (points: TrackPoint[]): TrackSegment[] => [
  { id: newId(), startIndex: 0, endIndex: points.length - 1, startedAt: points[0]?.t ?? T0 },
];

describe("validation happens before derivation", () => {
  it("throws on a backwards timestamp", () => {
    const points = [at(0, 0), at(10, 5000), at(20, 2000)];
    expect(() => finalizeTrack({ points, segments: oneSegment(points) })).toThrow(
      TrackTemporalOrderError,
    );
  });

  it("throws on a malformed segment range", () => {
    const points = [at(0, 0), at(10, 1000)];
    const segments = [{ id: newId(), startIndex: 0, endIndex: 9, startedAt: T0 }];
    expect(() => finalizeTrack({ points, segments })).toThrow(TrackSegmentRangeError);
  });

  it("derives nothing when it throws — the input is exactly as it was", () => {
    const points = [at(0, 0), at(10, 5000), at(20, 2000)];
    const track = { points, segments: oneSegment(points) };
    const before = structuredClone(track);

    expect(() => finalizeTrack(track)).toThrow();

    expect(track).toEqual(before);
    expect(track).not.toHaveProperty("stats");
    expect(track).not.toHaveProperty("simplifiedSegments");
  });
});

describe("the finalized result", () => {
  it("marks the track finalized and fills the derived fields", () => {
    const points = wander(50);
    const result = finalizeTrack({ points, segments: oneSegment(points) });

    expect(result.status).toBe("finalized");
    expect(result.origin).toBe("recorded");
    expect(result.id).toHaveLength(26);
    expect(result.startedAt).toBe(points[0]?.t);
    expect(result.endedAt).toBe(points.at(-1)?.t);
    expect(result.stats?.distanceM).toBeGreaterThan(0);
    expect(result.simplifiedSegments).toBeDefined();
  });

  it("keeps an id, origin and timestamps the caller already supplied", () => {
    const points = wander(10);
    const id = newId();
    const result = finalizeTrack({
      points,
      segments: oneSegment(points),
      id,
      origin: "authored",
      startedAt: T0 - 999,
      endedAt: T0 + 999,
    });

    expect(result.id).toBe(id);
    expect(result.origin).toBe("authored");
    expect(result.startedAt).toBe(T0 - 999);
    expect(result.endedAt).toBe(T0 + 999);
  });

  it("never modifies the input", () => {
    const points = wander(30);
    const track = { points, segments: oneSegment(points) };
    const before = structuredClone(track);

    finalizeTrack(track);

    expect(track).toEqual(before);
    expect(track).not.toHaveProperty("stats");
  });

  it("carries consumer tags and meta through untouched", () => {
    const points = wander(5);
    const result = finalizeTrack({
      points,
      segments: oneSegment(points),
      tags: ["a", "b"],
      meta: { anything: { nested: true } },
    });
    expect(result.tags).toEqual(["a", "b"]);
    expect(result.meta).toEqual({ anything: { nested: true } });
  });
});

describe("simplification is mapped per segment", () => {
  const twoSegments = (): Pick<Track, "points" | "segments"> => {
    const first = wander(40);
    // Resumes an hour later and a kilometre away — the gap the pause represents.
    const second = wander(40, 3_600_000, 1000);
    const points = [...first, ...second];
    return {
      points,
      segments: [
        { id: newId(), startIndex: 0, endIndex: 39, startedAt: points[0]?.t ?? T0 },
        { id: newId(), startIndex: 40, endIndex: 79, startedAt: points[40]?.t ?? T0 },
      ],
    };
  };

  it("produces one simplified member per segment, in the same order", () => {
    const track = twoSegments();
    const result = finalizeTrack(track);
    expect(result.simplifiedSegments).toHaveLength(track.segments.length);
  });

  it("does not let a simplified member span the pause", () => {
    const track = twoSegments();
    const result = finalizeTrack(track);

    const [firstSimplified, secondSimplified] = result.simplifiedSegments ?? [];
    const firstSegmentEnd = track.points[track.segments[0]?.endIndex ?? 0];
    const secondSegmentStart = track.points[track.segments[1]?.startIndex ?? 0];

    expect(firstSimplified?.at(-1)?.t).toBe(firstSegmentEnd?.t);
    expect(secondSimplified?.[0]?.t).toBe(secondSegmentStart?.t);
  });

  it("keeps each segment's endpoints", () => {
    const track = twoSegments();
    const result = finalizeTrack(track);

    for (const [i, segment] of track.segments.entries()) {
      const simplified = result.simplifiedSegments?.[i];
      expect(simplified?.[0]?.t).toBe(track.points[segment.startIndex]?.t);
      expect(simplified?.at(-1)?.t).toBe(track.points[segment.endIndex]?.t);
    }
  });

  it("actually reduces the point count at the default tolerance", () => {
    const points = wander(200);
    const result = finalizeTrack({ points, segments: oneSegment(points) });
    expect(result.simplifiedSegments?.[0]?.length).toBeLessThan(points.length);
  });

  it("honours a caller-supplied tolerance", () => {
    const points = wander(200);
    const loose = finalizeTrack(
      { points, segments: oneSegment(points) },
      { simplifyToleranceM: 50 },
    );
    const tight = finalizeTrack(
      { points, segments: oneSegment(points) },
      { simplifyToleranceM: 0.5 },
    );
    expect(loose.simplifiedSegments?.[0]?.length).toBeLessThan(
      tight.simplifiedSegments?.[0]?.length ?? 0,
    );
  });
});

describe("simplifiedSegments is a disposable cache (ADR-0018)", () => {
  it("regenerates byte-identically after being deleted", () => {
    // The property that makes a storage migration or an algorithm change safe: drop the
    // cache and rebuild, because it was never authoritative.
    const points = wander(300);
    const track = { points, segments: oneSegment(points) };

    const first = finalizeTrack(track);
    const stripped: Track = { ...first };
    delete stripped.simplifiedSegments;
    const second = finalizeTrack(stripped);

    expect(second.simplifiedSegments).toEqual(first.simplifiedSegments);
    expect(JSON.stringify(second.simplifiedSegments)).toBe(
      JSON.stringify(first.simplifiedSegments),
    );
  });

  it("leaves the rest of the track unchanged when regenerated", () => {
    const points = wander(100);
    const first = finalizeTrack({ points, segments: oneSegment(points) });

    const stripped: Track = { ...first };
    delete stripped.simplifiedSegments;
    const second = finalizeTrack(stripped);

    expect(second.stats).toEqual(first.stats);
    expect(second.points).toEqual(first.points);
    expect(second.segments).toEqual(first.segments);
    expect(second.id).toBe(first.id);
  });

  it("is deterministic across repeated runs", () => {
    const points = wander(150);
    const track = { points, segments: oneSegment(points), id: newId() };
    expect(finalizeTrack(track)).toEqual(finalizeTrack(track));
  });
});

describe("policy", () => {
  it("defaults the simplify tolerance to 5 m", () => {
    expect(DEFAULT_SIMPLIFY_TOLERANCE_M).toBe(5);
    expect(DEFAULT_FINALIZE_POLICY.simplifyToleranceM).toBe(5);
    expect(DEFAULT_FINALIZE_POLICY.elevationHysteresisM).toBe(5);
    expect(Object.isFrozen(DEFAULT_FINALIZE_POLICY)).toBe(true);
  });

  it("passes the elevation policy through to the statistics", () => {
    const altitudes = [100, 101, 102, 103, 104, 105, 106];
    const points = altitudes.map((altitudeM, i) => at(i * 20, i * 10_000, { altitudeM }));
    const segments = oneSegment(points);

    const strict = finalizeTrack({ points, segments }, { elevationHysteresisM: 0 });
    const loose = finalizeTrack({ points, segments }, { elevationHysteresisM: 50 });

    expect(strict.stats?.elevationGainM).toBeCloseTo(6, 6);
    expect(loose.stats?.elevationGainM).toBeCloseTo(0, 6);
  });

  it("fills a partial policy from the defaults", () => {
    expect(resolveFinalizePolicy({ simplifyToleranceM: 1 })).toEqual({
      simplifyToleranceM: 1,
      elevationHysteresisM: 5,
    });
  });

  it("finalizes recorded, authored and imported tracks under the same policy", () => {
    // ADR-0014: the only difference between them is one enum field.
    const points = wander(60);
    const segments = oneSegment(points);
    const results = (["recorded", "authored", "imported"] as const).map((origin) =>
      finalizeTrack({ points, segments, id: "fixed-id", origin }),
    );

    const [recorded, authored, imported] = results;
    expect(authored?.stats).toEqual(recorded?.stats);
    expect(imported?.stats).toEqual(recorded?.stats);
    expect(authored?.simplifiedSegments).toEqual(recorded?.simplifiedSegments);
    expect(new Set(results.map((r) => r?.origin)).size).toBe(3);
  });
});
