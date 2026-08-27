// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { TrackDraftIncompleteError, createTrackDraft } from "./draft.js";
import type { TrackDraft } from "./draft.js";
import { finalizeTrack } from "./finalize.js";
import { newId } from "./ids.js";
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
    draft.undo(); // leave something on the redo stack
    const before = draft.points;
    const changes: number[] = [];
    draft.onChange((points) => changes.push(points.length));

    expect(() => act(draft)).toThrow(RangeError);

    expect(draft.points).toEqual(before);
    expect(draft.canRedo).toBe(true); // redo survived
    expect(changes).toEqual([]); // no listener fired
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
    draft.interpolateTimes({ startedAt: T0, endedAt: T0 + 500_000 });

    const track = draft.toTrack();
    expect(track.segments[0]).toMatchObject({ startIndex: 0, endIndex: 3 });
    expect(track.segments[1]).toMatchObject({ startIndex: 4, endIndex: 6 });
  });

  it("puts a vertex inserted exactly at the boundary in the earlier segment", () => {
    const draft = drawn(6);
    draft.breakAt(3);
    draft.insertAt(3, at(250));
    draft.interpolateTimes({ startedAt: T0, endedAt: T0 + 500_000 });

    const track = draft.toTrack();
    expect(track.segments[0]).toMatchObject({ startIndex: 0, endIndex: 3 });
  });

  it("shifts a boundary down when a vertex before it is removed", () => {
    const draft = drawn(6);
    draft.breakAt(3);
    draft.removeAt(0);
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

describe("round trip through an existing track", () => {
  function recorded(): Track {
    const points: TrackPoint[] = [];
    for (let i = 0; i < 8; i += 1) {
      points.push({ ...at(i * 100), t: T0 + i * 10_000 } as TrackPoint);
    }
    return finalizeTrack({
      points,
      segments: [
        { id: newId(), startIndex: 0, endIndex: 3, startedAt: T0 },
        { id: newId(), startIndex: 4, endIndex: 7, startedAt: T0 + 40_000 },
      ],
    });
  }

  it("seeds a draft from a track and reproduces it unchanged", () => {
    const track = recorded();
    const draft = createTrackDraft(track);
    const rebuilt = draft.toTrack({ id: track.id });

    expect(rebuilt.points).toEqual(track.points);
    expect(rebuilt.segments.map((s) => [s.startIndex, s.endIndex])).toEqual(
      track.segments.map((s) => [s.startIndex, s.endIndex]),
    );
    expect(rebuilt.stats).toEqual(track.stats);
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
