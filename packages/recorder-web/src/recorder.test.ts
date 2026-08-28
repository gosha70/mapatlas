// SPDX-License-Identifier: Apache-2.0
import type { TrackPoint, TrackRecorderError } from "@mapatlas/core";
import { assertValidTrackGeometry } from "@mapatlas/core";
import { describe, expect, it } from "vitest";

import type { PositionFix, WakeLockLease, WebRecorderEnvironment } from "./environment.js";
import { POSITION_ERROR } from "./environment.js";
import { createWebTrackRecorderInternal } from "./recorder.js";

const T0 = 1_700_000_000_000;
const ORIGIN = { lat: 59.33, lng: 18.06 };
const DEG_PER_M = 1 / 111_195;

/** A fix `metresNorth` from the origin at `t`. */
function fix(metresNorth: number, t: number, accuracy = 5): PositionFix {
  return {
    coords: { latitude: ORIGIN.lat + metresNorth * DEG_PER_M, longitude: ORIGIN.lng, accuracy },
    timestamp: t,
  };
}

/** A hand-driven browser: no timers, no geolocation, no wake lock, no waiting. */
function createTestEnvironment(startAt = T0) {
  let time = startAt;
  let nextWatchId = 1;

  const watches = new Map<
    number,
    { onFix: (f: PositionFix) => void; onFailure: (e: { code: number; message?: string }) => void }
  >();
  const intervals = new Map<unknown, { cb: () => void; ms: number }>();
  let nextHandle = 1;

  const wakeLocks: { released: boolean }[] = [];
  let wakeLockSupported = true;
  let pendingWakeLock: ((lease: WakeLockLease | undefined) => void) | undefined;
  let deferWakeLock = false;
  let watchThrows = false;

  const environment: WebRecorderEnvironment = {
    now: () => time,

    watchPosition: (onFix, onFailure) => {
      if (watchThrows) throw new Error("geolocation is unavailable");
      const id = nextWatchId++;
      watches.set(id, { onFix, onFailure });
      return id;
    },

    clearWatch: (id) => {
      watches.delete(id);
    },

    requestWakeLock: () => {
      if (!wakeLockSupported) return Promise.resolve(undefined);
      const lease = { released: false };
      wakeLocks.push(lease);
      const held: WakeLockLease = {
        release: () => {
          lease.released = true;
          return Promise.resolve();
        },
      };
      if (deferWakeLock) {
        return new Promise((resolve) => {
          pendingWakeLock = resolve;
        }).then(() => held);
      }
      return Promise.resolve(held);
    },

    setInterval: (cb, ms) => {
      const handle = nextHandle++;
      intervals.set(handle, { cb, ms });
      return handle;
    },
    clearInterval: (handle) => {
      intervals.delete(handle);
    },
  };

  return {
    environment,
    advance: (ms: number) => {
      time += ms;
    },
    /** Deliver a fix to every live watch. */
    deliver: (f: PositionFix) => {
      for (const watch of [...watches.values()]) watch.onFix(f);
    },
    /** Deliver to a watch by id, even one that has since been cleared. */
    deliverToWatch: (id: number, f: PositionFix, all: Map<number, unknown> = watches) => {
      void all;
      const watch = watches.get(id);
      watch?.onFix(f);
    },
    fail: (code: number, message = "nope") => {
      for (const watch of [...watches.values()]) watch.onFailure({ code, message });
    },
    /** A callback captured while a watch was live, invoked after it was cleared. */
    captureCallbacks: () => [...watches.values()],
    get liveWatches() {
      return watches.size;
    },
    get wakeLocks() {
      return wakeLocks;
    },
    set wakeLockSupported(value: boolean) {
      wakeLockSupported = value;
    },
    set deferWakeLock(value: boolean) {
      deferWakeLock = value;
    },
    resolveWakeLock: () => {
      pendingWakeLock?.(undefined);
      pendingWakeLock = undefined;
    },
    set watchThrows(value: boolean) {
      watchThrows = value;
    },
  };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

describe("recording", () => {
  it("keeps fixes that pass sampling and emits each one", async () => {
    const env = createTestEnvironment();
    const recorder = createWebTrackRecorderInternal({}, env.environment);
    const emitted: TrackPoint[] = [];
    recorder.onPoint((p) => emitted.push(p));

    await recorder.start();
    env.deliver(fix(0, T0));
    env.deliver(fix(50, T0 + 5000));
    env.deliver(fix(100, T0 + 10_000));

    const track = await recorder.stop();
    expect(track.points).toHaveLength(3);
    expect(emitted).toHaveLength(3);
    expect(emitted).toEqual(track.points);
  });

  it("drops a fix the accuracy filter rejects", async () => {
    const env = createTestEnvironment();
    const recorder = createWebTrackRecorderInternal({}, env.environment);
    const emitted: TrackPoint[] = [];
    recorder.onPoint((p) => emitted.push(p));

    await recorder.start();
    env.deliver(fix(0, T0, 5));
    env.deliver(fix(500, T0 + 5000, 500)); // far, but wildly inaccurate
    env.deliver(fix(100, T0 + 10_000, 5));

    const track = await recorder.stop();
    expect(track.points).toHaveLength(2);
    expect(emitted).toHaveLength(2);
  });

  it("drops a fix that has not moved far enough or waited long enough", async () => {
    const env = createTestEnvironment();
    const recorder = createWebTrackRecorderInternal({}, env.environment);

    await recorder.start();
    env.deliver(fix(0, T0));
    env.deliver(fix(2, T0 + 1000)); // 2 m in 1 s: too close, too soon
    env.deliver(fix(4, T0 + 2000));

    expect((await recorder.stop()).points).toHaveLength(1);
  });

  it("carries altitude, accuracy, speed and heading through", async () => {
    const env = createTestEnvironment();
    const recorder = createWebTrackRecorderInternal({}, env.environment);

    await recorder.start();
    env.deliver({
      coords: {
        latitude: ORIGIN.lat,
        longitude: ORIGIN.lng,
        accuracy: 4,
        altitude: 42,
        altitudeAccuracy: 3,
        speed: 1.5,
        heading: 90,
      },
      timestamp: T0,
    });

    const [point] = (await recorder.stop()).points;
    expect(point).toMatchObject({
      accuracyM: 4,
      altitudeM: 42,
      altitudeAccuracyM: 3,
      speedMps: 1.5,
      headingDeg: 90,
    });
  });

  it("treats a null coordinate field as absent, not as zero", async () => {
    const env = createTestEnvironment();
    const recorder = createWebTrackRecorderInternal({}, env.environment);

    await recorder.start();
    env.deliver({
      coords: {
        latitude: ORIGIN.lat,
        longitude: ORIGIN.lng,
        accuracy: 4,
        altitude: null,
        speed: null,
        heading: null,
      },
      timestamp: T0,
    });

    const [point] = (await recorder.stop()).points;
    expect(point?.altitudeM).toBeUndefined();
    expect(point?.speedMps).toBeUndefined();
    expect(point?.headingDeg).toBeUndefined();
  });

  it("honours a sampling policy passed to start", async () => {
    const env = createTestEnvironment();
    const recorder = createWebTrackRecorderInternal({}, env.environment);

    await recorder.start({ minDistanceM: 1 });
    env.deliver(fix(0, T0));
    env.deliver(fix(3, T0 + 1000)); // 3 m clears a 1 m minimum

    expect((await recorder.stop()).points).toHaveLength(2);
  });
});

describe("a stale fix is dropped, not reordered (ADR-0020)", () => {
  it("rejects a fix older than the last kept point even when sampling would accept it", async () => {
    // The exact case the layer split exists for: 500 m away, so distance would admit it,
    // but its clock reads earlier than the point already kept. `sample()` deliberately does
    // not judge sequence, and `finalizeTrack` would refuse the resulting track — so the
    // recorder, which is the layer that received it, drops it here.
    const env = createTestEnvironment();
    const recorder = createWebTrackRecorderInternal({}, env.environment);
    const emitted: TrackPoint[] = [];
    recorder.onPoint((p) => emitted.push(p));

    await recorder.start();
    env.deliver(fix(0, T0));
    env.deliver(fix(500, T0 + 60_000));
    env.deliver(fix(1000, T0 + 30_000)); // far enough, but late

    const track = await recorder.stop();

    expect(track.points).toHaveLength(2);
    expect(emitted).toHaveLength(2);
    expect(track.points.map((p) => p.t)).toEqual([T0, T0 + 60_000]);

    // And the track still finalizes, which is the whole point.
    expect(() => assertValidTrackGeometry(track)).not.toThrow();
    expect(track.status).toBe("finalized");
  });

  it("accepts a fix sharing the last kept timestamp — the invariant is non-decreasing", async () => {
    const env = createTestEnvironment();
    const recorder = createWebTrackRecorderInternal({}, env.environment);

    await recorder.start();
    env.deliver(fix(0, T0));
    env.deliver(fix(500, T0)); // same millisecond, moved far

    const track = await recorder.stop();
    expect(track.points).toHaveLength(2);
    expect(() => assertValidTrackGeometry(track)).not.toThrow();
  });

  it("compares against the last kept point globally, across a pause", async () => {
    // The comparison is not per segment: a fix that predates a point kept before the pause
    // is stale whichever segment it arrives in.
    const env = createTestEnvironment();
    const recorder = createWebTrackRecorderInternal({}, env.environment);

    await recorder.start();
    env.deliver(fix(0, T0));
    env.deliver(fix(500, T0 + 60_000));
    recorder.pause();
    recorder.resume();
    env.deliver(fix(2000, T0 + 30_000)); // older than the pre-pause point
    env.deliver(fix(2500, T0 + 90_000));

    const track = await recorder.stop();
    expect(track.points.map((p) => p.t)).toEqual([T0, T0 + 60_000, T0 + 90_000]);
    expect(() => assertValidTrackGeometry(track)).not.toThrow();
  });

  it("survives a burst of out-of-order fixes and still finalizes", async () => {
    const env = createTestEnvironment();
    const recorder = createWebTrackRecorderInternal({}, env.environment);

    await recorder.start();
    const offsets = [0, 60_000, 10_000, 120_000, 30_000, 180_000, 90_000];
    for (const [i, offset] of offsets.entries()) env.deliver(fix(i * 500, T0 + offset));

    const track = await recorder.stop();
    const times = track.points.map((p) => p.t);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(() => assertValidTrackGeometry(track)).not.toThrow();
  });
});

describe("segments", () => {
  it("produces one segment for an uninterrupted recording", async () => {
    const env = createTestEnvironment();
    const recorder = createWebTrackRecorderInternal({}, env.environment);

    await recorder.start();
    for (let i = 0; i < 4; i += 1) env.deliver(fix(i * 100, T0 + i * 10_000));

    const track = await recorder.stop();
    expect(track.segments).toHaveLength(1);
    expect(track.segments[0]).toMatchObject({ startIndex: 0, endIndex: 3 });
  });

  it("opens a new segment on resume, so a pause is a gap", async () => {
    const env = createTestEnvironment();
    const recorder = createWebTrackRecorderInternal({}, env.environment);

    await recorder.start();
    env.deliver(fix(0, T0));
    env.deliver(fix(100, T0 + 10_000));
    recorder.pause();
    recorder.resume();
    env.deliver(fix(5000, T0 + 3_600_000));
    env.deliver(fix(5100, T0 + 3_610_000));

    const track = await recorder.stop();
    expect(track.segments.map((s) => [s.startIndex, s.endIndex])).toEqual([
      [0, 1],
      [2, 3],
    ]);
    // The pause is not travelled: distance skips the gap.
    expect(track.stats?.distanceM).toBeCloseTo(200, 0);
    expect(track.stats?.movingTimeMs).toBe(20_000);
  });

  it("keeps no fixes while paused", async () => {
    const env = createTestEnvironment();
    const recorder = createWebTrackRecorderInternal({}, env.environment);

    await recorder.start();
    env.deliver(fix(0, T0));
    recorder.pause();
    env.deliver(fix(500, T0 + 10_000)); // no live watch to deliver to
    recorder.resume();
    env.deliver(fix(1000, T0 + 20_000));

    expect((await recorder.stop()).points).toHaveLength(2);
  });

  it("does not create an empty segment when a pause caught no fixes", async () => {
    const env = createTestEnvironment();
    const recorder = createWebTrackRecorderInternal({}, env.environment);

    await recorder.start();
    recorder.pause();
    recorder.resume();
    env.deliver(fix(0, T0));

    const track = await recorder.stop();
    expect(track.segments).toHaveLength(1);
    expect(() => assertValidTrackGeometry(track)).not.toThrow();
  });

  it("survives several pause and resume cycles", async () => {
    const env = createTestEnvironment();
    const recorder = createWebTrackRecorderInternal({}, env.environment);

    await recorder.start();
    for (let cycle = 0; cycle < 3; cycle += 1) {
      env.deliver(fix(cycle * 1000, T0 + cycle * 100_000));
      env.deliver(fix(cycle * 1000 + 100, T0 + cycle * 100_000 + 10_000));
      recorder.pause();
      recorder.resume();
    }

    const track = await recorder.stop();
    expect(track.segments).toHaveLength(3);
    expect(() => assertValidTrackGeometry(track)).not.toThrow();
  });

  it("ignores pause when not recording and resume when not paused", async () => {
    const env = createTestEnvironment();
    const recorder = createWebTrackRecorderInternal({}, env.environment);

    recorder.pause();
    recorder.resume();
    await recorder.start();
    recorder.resume(); // already recording
    env.deliver(fix(0, T0));
    recorder.pause();
    recorder.pause(); // already paused

    expect((await recorder.stop()).points).toHaveLength(1);
  });
});

describe("laps", () => {
  it("produces none unless markLap is called", async () => {
    const env = createTestEnvironment();
    const recorder = createWebTrackRecorderInternal({}, env.environment);

    await recorder.start();
    env.deliver(fix(0, T0));
    env.deliver(fix(100, T0 + 10_000));

    expect((await recorder.stop()).laps).toBeUndefined();
  });

  it("splits at the latest kept point and closes the final lap on stop", async () => {
    const env = createTestEnvironment();
    const recorder = createWebTrackRecorderInternal({}, env.environment);

    await recorder.start();
    env.deliver(fix(0, T0));
    env.deliver(fix(100, T0 + 10_000));
    recorder.markLap("First");
    env.deliver(fix(200, T0 + 20_000));
    env.deliver(fix(300, T0 + 30_000));

    const track = await recorder.stop();
    expect(track.laps?.map((l) => [l.startIndex, l.endIndex])).toEqual([
      [0, 1],
      [2, 3],
    ]);
    expect(track.laps?.[0]?.label).toBe("First");
    expect(track.laps?.map((l) => l.index)).toEqual([0, 1]);
  });

  it("gives every lap its own statistics", async () => {
    const env = createTestEnvironment();
    const recorder = createWebTrackRecorderInternal({}, env.environment);

    await recorder.start();
    env.deliver(fix(0, T0));
    env.deliver(fix(100, T0 + 10_000));
    recorder.markLap();
    env.deliver(fix(400, T0 + 20_000));

    const track = await recorder.stop();
    expect(track.laps?.[0]?.stats?.distanceM).toBeCloseTo(100, 0);
    expect(track.laps?.[1]?.stats?.distanceM).toBeCloseTo(0, 0);
  });

  it("ignores a lap marked with nothing recorded since the last one", async () => {
    const env = createTestEnvironment();
    const recorder = createWebTrackRecorderInternal({}, env.environment);

    await recorder.start();
    env.deliver(fix(0, T0));
    recorder.markLap();
    recorder.markLap(); // nothing new
    recorder.markLap();

    expect((await recorder.stop()).laps).toHaveLength(1);
  });

  it("lets a lap cross a pause", async () => {
    const env = createTestEnvironment();
    const recorder = createWebTrackRecorderInternal({}, env.environment);

    await recorder.start();
    env.deliver(fix(0, T0));
    recorder.pause();
    recorder.resume();
    env.deliver(fix(5000, T0 + 3_600_000));
    recorder.markLap();

    const track = await recorder.stop();
    expect(track.laps?.[0]).toMatchObject({ startIndex: 0, endIndex: 1 });
    // Elapsed spans the pause; moving time does not.
    expect(track.laps?.[0]?.stats?.movingTimeMs).toBe(0);
  });
});

describe("the wake lock", () => {
  it("is acquired on start and released on stop", async () => {
    const env = createTestEnvironment();
    const recorder = createWebTrackRecorderInternal({}, env.environment);

    await recorder.start();
    await flush();
    expect(env.wakeLocks).toHaveLength(1);
    expect(env.wakeLocks[0]?.released).toBe(false);

    await recorder.stop();
    await flush();
    expect(env.wakeLocks[0]?.released).toBe(true);
  });

  it("is released on pause and taken again on resume", async () => {
    const env = createTestEnvironment();
    const recorder = createWebTrackRecorderInternal({}, env.environment);

    await recorder.start();
    await flush();
    recorder.pause();
    await flush();
    expect(env.wakeLocks[0]?.released).toBe(true);

    recorder.resume();
    await flush();
    expect(env.wakeLocks).toHaveLength(2);
    expect(env.wakeLocks[1]?.released).toBe(false);
  });

  it("records without one where the browser has no wake lock", async () => {
    const env = createTestEnvironment();
    env.wakeLockSupported = false;
    const recorder = createWebTrackRecorderInternal({}, env.environment);

    await recorder.start();
    await flush();
    env.deliver(fix(0, T0));

    expect((await recorder.stop()).points).toHaveLength(1);
    expect(env.wakeLocks).toHaveLength(0);
  });

  it("releases a lock that resolves after the recording stopped", async () => {
    // The race a generation token closes: request → stop → request resolves. Holding it
    // would keep the screen awake for a recording that ended.
    const env = createTestEnvironment();
    env.deferWakeLock = true;
    const recorder = createWebTrackRecorderInternal({}, env.environment);

    await recorder.start();
    await recorder.stop();

    env.resolveWakeLock();
    await flush();

    expect(env.wakeLocks[0]?.released).toBe(true);
  });
});

describe("late callbacks from an obsolete watch", () => {
  it("ignores a fix delivered after stop", async () => {
    const env = createTestEnvironment();
    const recorder = createWebTrackRecorderInternal({}, env.environment);
    const emitted: TrackPoint[] = [];
    recorder.onPoint((p) => emitted.push(p));

    await recorder.start();
    const [watch] = env.captureCallbacks();
    env.deliver(fix(0, T0));
    const track = await recorder.stop();

    watch?.onFix(fix(500, T0 + 60_000)); // queued before the watch was cleared

    expect(track.points).toHaveLength(1);
    expect(emitted).toHaveLength(1);
  });

  it("ignores a fix from the watch that was live before a pause", async () => {
    const env = createTestEnvironment();
    const recorder = createWebTrackRecorderInternal({}, env.environment);

    await recorder.start();
    const [oldWatch] = env.captureCallbacks();
    env.deliver(fix(0, T0));
    recorder.pause();
    recorder.resume();

    oldWatch?.onFix(fix(500, T0 + 60_000)); // from the previous generation
    env.deliver(fix(1000, T0 + 120_000)); // from the current one

    const track = await recorder.stop();
    expect(track.points.map((p) => p.t)).toEqual([T0, T0 + 120_000]);
  });

  it("ignores an error from an obsolete watch", async () => {
    const env = createTestEnvironment();
    const recorder = createWebTrackRecorderInternal({}, env.environment);
    const errors: TrackRecorderError[] = [];
    recorder.onError((e) => errors.push(e));

    await recorder.start();
    const [oldWatch] = env.captureCallbacks();
    recorder.pause();

    oldWatch?.onFailure({ code: POSITION_ERROR.timeout, message: "late" });
    expect(errors).toEqual([]);
  });

  it("clears the watch on pause and on stop", async () => {
    const env = createTestEnvironment();
    const recorder = createWebTrackRecorderInternal({}, env.environment);

    await recorder.start();
    expect(env.liveWatches).toBe(1);
    recorder.pause();
    expect(env.liveWatches).toBe(0);

    recorder.resume();
    expect(env.liveWatches).toBe(1);
    await recorder.stop();
    expect(env.liveWatches).toBe(0);
  });
});

describe("errors", () => {
  const cases: [number, TrackRecorderError["kind"]][] = [
    [POSITION_ERROR.permissionDenied, "permission-denied"],
    [POSITION_ERROR.positionUnavailable, "position-unavailable"],
    [POSITION_ERROR.timeout, "timeout"],
    [99, "position-unavailable"],
  ];

  it.each(cases)("maps geolocation code %s to %s", async (code, kind) => {
    const env = createTestEnvironment();
    const recorder = createWebTrackRecorderInternal({}, env.environment);
    const errors: TrackRecorderError[] = [];
    recorder.onError((e) => errors.push(e));

    await recorder.start();
    env.fail(code, "the message");

    expect(errors[0]).toEqual({ kind, message: "the message" });
  });

  it("reports an unavailable geolocation as unsupported", async () => {
    const env = createTestEnvironment();
    env.watchThrows = true;
    const recorder = createWebTrackRecorderInternal({}, env.environment);
    const errors: TrackRecorderError[] = [];
    recorder.onError((e) => errors.push(e));

    await recorder.start();
    expect(errors[0]?.kind).toBe("unsupported");
  });

  it("keeps recording after a transient failure", async () => {
    const env = createTestEnvironment();
    const recorder = createWebTrackRecorderInternal({}, env.environment);

    await recorder.start();
    env.deliver(fix(0, T0));
    env.fail(POSITION_ERROR.timeout);
    env.deliver(fix(500, T0 + 60_000));

    expect((await recorder.stop()).points).toHaveLength(2);
  });

  it("stops delivering to an unsubscribed listener", async () => {
    const env = createTestEnvironment();
    const recorder = createWebTrackRecorderInternal({}, env.environment);
    const emitted: TrackPoint[] = [];
    const off = recorder.onPoint((p) => emitted.push(p));

    await recorder.start();
    env.deliver(fix(0, T0));
    off();
    env.deliver(fix(500, T0 + 60_000));

    expect(emitted).toHaveLength(1);
  });
});

describe("lifecycle", () => {
  it("reports its status", async () => {
    const env = createTestEnvironment();
    const recorder = createWebTrackRecorderInternal({}, env.environment);

    await recorder.start();
    expect(recorder.status).toBe("recording");
    recorder.pause();
    expect(recorder.status).toBe("paused");
    recorder.resume();
    expect(recorder.status).toBe("recording");
    await recorder.stop();
    expect(recorder.status).toBe("finalized");
  });

  it("treats a second start as a no-op rather than a second watch", async () => {
    const env = createTestEnvironment();
    const recorder = createWebTrackRecorderInternal({}, env.environment);

    await recorder.start();
    await recorder.start();

    expect(env.liveWatches).toBe(1);
    env.deliver(fix(0, T0));
    expect((await recorder.stop()).points).toHaveLength(1); // not doubled
  });

  it("refuses to restart after producing a track", async () => {
    const env = createTestEnvironment();
    const recorder = createWebTrackRecorderInternal({}, env.environment);

    await recorder.start();
    await recorder.stop();

    await expect(recorder.start()).rejects.toThrow(/create another/);
  });

  it("finalizes an empty recording without throwing", async () => {
    const env = createTestEnvironment();
    const recorder = createWebTrackRecorderInternal({}, env.environment);

    await recorder.start();
    const track = await recorder.stop();

    expect(track.points).toEqual([]);
    expect(track.segments).toEqual([]);
    expect(track.status).toBe("finalized");
    expect(() => assertValidTrackGeometry(track)).not.toThrow();
  });

  it("marks the track as recorded", async () => {
    const env = createTestEnvironment();
    const recorder = createWebTrackRecorderInternal({}, env.environment);

    await recorder.start();
    env.deliver(fix(0, T0));

    expect((await recorder.stop()).origin).toBe("recorded");
  });
});
