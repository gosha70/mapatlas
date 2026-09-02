// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { TrackDraftIncompleteError, createTrackDraft } from "./draft.js";
import type { TrackDraft } from "./draft.js";
import { finalizeTrack } from "./finalize.js";
import { newId } from "./ids.js";
import type { Id } from "./ids.js";
import type { JSONValue } from "./json.js";
import type { DraftTrackPoint, Track, TrackPoint } from "./track.js";
import { TrackTemporalOrderError } from "./validate.js";

const T0 = 1_700_000_000_000;
const ORIGIN = { lat: 59.33, lng: 18.06 };
const DEG_PER_M = 1 / 111_195;

/** A vertex `north` metres from the origin. */
const at = (north: number, t?: number): DraftTrackPoint => ({
  lat: ORIGIN.lat + north * DEG_PER_M,
  lng: ORIGIN.lng,
  ...(t === undefined ? {} : { t }),
});

/**
 * Anchor both sides of a pause, which interpolation now requires: only the author knows
 * how long the recording was stopped.
 */
function anchorPause(draft: TrackDraft, boundary: number, before: number, after: number): void {
  draft.setTimeAt(boundary - 1, before);
  draft.setTimeAt(boundary, after);
}

/** A draft of `count` vertices 100 m apart, untimed. */
function drawn(count: number): TrackDraft {
  const draft = createTrackDraft();
  for (let i = 0; i < count; i += 1) draft.append(at(i * 100));
  return draft;
}

describe("drawing", () => {
  it("appends vertices", () => {
    const draft = drawn(3);
    expect(draft.points).toHaveLength(3);
    expect(draft.points[1]?.lat).toBeCloseTo(ORIGIN.lat + 100 * DEG_PER_M, 8);
  });

  it("accepts a vertex with no timestamp — the whole point of DraftTrackPoint", () => {
    const draft = createTrackDraft();
    draft.append({ lat: 59.33, lng: 18.06 });
    expect(draft.points[0]?.t).toBeUndefined();
    expect(draft.untimedIndices).toEqual([0]);
  });

  it("inserts, moves and removes", () => {
    const draft = drawn(3);
    draft.insertAt(1, at(50));
    expect(draft.points).toHaveLength(4);

    draft.moveAt(1, { lat: 60, lng: 19 });
    expect(draft.points[1]).toMatchObject({ lat: 60, lng: 19 });

    draft.removeAt(1);
    expect(draft.points).toHaveLength(3);
    expect(draft.points[1]?.lat).toBeCloseTo(ORIGIN.lat + 100 * DEG_PER_M, 8);
  });

  it("hands out copies, so a caller cannot edit the draft through them", () => {
    const draft = drawn(2);
    const points = draft.points;
    points[0]!.lat = 0;
    points.push(at(999));

    expect(draft.points).toHaveLength(2);
    expect(draft.points[0]?.lat).toBeCloseTo(ORIGIN.lat, 8);
  });

  it("does not share nested channels with what a caller passed in", () => {
    const draft = createTrackDraft();
    const channels = { heartRateBpm: 120 };
    draft.append({ ...ORIGIN, channels });
    channels.heartRateBpm = 999;

    expect(draft.points[0]?.channels).toEqual({ heartRateBpm: 120 });
  });
});

describe("undo and redo", () => {
  it("restores the exact prior state across every mutation", () => {
    const draft = drawn(3);
    const before = draft.points;

    draft.append(at(300));
    draft.undo();
    expect(draft.points).toEqual(before);

    draft.moveAt(0, { lat: 1, lng: 1 });
    draft.undo();
    expect(draft.points).toEqual(before);

    draft.removeAt(0);
    draft.undo();
    expect(draft.points).toEqual(before);

    draft.insertAt(0, at(-100));
    draft.undo();
    expect(draft.points).toEqual(before);

    draft.setTimeAt(0, T0);
    draft.undo();
    expect(draft.points).toEqual(before);

    draft.breakAt(1);
    draft.undo();
    expect(draft.points).toEqual(before);
  });

  it("treats interpolateTimes as one step, though it rewrites many timestamps", () => {
    const draft = drawn(10);
    const before = draft.points;

    draft.interpolateTimes({ startedAt: T0, endedAt: T0 + 100_000 });
    expect(draft.untimedIndices).toEqual([]);

    draft.undo();
    expect(draft.points).toEqual(before);
    expect(draft.untimedIndices).toHaveLength(10);
  });

  it("redoes what was undone", () => {
    const draft = drawn(2);
    draft.append(at(200));
    const after = draft.points;

    draft.undo();
    expect(draft.points).toHaveLength(2);
    draft.redo();
    expect(draft.points).toEqual(after);
  });

  it("reports canUndo and canRedo immediately after each operation", () => {
    const draft = createTrackDraft();
    expect(draft.canUndo).toBe(false);
    expect(draft.canRedo).toBe(false);

    draft.append(at(0));
    expect(draft.canUndo).toBe(true);
    expect(draft.canRedo).toBe(false);

    draft.undo();
    expect(draft.canUndo).toBe(false);
    expect(draft.canRedo).toBe(true);

    draft.redo();
    expect(draft.canUndo).toBe(true);
    expect(draft.canRedo).toBe(false);
  });

  it("clears redo once a new edit lands", () => {
    const draft = drawn(3);
    draft.undo();
    expect(draft.canRedo).toBe(true);

    draft.append(at(999));
    expect(draft.canRedo).toBe(false);
  });

  it("is a no-op at the ends of history", () => {
    const draft = createTrackDraft();
    expect(() => draft.undo()).not.toThrow();
    expect(() => draft.redo()).not.toThrow();
    expect(draft.points).toEqual([]);
  });

  it("walks a long history back and forth", () => {
    const draft = createTrackDraft();
    const states: DraftTrackPoint[][] = [draft.points];
    for (let i = 0; i < 20; i += 1) {
      draft.append(at(i * 10));
      states.push(draft.points);
    }
    for (let i = 20; i > 0; i -= 1) {
      draft.undo();
      expect(draft.points).toEqual(states[i - 1]);
    }
    for (let i = 1; i <= 20; i += 1) {
      draft.redo();
      expect(draft.points).toEqual(states[i]);
    }
  });

  it("evicts the oldest states past the history limit", () => {
    const draft = createTrackDraft();
    for (let i = 0; i < 150; i += 1) draft.append(at(i));

    // 100 undos are available; the 101st is a no-op rather than an error.
    for (let i = 0; i < 100; i += 1) draft.undo();
    expect(draft.canUndo).toBe(false);
    expect(draft.points).toHaveLength(50);

    draft.undo();
    expect(draft.points).toHaveLength(50);
  });

  it("keeps history independent of later mutation — snapshots are deep", () => {
    const draft = createTrackDraft();
    draft.append({ ...ORIGIN, channels: { heartRateBpm: 100 } });
    draft.append({ ...ORIGIN, channels: { heartRateBpm: 110 } });

    draft.undo();
    draft.redo();

    expect(draft.points[0]?.channels).toEqual({ heartRateBpm: 100 });
    expect(draft.points[1]?.channels).toEqual({ heartRateBpm: 110 });
  });
});

describe("a rejected mutation is a non-event", () => {
  const rejections: [string, (d: TrackDraft) => void][] = [
    ["moveAt out of range", (d) => d.moveAt(999, { lat: 1, lng: 1 })],
    ["moveAt to a non-finite position", (d) => d.moveAt(0, { lat: Number.NaN, lng: 1 })],
    ["moveAt beyond the poles", (d) => d.moveAt(0, { lat: 91, lng: 1 })],
    ["removeAt out of range", (d) => d.removeAt(-1)],
    ["setTimeAt out of range", (d) => d.setTimeAt(999, T0)],
    ["setTimeAt with a negative time", (d) => d.setTimeAt(0, -1)],
    ["insertAt beyond the end", (d) => d.insertAt(99, at(0))],
    ["breakAt 0, which begins nothing", (d) => d.breakAt(0)],
    ["breakAt past the end", (d) => d.breakAt(99)],
    ["interpolateTimes with a bad startedAt", (d) => d.interpolateTimes({ startedAt: -1 })],
    [
      "interpolateTimes with endedAt before startedAt",
      (d) => d.interpolateTimes({ startedAt: T0, endedAt: T0 - 1 }),
    ],
    [
      "interpolateTimes with a non-positive speed",
      (d) => d.interpolateTimes({ startedAt: T0, speedMps: 0 }),
    ],
  ];

  it.each(rejections)("%s throws without touching state, history or listeners", (_name, act) => {
    const draft = drawn(4);
    draft.undo(); // 3 points, and something on the redo stack
    const priorState = draft.points; // what one undo should reach
    draft.append(at(400)); // 4 points again, redo cleared
    const currentState = draft.points;

    const changes: number[] = [];
    draft.onChange((points) => changes.push(points.length));

    expect(() => act(draft)).toThrow(RangeError);

    expect(draft.points).toEqual(currentState);
    expect(changes).toEqual([]); // no listener fired

    // The assertion the earlier version was missing: a path that pushed an undo snapshot
    // without clearing redo would have passed everything above. One undo must land on the
    // state that preceded the current one — not on the current one duplicated.
    draft.undo();
    expect(draft.points).toEqual(priorState);
  });

  it("preserves a live redo entry through a rejection", () => {
    const draft = drawn(4);
    draft.undo();
    expect(draft.canRedo).toBe(true);

    expect(() => draft.removeAt(-1)).toThrow(RangeError);

    expect(draft.canRedo).toBe(true);
  });

  it("rejects a duplicate break", () => {
    const draft = drawn(4);
    draft.breakAt(2);
    expect(() => draft.breakAt(2)).toThrow(/already begins a segment/);
  });
});

describe("listeners", () => {
  it("fires once per successful mutation, undo and redo", () => {
    const draft = drawn(2);
    const changes: number[] = [];
    draft.onChange((points) => changes.push(points.length));

    draft.append(at(200)); // 3
    draft.undo(); // 2
    draft.redo(); // 3

    expect(changes).toEqual([3, 2, 3]);
  });

  it("does not fire for an unavailable undo or redo", () => {
    const draft = createTrackDraft();
    const changes: unknown[] = [];
    draft.onChange((p) => changes.push(p));

    draft.undo();
    draft.redo();

    expect(changes).toEqual([]);
  });

  it("hands each listener its own copy", () => {
    const draft = drawn(2);
    let received: DraftTrackPoint[] = [];
    draft.onChange((points) => {
      received = points;
    });

    draft.append(at(200));
    received[0]!.lat = 0;

    expect(draft.points[0]?.lat).toBeCloseTo(ORIGIN.lat, 8);
  });

  it("stops delivering after unsubscribe", () => {
    const draft = drawn(2);
    const changes: unknown[] = [];
    const off = draft.onChange((p) => changes.push(p));

    draft.append(at(200));
    off();
    draft.append(at(300));

    expect(changes).toHaveLength(1);
  });
});

describe("breakAt and boundary shifting", () => {
  it("gives the break vertex to the later segment, never duplicating it", () => {
    const draft = drawn(6);
    draft.breakAt(3);
    anchorPause(draft, 3, T0 + 20_000, T0 + 300_000);
    draft.interpolateTimes({ startedAt: T0, endedAt: T0 + 500_000 });

    const track = draft.toTrack();
    expect(track.segments).toHaveLength(2);
    expect(track.segments[0]).toMatchObject({ startIndex: 0, endIndex: 2 });
    expect(track.segments[1]).toMatchObject({ startIndex: 3, endIndex: 5 });
  });

  it("shifts a boundary when a vertex is inserted before it", () => {
    const draft = drawn(6);
    draft.breakAt(3);
    draft.insertAt(1, at(50));
    anchorPause(draft, 4, T0 + 20_000, T0 + 300_000);
    draft.interpolateTimes({ startedAt: T0, endedAt: T0 + 500_000 });

    const track = draft.toTrack();
    expect(track.segments[0]).toMatchObject({ startIndex: 0, endIndex: 3 });
    expect(track.segments[1]).toMatchObject({ startIndex: 4, endIndex: 6 });
  });

  it("puts a vertex inserted exactly at the boundary in the earlier segment", () => {
    const draft = drawn(6);
    draft.breakAt(3);
    draft.insertAt(3, at(250));
    anchorPause(draft, 4, T0 + 20_000, T0 + 300_000);
    draft.interpolateTimes({ startedAt: T0, endedAt: T0 + 500_000 });

    const track = draft.toTrack();
    expect(track.segments[0]).toMatchObject({ startIndex: 0, endIndex: 3 });
  });

  it("shifts a boundary down when a vertex before it is removed", () => {
    const draft = drawn(6);
    draft.breakAt(3);
    draft.removeAt(0);
    anchorPause(draft, 2, T0 + 20_000, T0 + 300_000);
    draft.interpolateTimes({ startedAt: T0, endedAt: T0 + 500_000 });

    const track = draft.toTrack();
    expect(track.segments[0]).toMatchObject({ startIndex: 0, endIndex: 1 });
    expect(track.segments[1]).toMatchObject({ startIndex: 2, endIndex: 4 });
  });

  it("drops a boundary that no longer separates anything", () => {
    const draft = drawn(2);
    draft.breakAt(1);
    draft.removeAt(0);
    draft.interpolateTimes({ startedAt: T0, endedAt: T0 + 1000 });

    const track = draft.toTrack();
    expect(track.segments).toHaveLength(1);
  });

  it("supports several breaks", () => {
    const draft = drawn(9);
    draft.breakAt(3);
    draft.breakAt(6);
    anchorPause(draft, 3, T0 + 20_000, T0 + 300_000);
    anchorPause(draft, 6, T0 + 320_000, T0 + 600_000);
    draft.interpolateTimes({ startedAt: T0, endedAt: T0 + 800_000 });

    const track = draft.toTrack();
    expect(track.segments).toHaveLength(3);
    expect(track.segments.map((s) => [s.startIndex, s.endIndex])).toEqual([
      [0, 2],
      [3, 5],
      [6, 8],
    ]);
  });
});

describe("interpolateTimes", () => {
  it("fills every timestamp between a start and an end", () => {
    const draft = drawn(5);
    draft.interpolateTimes({ startedAt: T0, endedAt: T0 + 40_000 });

    const times = draft.points.map((p) => p.t);
    expect(times[0]).toBe(T0);
    expect(times.at(-1)).toBe(T0 + 40_000);
    expect(draft.untimedIndices).toEqual([]);
  });

  it("produces a strictly increasing series over distinct positions", () => {
    const draft = drawn(20);
    draft.interpolateTimes({ startedAt: T0, endedAt: T0 + 100_000 });

    const times = draft.points.map((p) => p.t ?? 0);
    for (let i = 1; i < times.length; i += 1) {
      expect(times[i]!).toBeGreaterThan(times[i - 1]!);
    }
  });

  it("distributes by distance, not by index", () => {
    // Three legs: 10 m, 10 m, then 980 m. A by-index fill would put the third vertex at
    // two thirds of the elapsed time; by distance it belongs near the very start.
    const draft = createTrackDraft();
    draft.append(at(0));
    draft.append(at(10));
    draft.append(at(20));
    draft.append(at(1000));
    draft.interpolateTimes({ startedAt: T0, endedAt: T0 + 100_000 });

    const times = draft.points.map((p) => (p.t ?? 0) - T0);
    expect(times[1]).toBeCloseTo(1000, -2);
    expect(times[2]).toBeCloseTo(2000, -2);
  });

  it("preserves anchored timestamps and fills only around them", () => {
    const draft = createTrackDraft();
    draft.append(at(0, T0));
    draft.append(at(100));
    draft.append(at(200, T0 + 90_000));
    draft.append(at(300));
    draft.interpolateTimes({ startedAt: T0, endedAt: T0 + 120_000 });

    const times = draft.points.map((p) => p.t);
    expect(times[0]).toBe(T0);
    expect(times[2]).toBe(T0 + 90_000); // untouched
    expect(times[1]).toBeGreaterThan(T0);
    expect(times[1]).toBeLessThan(T0 + 90_000);
    expect(times[3]).toBe(T0 + 120_000);
  });

  it("extends past the last anchor at a given speed", () => {
    const draft = createTrackDraft();
    draft.append(at(0, T0));
    draft.append(at(100));
    draft.append(at(200));
    draft.interpolateTimes({ startedAt: T0, speedMps: 10 });

    const times = draft.points.map((p) => (p.t ?? 0) - T0);
    expect(times[1]).toBeCloseTo(10_000, -2);
    expect(times[2]).toBeCloseTo(20_000, -2);
  });

  it("refuses to guess when points trail the last anchor with no rate", () => {
    const draft = drawn(4);
    expect(() => draft.interpolateTimes({ startedAt: T0 })).toThrow(/endedAt or speedMps/);
  });

  it("rejects anchors that already run backwards", () => {
    const draft = createTrackDraft();
    draft.append(at(0, T0 + 5000));
    draft.append(at(100));
    draft.append(at(200, T0));
    expect(() => draft.interpolateTimes({ startedAt: T0, endedAt: T0 + 9000 })).toThrow(
      /run backwards/,
    );
  });

  it("handles coincident vertices without dividing by zero", () => {
    const draft = createTrackDraft();
    for (let i = 0; i < 4; i += 1) draft.append(at(0));
    draft.interpolateTimes({ startedAt: T0, endedAt: T0 + 3000 });

    const times = draft.points.map((p) => p.t ?? 0);
    expect(times.every(Number.isFinite)).toBe(true);
    for (let i = 1; i < times.length; i += 1) {
      expect(times[i]!).toBeGreaterThanOrEqual(times[i - 1]!);
    }
  });

  it("does nothing to an empty draft", () => {
    const draft = createTrackDraft();
    expect(() => draft.interpolateTimes({ startedAt: T0, endedAt: T0 + 1 })).not.toThrow();
    expect(draft.points).toEqual([]);
  });
});

describe("toTrack", () => {
  it("refuses while any vertex is untimed, naming the indices", () => {
    const draft = drawn(4);
    draft.setTimeAt(0, T0);

    let thrown: TrackDraftIncompleteError | undefined;
    try {
      draft.toTrack();
    } catch (error) {
      thrown = error as TrackDraftIncompleteError;
    }

    expect(thrown).toBeInstanceOf(TrackDraftIncompleteError);
    expect(thrown?.untimedIndices).toEqual([1, 2, 3]);
    expect(thrown?.message).toContain("interpolateTimes");
  });

  it("succeeds once times are filled", () => {
    const draft = drawn(4);
    draft.interpolateTimes({ startedAt: T0, endedAt: T0 + 30_000 });
    expect(() => draft.toTrack()).not.toThrow();
  });

  it("marks the track authored and finalized", () => {
    const draft = drawn(4);
    draft.interpolateTimes({ startedAt: T0, endedAt: T0 + 30_000 });
    const track = draft.toTrack();

    expect(track.origin).toBe("authored");
    expect(track.status).toBe("finalized");
    expect(track.stats?.distanceM).toBeGreaterThan(0);
    expect(track.simplifiedSegments).toHaveLength(1);
  });

  it("carries consumer id, tags and meta", () => {
    const draft = drawn(3);
    draft.interpolateTimes({ startedAt: T0, endedAt: T0 + 20_000 });
    const id = newId();
    const track = draft.toTrack({ id, tags: ["a"], meta: { note: "hand-drawn" } });

    expect(track.id).toBe(id);
    expect(track.tags).toEqual(["a"]);
    expect(track.meta).toEqual({ note: "hand-drawn" });
  });

  it("surfaces a backwards timestamp from finalize rather than repairing it", () => {
    const draft = drawn(3);
    draft.setTimeAt(0, T0);
    draft.setTimeAt(1, T0 + 5000);
    draft.setTimeAt(2, T0 + 1000);
    expect(() => draft.toTrack()).toThrow(TrackTemporalOrderError);
  });

  it("does not touch history or fire listeners — it is a projection, not an edit", () => {
    const draft = drawn(4);
    draft.interpolateTimes({ startedAt: T0, endedAt: T0 + 30_000 });
    draft.undo(); // leaves a redo entry to prove toTrack does not clear it
    draft.redo();
    draft.undo();

    const pointsBefore = draft.points;
    const changes: unknown[] = [];
    draft.onChange((p) => changes.push(p));

    expect(draft.canRedo).toBe(true);
    // Untimed, so this throws — and even the failure path must not disturb anything.
    expect(() => draft.toTrack()).toThrow(TrackDraftIncompleteError);

    draft.redo();
    changes.length = 0;
    const timedPoints = draft.points;

    draft.toTrack();
    draft.toTrack();

    expect(draft.points).toEqual(timedPoints);
    expect(draft.points).not.toEqual(pointsBefore);
    expect(changes).toEqual([]);
    expect(draft.canUndo).toBe(true);
    expect(draft.canRedo).toBe(false);
  });

  it("produces equivalent tracks when called twice, ids aside", () => {
    const draft = drawn(6);
    draft.breakAt(3);
    anchorPause(draft, 3, T0 + 10_000, T0 + 30_000);
    draft.interpolateTimes({ startedAt: T0, endedAt: T0 + 50_000 });

    const a = draft.toTrack();
    const b = draft.toTrack();

    expect(b.points).toEqual(a.points);
    expect(b.stats).toEqual(a.stats);
    expect(b.simplifiedSegments).toEqual(a.simplifiedSegments);
    expect(b.segments.map((s) => [s.startIndex, s.endIndex])).toEqual(
      a.segments.map((s) => [s.startIndex, s.endIndex]),
    );
  });
});

describe("the finalized track does not share state with the draft", () => {
  it("does not let a mutation of the track reach into the draft", () => {
    // Regression: toTrack spread the point, so the finalized track kept the draft's own
    // nested channels object. Mutating the track edited the draft with no undo entry and
    // no listener event — a change nobody asked for and nobody could observe.
    const draft = createTrackDraft();
    draft.append({ ...ORIGIN, t: T0, channels: { heartRateBpm: 100 } });
    draft.append({ ...at(100), t: T0 + 1000, channels: { heartRateBpm: 110 } });

    const track = draft.toTrack();
    track.points[0]!.channels!["heartRateBpm"] = 999;
    track.points[1]!.lat = 0;

    expect(draft.points[0]?.channels).toEqual({ heartRateBpm: 100 });
    expect(draft.points[1]?.lat).toBeCloseTo(ORIGIN.lat + 100 * DEG_PER_M, 8);
  });

  it("gives each toTrack call its own points", () => {
    const draft = createTrackDraft();
    draft.append({ ...ORIGIN, t: T0, channels: { heartRateBpm: 100 } });
    draft.append({ ...at(100), t: T0 + 1000, channels: { heartRateBpm: 110 } });

    const first = draft.toTrack();
    first.points[0]!.channels!["heartRateBpm"] = 999;

    expect(draft.toTrack().points[0]?.channels).toEqual({ heartRateBpm: 100 });
  });
});

describe("timestamps supplied with a point are validated", () => {
  const bad = [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY];

  it.each(bad)("append rejects t=%s", (t) => {
    // Regression: only setTimeAt validated. A point carrying NaN counted as timed, escaped
    // untimedIndices, and finalized into a track whose durationMs was NaN.
    expect(() => createTrackDraft().append({ ...ORIGIN, t })).toThrow(RangeError);
  });

  it.each(bad)("insertAt rejects t=%s", (t) => {
    const draft = drawn(2);
    expect(() => draft.insertAt(1, { ...ORIGIN, t })).toThrow(RangeError);
  });

  it("rejects a non-finite channel value", () => {
    expect(() =>
      createTrackDraft().append({ ...ORIGIN, channels: { heartRateBpm: Number.NaN } }),
    ).toThrow(/not a finite number/);
  });

  it("leaves the draft untouched when it rejects", () => {
    const draft = drawn(2);
    const before = draft.points;
    expect(() => draft.append({ ...ORIGIN, t: Number.NaN })).toThrow();
    expect(draft.points).toEqual(before);
    expect(draft.untimedIndices).toEqual([0, 1]);
  });
});

describe("a pause has a duration only the author knows", () => {
  it("refuses to interpolate across an unanchored break", () => {
    // Regression: the cumulative distance included the leg across the break, so a large
    // relocation during a pause absorbed most of the elapsed time.
    const draft = drawn(6);
    draft.breakAt(3);
    expect(() => draft.interpolateTimes({ startedAt: T0, endedAt: T0 + 500_000 })).toThrow(
      /pause at points\[3\] has no duration to infer/,
    );
  });

  it("names both points that need a time", () => {
    const draft = drawn(6);
    draft.breakAt(3);
    expect(() => draft.interpolateTimes({ startedAt: T0, endedAt: T0 + 1000 })).toThrow(
      /points\[2\] and points\[3\]/,
    );
  });

  it("spends no elapsed time on the leg that was never travelled", () => {
    // Two short segments 10 m long, separated by a 50 km relocation during a two-hour
    // pause. Time inside each segment must come from that segment's own geometry, not be
    // dominated by the distance nobody walked.
    const draft = createTrackDraft();
    draft.append(at(0));
    draft.append(at(5));
    draft.append(at(10));
    draft.append(at(50_000));
    draft.append(at(50_005));
    draft.append(at(50_010));
    draft.breakAt(3);

    draft.setTimeAt(0, T0);
    draft.setTimeAt(2, T0 + 10_000);
    draft.setTimeAt(3, T0 + 7_210_000); // two hours later, elsewhere
    draft.setTimeAt(5, T0 + 7_220_000);
    draft.interpolateTimes({ startedAt: T0, endedAt: T0 + 7_220_000 });

    const times = draft.points.map((p) => (p.t ?? 0) - T0);
    // Midpoint of a 10 m segment lands halfway through that segment's 10 s, not somewhere
    // dictated by the 50 km gap.
    expect(times[1]).toBeCloseTo(5000, -2);
    expect(times[4]).toBeCloseTo(7_215_000, -2);
  });

  it("still interpolates normally with no breaks at all", () => {
    const draft = drawn(5);
    expect(() => draft.interpolateTimes({ startedAt: T0, endedAt: T0 + 40_000 })).not.toThrow();
  });
});

describe("round trip through an existing track", () => {
  function recorded(): Track {
    const points: TrackPoint[] = [];
    for (let i = 0; i < 8; i += 1) {
      points.push({
        ...at(i * 100),
        t: T0 + i * 10_000,
        altitudeM: 100 + i,
        channels: { heartRateBpm: 120 + i },
      } as TrackPoint);
    }
    return finalizeTrack({
      points,
      segments: [
        { id: newId(), startIndex: 0, endIndex: 3, startedAt: T0 },
        { id: newId(), startIndex: 4, endIndex: 7, startedAt: T0 + 40_000 },
      ],
      tags: ["seeded", "trip"],
      meta: { note: "recorded earlier", nested: { deep: true } },
      channels: [{ key: "heartRateBpm", label: "Heart rate", unit: "bpm", aggregate: "avg" }],
      laps: [
        { id: newId(), startIndex: 0, endIndex: 3, label: "Lap 1" },
        { id: newId(), startIndex: 4, endIndex: 7 },
      ],
    });
  }

  it("reproduces an unedited track without losing its canonical metadata", () => {
    // Regression: only points and break indices survived seeding, so an unedited round
    // trip silently minted a new id and dropped tags, meta, laps and — worst — the channel
    // descriptors, which took every channel statistic with them while leaving orphaned
    // values on the points.
    const track = recorded();
    const rebuilt = createTrackDraft(track).toTrack();

    expect(rebuilt.id).toBe(track.id);
    expect(rebuilt.tags).toEqual(track.tags);
    expect(rebuilt.meta).toEqual(track.meta);
    expect(rebuilt.channels).toEqual(track.channels);
    expect(rebuilt.points).toEqual(track.points);
    expect(rebuilt.segments.map((s) => [s.startIndex, s.endIndex])).toEqual(
      track.segments.map((s) => [s.startIndex, s.endIndex]),
    );
    expect(rebuilt.laps?.map((l) => [l.startIndex, l.endIndex])).toEqual(
      track.laps?.map((l) => [l.startIndex, l.endIndex]),
    );
    expect(rebuilt.stats).toEqual(track.stats);
  });

  it("keeps the channel statistics that the descriptors make possible", () => {
    const rebuilt = createTrackDraft(recorded()).toTrack();
    expect(rebuilt.stats?.channels?.["heartRateBpm"]).toMatchObject({
      count: 8,
      min: 120,
      max: 127,
    });
  });

  it("lets an explicit argument override what was seeded", () => {
    const track = recorded();
    const id = newId();
    const rebuilt = createTrackDraft(track).toTrack({ id, tags: ["replaced"] });

    expect(rebuilt.id).toBe(id);
    expect(rebuilt.tags).toEqual(["replaced"]);
    expect(rebuilt.meta).toEqual(track.meta); // untouched by the override
  });

  it("shifts laps through edits and drops one that no longer describes a span", () => {
    const track = recorded();
    const draft = createTrackDraft(track);

    draft.insertAt(0, at(-100, T0 - 10_000));
    const afterInsert = draft.toTrack();
    expect(afterInsert.laps?.map((l) => [l.startIndex, l.endIndex])).toEqual([
      [1, 4],
      [5, 8],
    ]);

    draft.removeAt(0);
    const afterRemove = draft.toTrack();
    expect(afterRemove.laps?.map((l) => [l.startIndex, l.endIndex])).toEqual([
      [0, 3],
      [4, 7],
    ]);
  });

  it("renumbers surviving laps so index stays contiguous", () => {
    const rebuilt = createTrackDraft(recorded()).toTrack();
    expect(rebuilt.laps?.map((l) => l.index)).toEqual([0, 1]);
  });

  it("mints fresh segment ids, which are internal and can be merged or split by an edit", () => {
    const track = recorded();
    const rebuilt = createTrackDraft(track).toTrack();
    expect(rebuilt.segments[0]?.id).not.toBe(track.segments[0]?.id);
  });

  it("marks the rebuilt track authored, since it passed through a draft", () => {
    expect(createTrackDraft(recorded()).toTrack().origin).toBe("authored");
  });

  it("never mutates the track it was seeded from", () => {
    const track = recorded();
    const before = structuredClone(track);

    const draft = createTrackDraft(track);
    draft.moveAt(0, { lat: 1, lng: 1 });
    draft.removeAt(1);
    draft.toTrack();

    expect(track).toEqual(before);
  });

  it("starts with empty history — seeding is not an edit", () => {
    expect(createTrackDraft(recorded()).canUndo).toBe(false);
  });
});

describe("TrackDraft's published signature", () => {
  /**
   * `toTrack`'s parameters, transcribed from `api.md` — not imported from `TrackDraft`, which
   * would only check that the code agrees with itself.
   */
  type PublishedToTrack = (meta?: {
    id?: Id;
    tags?: string[];
    meta?: Record<string, JSONValue>;
  }) => Track;

  /**
   * Compared as **tuples, in both directions**. One-way assignment is what let a second
   * `policy?: Partial<FinalizePolicy>` parameter sit on this interface undocumented: a function
   * with an extra *optional* parameter is assignable to a narrower function type, so nothing
   * built on assignability could see it, and no call site ever passed one.
   */
  type Exactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

  /**
   * The same comparison over **key sets**, because structural equality does not reach an extra
   * optional member.
   *
   * The tuple comparison is exact about the *parameters* and not about the shape of the one
   * object among them: `{ id?, tags?, meta?, policy? }` and `{ id?, tags?, meta? }` are mutually
   * assignable — an extra property is fine in one direction, an optional one in the other — so a
   * leak could simply move out of a second parameter and into the first. The same hole was found
   * while making `@mapatlas/react`'s hooks conform, and it is closed the same way.
   */
  type ExactKeys<A, B> = Exactly<keyof A, keyof B>;

  const parametersMatch: Exactly<
    Parameters<TrackDraft["toTrack"]>,
    Parameters<PublishedToTrack>
  > = true;
  const returnMatches: Exactly<
    ReturnType<TrackDraft["toTrack"]>,
    ReturnType<PublishedToTrack>
  > = true;
  const metaShapeMatches: ExactKeys<
    NonNullable<Parameters<TrackDraft["toTrack"]>[0]>,
    NonNullable<Parameters<PublishedToTrack>[0]>
  > = true;

  it("takes exactly the arguments api.md publishes", () => {
    // The comparisons above are the check — a mismatch fails `tsc`, not this. Asserting them
    // keeps them from being deleted as unused and states what they mean: an extra parameter and
    // an extra key on the metadata object are both undocumented surface.
    expect([parametersMatch, returnMatches, metaShapeMatches]).toEqual([true, true, true]);
  });
});
