// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { newId } from "./ids.js";
import type { TrackPoint, TrackSegment } from "./track.js";
import {
  TrackSegmentRangeError,
  TrackTemporalOrderError,
  assertValidTrackGeometry,
} from "./validate.js";

const T0 = 1_700_000_000_000;

const pointsAt = (...times: number[]): TrackPoint[] =>
  times.map((t, i) => ({ lat: 59.33 + i * 0.0001, lng: 18.06, t: T0 + t }));

const segment = (startIndex: number, endIndex: number, startedAt = 0): TrackSegment => ({
  id: newId(),
  startIndex,
  endIndex,
  startedAt: T0 + startedAt,
});

describe("temporal order", () => {
  it("accepts strictly increasing timestamps", () => {
    const points = pointsAt(0, 1000, 2000, 3000);
    expect(() => assertValidTrackGeometry({ points, segments: [segment(0, 3)] })).not.toThrow();
  });

  it("accepts equal timestamps — degenerate, but not corrupt", () => {
    // Two fixes can share a millisecond, and an imported file often rounds to the second.
    // The invariant is non-decreasing, so only a strict decrease is a fault.
    const points = pointsAt(0, 1000, 1000, 1000, 2000);
    expect(() => assertValidTrackGeometry({ points, segments: [segment(0, 4)] })).not.toThrow();
  });

  it("throws when time runs backwards, naming both indices and both timestamps", () => {
    const points = pointsAt(0, 1000, 500, 2000);
    let thrown: TrackTemporalOrderError | undefined;
    try {
      assertValidTrackGeometry({ points, segments: [segment(0, 3)] });
    } catch (error) {
      thrown = error as TrackTemporalOrderError;
    }

    expect(thrown).toBeInstanceOf(TrackTemporalOrderError);
    expect(thrown?.previousIndex).toBe(1);
    expect(thrown?.index).toBe(2);
    expect(thrown?.previousT).toBe(T0 + 1000);
    expect(thrown?.t).toBe(T0 + 500);
    expect(thrown?.message).toContain("500");
  });

  it("throws on a decrease of a single millisecond", () => {
    const points = pointsAt(0, 1000, 999);
    expect(() => assertValidTrackGeometry({ points, segments: [segment(0, 2)] })).toThrow(
      TrackTemporalOrderError,
    );
  });

  it("does not fire across a segment boundary, where a gap is the whole point", () => {
    // A pause. The second segment legitimately starts later; there is nothing to compare
    // across the boundary, and expecting continuity there would be a category error.
    const points = pointsAt(0, 1000, 600_000, 601_000);
    const segments = [segment(0, 1), segment(2, 3, 600_000)];
    expect(() => assertValidTrackGeometry({ points, segments })).not.toThrow();
  });

  it("still catches a regression inside the second segment", () => {
    const points = pointsAt(0, 1000, 600_000, 599_000);
    const segments = [segment(0, 1), segment(2, 3, 600_000)];
    expect(() => assertValidTrackGeometry({ points, segments })).toThrow(TrackTemporalOrderError);
  });

  it("ignores points outside any segment, which no segment claims", () => {
    const points = pointsAt(0, 1000, 500, 2000);
    // Only points 2..3 are claimed, and those are in order.
    expect(() => assertValidTrackGeometry({ points, segments: [segment(2, 3)] })).not.toThrow();
  });
});

describe("segment ranges", () => {
  const points = pointsAt(0, 1000, 2000, 3000, 4000);

  it("accepts a single segment spanning every point", () => {
    expect(() => assertValidTrackGeometry({ points, segments: [segment(0, 4)] })).not.toThrow();
  });

  it("accepts adjacent segments that do not overlap", () => {
    const segments = [segment(0, 1), segment(2, 4)];
    expect(() => assertValidTrackGeometry({ points, segments })).not.toThrow();
  });

  it("accepts an empty track with no segments", () => {
    expect(() => assertValidTrackGeometry({ points: [], segments: [] })).not.toThrow();
  });

  it("accepts a single-point segment", () => {
    expect(() => assertValidTrackGeometry({ points, segments: [segment(2, 2)] })).not.toThrow();
  });

  it("rejects a range running past the end of the points", () => {
    let thrown: TrackSegmentRangeError | undefined;
    try {
      assertValidTrackGeometry({ points, segments: [segment(0, 5)] });
    } catch (error) {
      thrown = error as TrackSegmentRangeError;
    }
    expect(thrown).toBeInstanceOf(TrackSegmentRangeError);
    expect(thrown?.segmentIndex).toBe(0);
    expect(thrown?.message).toContain("outside");
  });

  it("rejects a negative start", () => {
    expect(() => assertValidTrackGeometry({ points, segments: [segment(-1, 2)] })).toThrow(
      TrackSegmentRangeError,
    );
  });

  it("rejects an inverted range", () => {
    expect(() => assertValidTrackGeometry({ points, segments: [segment(3, 1)] })).toThrow(
      /inverted/,
    );
  });

  it("rejects overlapping segments", () => {
    const segments = [segment(0, 3), segment(2, 4)];
    expect(() => assertValidTrackGeometry({ points, segments })).toThrow(/inside the preceding/);
  });

  it("rejects non-integer indices", () => {
    const segments = [{ ...segment(0, 2), endIndex: 2.5 }];
    expect(() => assertValidTrackGeometry({ points, segments })).toThrow(/integers/);
  });

  it("checks ranges before timestamps, so a malformed range is not read out of bounds", () => {
    // Both faults present. The range check must fire, because the temporal check would
    // otherwise index past the end of the array to compare something that is not there.
    const broken = pointsAt(0, 1000, 500);
    expect(() => assertValidTrackGeometry({ points: broken, segments: [segment(0, 9)] })).toThrow(
      TrackSegmentRangeError,
    );
  });
});

describe("purity", () => {
  it("never modifies the input", () => {
    const points = pointsAt(0, 1000, 2000);
    const segments = [segment(0, 2)];
    const pointsBefore = structuredClone(points);
    const segmentsBefore = structuredClone(segments);

    assertValidTrackGeometry({ points, segments });

    expect(points).toEqual(pointsBefore);
    expect(segments).toEqual(segmentsBefore);
  });

  it("leaves the input untouched when it throws", () => {
    const points = pointsAt(0, 1000, 500);
    const before = structuredClone(points);
    expect(() => assertValidTrackGeometry({ points, segments: [segment(0, 2)] })).toThrow();
    expect(points).toEqual(before);
  });
});
