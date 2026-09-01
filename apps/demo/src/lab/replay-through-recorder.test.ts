// @vitest-environment happy-dom
// SPDX-License-Identifier: Apache-2.0
import type { Track } from "@mapatlas/core";
import { createWebTrackRecorder } from "@mapatlas/recorder-web";
import { afterEach, describe, expect, it } from "vitest";

import { generateFixtureTrack } from "./fixture-track.js";
import { LAB_SAMPLING, createReplayGeolocation } from "./simulated-geolocation.js";

/**
 * The seam the replay exists to feed.
 *
 * The unit suite drains the geolocation object directly, which establishes what the replay
 * *emits* and nothing about what survives. Those are different numbers: the recorder's default
 * policy keeps a fix only after 10 m of movement, and the fixture's points are 2.8 m apart, so a
 * default run retained 5 of the first 20. "5,400 points through `TrackRecorder`" is an acceptance
 * claim about the recorder's output, so it has to be asserted there.
 */
const track = generateFixtureTrack();

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

/** Install the replay as the page's geolocation, as `/lab` does. */
function install(replay: ReturnType<typeof createReplayGeolocation>): void {
  const original = Object.getOwnPropertyDescriptor(navigator, "geolocation");
  Object.defineProperty(navigator, "geolocation", {
    value: replay.geolocation,
    configurable: true,
  });
  restore = () => {
    if (original === undefined) delete (navigator as { geolocation?: unknown }).geolocation;
    else Object.defineProperty(navigator, "geolocation", original);
  };
}

/** Drive a whole recording: every fix, pausing where the fixture's own split falls. */
async function record(options: { readCurrentPositionFirst?: boolean } = {}): Promise<Track> {
  const replay = createReplayGeolocation(track);
  install(replay);
  // A demo may well ask where it is before it starts recording, and that call must not date the
  // recording's timeline. Exercised here because the unit suite cannot see the recorder's own
  // `startedAt`, which is stamped from a private clock inside `start()`.
  if (options.readCurrentPositionFirst === true) {
    replay.geolocation.getCurrentPosition(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const recorder = createWebTrackRecorder({ sampling: LAB_SAMPLING });
  await recorder.start();

  for (let i = 0; i < replay.total; i += 1) {
    if (i === replay.pauseAfter + 1) {
      recorder.pause();
      recorder.resume();
    }
    replay.advance();
  }
  return recorder.stop();
}

describe("the replay through the real recorder", () => {
  it("keeps every emitted fix, which the default policy would not", async () => {
    // `LAB_SAMPLING` is chosen, not defaulted: at 2.8 m spacing the shipped 10 m rule discards
    // three quarters of the track, and the point count would then be a property of the policy
    // rather than of the fixture.
    const recorded = await record();

    expect(recorded.points).toHaveLength(track.points.length);
    expect(recorded.points.length).toBeGreaterThanOrEqual(5_000);
  });

  it("produces exactly two segments, split where the fixture pauses", async () => {
    const recorded = await record();

    expect(recorded.segments).toHaveLength(2);
    expect(recorded.segments[0]?.endIndex).toBe((recorded.segments[1]?.startIndex ?? 0) - 1);
  });

  it("starts no later than its own first point", async () => {
    // The invariant the lazy epoch exists for. Anchoring when the replay was *constructed* put
    // the first fix 27 ms before the recorder's `startedAt`, because the recorder stamps that
    // from a private clock inside `start()` — and a longer delay makes `durationMs` negative.
    const recorded = await record();

    expect(recorded.points[0]?.t).toBeGreaterThanOrEqual(recorded.startedAt);
    expect(recorded.stats?.durationMs).toBeGreaterThan(0);
  });

  it("starts no later than its first point even after a current-position reading", async () => {
    // The reproduction: a current-position call, a delay, then `start()`. Anchoring the timeline
    // on that reading put the first recorded fix 27 ms before `startedAt`.
    const recorded = await record({ readCurrentPositionFirst: true });

    expect(recorded.points[0]?.t).toBeGreaterThanOrEqual(recorded.startedAt);
    expect(recorded.stats?.durationMs).toBeGreaterThan(0);
  });

  it("carries the fixture's geometry through unchanged", async () => {
    const recorded = await record();

    for (let i = 0; i < recorded.points.length; i += 1) {
      expect(recorded.points[i]?.lat).toBe(track.points[i]?.lat);
      expect(recorded.points[i]?.lng).toBe(track.points[i]?.lng);
    }
  });

  it("keeps the pause a gap in space, not only in the segment table", async () => {
    const recorded = await record();
    const last = recorded.points[recorded.segments[0]?.endIndex ?? 0];
    const resumed = recorded.points[recorded.segments[1]?.startIndex ?? 0];

    const metres = Math.hypot(
      ((resumed?.lng ?? 0) - (last?.lng ?? 0)) * 77_500,
      ((resumed?.lat ?? 0) - (last?.lat ?? 0)) * 111_132,
    );
    expect(metres).toBeGreaterThan(50);
  });
});
