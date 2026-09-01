// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { generateFixtureTrack } from "./fixture-track.js";
import { createReplayGeolocation } from "./simulated-geolocation.js";

const track = generateFixtureTrack();
const START_AT = Date.UTC(2027, 0, 1, 9, 0, 0);

/** Collect every fix a replay emits, driving it to exhaustion. */
function drain(replay: ReturnType<typeof createReplayGeolocation>): GeolocationPosition[] {
  const fixes: GeolocationPosition[] = [];
  replay.geolocation.watchPosition((p) => fixes.push(p));
  while (replay.advance());
  return fixes;
}

describe("the replay emits the track it was given", () => {
  it("emits one fix per point, in order", () => {
    const fixes = drain(createReplayGeolocation(track, () => START_AT));

    expect(fixes).toHaveLength(track.points.length);
    expect(fixes.length).toBeGreaterThanOrEqual(5_000);
    for (let i = 0; i < fixes.length; i += 1) {
      expect(fixes[i]?.coords.latitude).toBe(track.points[i]?.lat);
      expect(fixes[i]?.coords.longitude).toBe(track.points[i]?.lng);
    }
  });

  it("reports when it is exhausted rather than emitting forever", () => {
    const replay = createReplayGeolocation(track, () => START_AT);
    while (replay.advance());
    expect(replay.advance()).toBe(false);
    expect(replay.emitted).toBe(track.points.length);
  });

  it("names where the pause belongs, from the track's own first segment", () => {
    // The caller pauses the recorder here. Read off the track rather than passed in, so a
    // fixture with a different split cannot desynchronise from the replay driving it.
    const replay = createReplayGeolocation(track, () => START_AT);
    expect(replay.pauseAfter).toBe(track.segments[0]?.endIndex);
    expect(replay.total).toBe(track.points.length);
  });
});

describe("times are shifted; geometry is not", () => {
  it("starts the replayed track at the requested epoch", () => {
    const fixes = drain(createReplayGeolocation(track, () => START_AT));
    expect(fixes[0]?.timestamp).toBe(START_AT);
  });

  it("preserves every interval exactly, including the pause", () => {
    // **The reason times are shifted at all.** The recorder keeps each point's own `t` but opens
    // a segment at `environment.now()`, so replaying a three-hour track instantly would give
    // segments timed by the wall clock and points timed from 2026 — `durationMs` meaningless,
    // possibly negative. Shifting the epoch fixes that without touching a coordinate.
    const fixes = drain(createReplayGeolocation(track, () => START_AT));
    for (let i = 1; i < fixes.length; i += 1) {
      const replayed = (fixes[i]?.timestamp ?? 0) - (fixes[i - 1]?.timestamp ?? 0);
      const original = (track.points[i]?.t ?? 0) - (track.points[i - 1]?.t ?? 0);
      expect(replayed).toBe(original);
    }
  });

  it("moves no coordinate when the epoch changes", () => {
    // Determinism is about geometry; the epoch is not part of it. Two replays at different
    // start times must trace the same line.
    const early = drain(createReplayGeolocation(track, () => START_AT));
    const late = drain(createReplayGeolocation(track, () => START_AT + 86_400_000));
    expect(early.map((f) => [f.coords.latitude, f.coords.longitude])).toEqual(
      late.map((f) => [f.coords.latitude, f.coords.longitude]),
    );
    expect(early[0]?.timestamp).not.toBe(late[0]?.timestamp);
  });
});

describe("it behaves like the browser object it replaces", () => {
  it("delivers fixes only after a watch is registered", () => {
    // A recorder that has not started must not receive positions; the replay pushes to
    // watchers, so an unwatched advance has to be a no-op rather than a buffered backlog.
    const replay = createReplayGeolocation(track, () => START_AT);
    expect(replay.advance()).toBe(true);
    const fixes: GeolocationPosition[] = [];
    replay.geolocation.watchPosition((p) => fixes.push(p));
    replay.advance();
    expect(fixes).toHaveLength(1);
  });

  it("clears only the watch it was given", () => {
    // Two watchers, one cleared. Clearing every watcher regardless of id would pass a
    // single-watcher test while hiding a recorder that cleared the wrong one.
    const replay = createReplayGeolocation(track, () => START_AT);
    const kept: GeolocationPosition[] = [];
    const dropped: GeolocationPosition[] = [];
    const keptId = replay.geolocation.watchPosition((p) => kept.push(p));
    const droppedId = replay.geolocation.watchPosition((p) => dropped.push(p));
    replay.advance();

    replay.geolocation.clearWatch(droppedId);
    replay.advance();

    expect(keptId).not.toBe(droppedId);
    expect(kept).toHaveLength(2);
    expect(dropped).toHaveLength(1);
  });

  it("does not let getCurrentPosition anchor the timeline", () => {
    // **The regression this guards.** Memoising the offset wherever a timestamp was produced
    // made a current-position call fix the epoch, so a delay before the recorder subscribed
    // pushed the first delivered fix earlier than the recorder's own start. A one-off reading
    // has no timeline to join; only a watch establishes one.
    let clock = 1_000_000;
    const replay = createReplayGeolocation(track, () => clock);

    replay.geolocation.getCurrentPosition(() => undefined);
    clock += 25; // the recorder is constructed and started in this gap
    const fixes: GeolocationPosition[] = [];
    replay.geolocation.watchPosition((p) => fixes.push(p));
    replay.advance();

    expect(fixes[0]?.timestamp).toBe(clock);
  });

  it("anchors on the first delivered fix, not on discarded history", () => {
    // Fixes advanced before anyone subscribed go nowhere. Anchoring on the track's own start
    // would date the timeline from those, placing the first *delivered* fix as far in the past
    // as the discarded ones were.
    let clock = 2_000_000;
    const replay = createReplayGeolocation(track, () => clock);

    replay.advance();
    replay.advance();
    replay.advance();
    clock += 500;
    const fixes: GeolocationPosition[] = [];
    replay.geolocation.watchPosition((p) => fixes.push(p));
    replay.advance();

    expect(fixes).toHaveLength(1);
    expect(fixes[0]?.timestamp).toBe(clock);
    // ...and it is the fourth point, not the first: history advanced, it was simply not seen.
    expect(fixes[0]?.coords.latitude).toBe(track.points[3]?.lat);
  });

  it("puts a current-position reading on the timeline once one exists", () => {
    const clock = 3_000_000;
    const replay = createReplayGeolocation(track, () => clock);
    replay.geolocation.watchPosition(() => undefined);
    replay.advance();

    let current: GeolocationPosition | undefined;
    replay.geolocation.getCurrentPosition((p) => {
      current = p;
    });

    // The second point's time on the established timeline, not another clock reading.
    const expected = clock + ((track.points[1]?.t ?? 0) - (track.points[0]?.t ?? 0));
    expect(current?.timestamp).toBe(expected);
  });

  it("answers getCurrentPosition without advancing the replay", () => {
    const replay = createReplayGeolocation(track, () => START_AT);
    let current: GeolocationPosition | undefined;
    replay.geolocation.getCurrentPosition((p) => {
      current = p;
    });
    expect(current?.coords.latitude).toBe(track.points[0]?.lat);
    expect(replay.emitted).toBe(0);
  });

  it("refuses a track with no segments rather than replaying an unsplittable one", () => {
    expect(() => createReplayGeolocation({ ...track, segments: [] }, () => START_AT)).toThrow(
      /at least one segment/,
    );
  });
});
