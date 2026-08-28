// SPDX-License-Identifier: Apache-2.0
import type { StorageAdapter, Track, TrackRecorderError } from "@mapatlas/core";
import { recoverInterruptedTrack } from "@mapatlas/core";
import { createFakeSensorSource, createMemoryStorageAdapter } from "@mapatlas/core/testing";
import { describe, expect, it } from "vitest";

import type { PositionFix, WebRecorderEnvironment } from "./environment.js";
import { RecorderResumeError, createWebTrackRecorderInternal } from "./recorder.js";

const T0 = 1_700_000_000_000;
const ORIGIN = { lat: 59.33, lng: 18.06 };
const DEG_PER_M = 1 / 111_195;

const fix = (metresNorth: number, t: number, accuracy = 5): PositionFix => ({
  coords: { latitude: ORIGIN.lat + metresNorth * DEG_PER_M, longitude: ORIGIN.lng, accuracy },
  timestamp: t,
});

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

function createTestEnvironment(startAt = T0) {
  let time = startAt;
  let nextWatchId = 1;
  const watches = new Map<number, { onFix: (f: PositionFix) => void }>();
  const intervals = new Map<unknown, () => void>();
  let nextHandle = 1;

  const environment: WebRecorderEnvironment = {
    now: () => time,
    watchPosition: (onFix) => {
      const id = nextWatchId++;
      watches.set(id, { onFix });
      return id;
    },
    clearWatch: (id) => {
      watches.delete(id);
    },
    requestWakeLock: () => Promise.resolve(undefined),
    setInterval: (cb) => {
      const handle = nextHandle++;
      intervals.set(handle, cb);
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
    deliver: (f: PositionFix) => {
      for (const watch of [...watches.values()]) watch.onFix(f);
    },
    /** Fire every live autosave interval once. */
    tick: () => {
      for (const cb of [...intervals.values()]) cb();
    },
    get liveTimers() {
      return intervals.size;
    },
  };
}

/** A store that records what it was asked to save, and can be made slow or broken. */
function instrumentedStore() {
  const inner = createMemoryStorageAdapter();
  const saves: Track[] = [];
  let gate: (() => void) | undefined;
  let failNext = 0;

  const store: StorageAdapter = {
    ...inner,
    saveTrack: async (track) => {
      if (failNext > 0) {
        failNext -= 1;
        throw new Error("quota exceeded");
      }
      if (gate !== undefined) {
        const release = gate;
        gate = undefined;
        await new Promise<void>((resolve) => {
          release();
          resolve();
        });
      }
      saves.push(structuredClone(track));
      await inner.saveTrack(track);
    },
  };

  return {
    store,
    saves,
    inner,
    breakNext: (count = 1) => {
      failNext = count;
    },
  };
}

describe("autosave", () => {
  it("writes an unfinalized snapshot on each tick", async () => {
    const env = createTestEnvironment();
    const { store, saves } = instrumentedStore();
    const recorder = createWebTrackRecorderInternal({ store, autosaveMs: 10_000 }, env.environment);

    await recorder.start();
    env.deliver(fix(0, T0));
    env.tick();
    await flush();

    expect(saves).toHaveLength(1);
    const snapshot = saves[0];
    expect(snapshot?.status).toBe("recording");
    expect(snapshot?.origin).toBe("recorded");
    expect(snapshot?.points).toHaveLength(1);
    // Derived data is deliberately absent: it costs a full pass and nobody reads it yet.
    expect(snapshot?.stats).toBeUndefined();
    expect(snapshot?.simplifiedSegments).toBeUndefined();
    expect(snapshot?.endedAt).toBeUndefined();
  });

  it("does nothing without a store or an interval", async () => {
    const env = createTestEnvironment();
    const recorder = createWebTrackRecorderInternal({ autosaveMs: 1000 }, env.environment);

    await recorder.start();
    expect(env.liveTimers).toBe(0);

    const { store } = instrumentedStore();
    const other = createWebTrackRecorderInternal({ store, autosaveMs: 0 }, env.environment);
    await other.start();
    expect(env.liveTimers).toBe(0);
  });

  it("includes the segment still open, with its stable id", async () => {
    const env = createTestEnvironment();
    const { store, saves } = instrumentedStore();
    const recorder = createWebTrackRecorderInternal({ store, autosaveMs: 10_000 }, env.environment);

    await recorder.start();
    env.deliver(fix(0, T0));
    env.tick();
    await flush();
    env.deliver(fix(500, T0 + 60_000));
    env.tick();
    await flush();

    expect(saves[0]?.segments[0]).toMatchObject({ startIndex: 0, endIndex: 0 });
    expect(saves[1]?.segments[0]).toMatchObject({ startIndex: 0, endIndex: 1 });
    // The same segment grew; it was not replaced by a new one.
    expect(saves[1]?.segments[0]?.id).toBe(saves[0]?.segments[0]?.id);
  });

  it("carries one canonical startedAt through every snapshot and the final track", async () => {
    const env = createTestEnvironment();
    const { store, saves } = instrumentedStore();
    const recorder = createWebTrackRecorderInternal({ store, autosaveMs: 10_000 }, env.environment);

    await recorder.start(); // startedAt = T0
    env.tick(); // a snapshot before any fix arrives
    await flush();
    env.deliver(fix(0, T0 + 30_000)); // first point is much later
    env.tick();
    await flush();

    const track = await recorder.stop();
    expect(saves[0]?.startedAt).toBe(T0);
    expect(saves[1]?.startedAt).toBe(T0);
    expect(track.startedAt).toBe(T0);
  });

  it("declares its channels so a recovered snapshot can describe them", async () => {
    const env = createTestEnvironment();
    const { store, saves } = instrumentedStore();
    const sensor = createFakeSensorSource({
      id: "hr",
      channels: [{ key: "heartRateBpm", label: "Heart rate", unit: "bpm" }],
    });
    const recorder = createWebTrackRecorderInternal(
      { store, autosaveMs: 10_000, sensors: [sensor] },
      env.environment,
    );

    await recorder.start();
    env.tick();
    await flush();

    expect(saves[0]?.channels).toEqual([{ key: "heartRateBpm", label: "Heart rate", unit: "bpm" }]);
  });

  it("derives lap index and timing but not lap statistics", async () => {
    const env = createTestEnvironment();
    const { store, saves } = instrumentedStore();
    const recorder = createWebTrackRecorderInternal({ store, autosaveMs: 10_000 }, env.environment);

    await recorder.start();
    env.deliver(fix(0, T0));
    env.deliver(fix(500, T0 + 60_000));
    recorder.markLap("First");
    env.tick();
    await flush();

    const lap = saves[0]?.laps?.[0];
    expect(lap).toMatchObject({ index: 0, startIndex: 0, endIndex: 1, label: "First" });
    expect(lap?.startedAt).toBe(T0);
    expect(lap?.endedAt).toBe(T0 + 60_000);
    expect(lap?.stats).toBeUndefined();
  });

  it("stops writing once the recording ends", async () => {
    const env = createTestEnvironment();
    const { store, saves } = instrumentedStore();
    const recorder = createWebTrackRecorderInternal({ store, autosaveMs: 10_000 }, env.environment);

    await recorder.start();
    env.deliver(fix(0, T0));
    await recorder.stop();
    await flush();

    const afterStop = saves.length;
    env.tick();
    await flush();

    expect(env.liveTimers).toBe(0);
    expect(saves).toHaveLength(afterStop);
  });
});

describe("a paused recording is flushed immediately", () => {
  it("writes a paused snapshot without waiting for the next tick", async () => {
    // A pause is often the last thing before an app is backgrounded and killed, which is
    // exactly when the interval is least likely to fire again.
    const env = createTestEnvironment();
    const { store, saves } = instrumentedStore();
    const recorder = createWebTrackRecorderInternal({ store, autosaveMs: 10_000 }, env.environment);

    await recorder.start();
    env.deliver(fix(0, T0));
    recorder.pause();
    await flush();

    expect(saves).toHaveLength(1);
    expect(saves[0]?.status).toBe("paused");
  });

  it("keeps the timer alive while paused", async () => {
    const env = createTestEnvironment();
    const { store, saves } = instrumentedStore();
    const recorder = createWebTrackRecorderInternal({ store, autosaveMs: 10_000 }, env.environment);

    await recorder.start();
    env.deliver(fix(0, T0));
    recorder.pause();
    await flush();

    expect(env.liveTimers).toBe(1);
    env.tick();
    await flush();
    expect(saves.length).toBeGreaterThan(1);
    expect(saves.at(-1)?.status).toBe("paused");
  });

  it("closes the open segment in the paused snapshot", async () => {
    const env = createTestEnvironment();
    const { store, saves } = instrumentedStore();
    const recorder = createWebTrackRecorderInternal({ store, autosaveMs: 10_000 }, env.environment);

    await recorder.start();
    env.deliver(fix(0, T0));
    env.deliver(fix(500, T0 + 60_000));
    recorder.pause();
    await flush();

    expect(saves[0]?.segments).toHaveLength(1);
    expect(saves[0]?.segments[0]).toMatchObject({ startIndex: 0, endIndex: 1 });
  });
});

describe("writes are serialized", () => {
  it("keeps sequence across pause, resume, tick and stop", async () => {
    const env = createTestEnvironment();
    const { store, saves } = instrumentedStore();
    const recorder = createWebTrackRecorderInternal({ store, autosaveMs: 10_000 }, env.environment);

    await recorder.start();
    env.deliver(fix(0, T0));
    recorder.pause();
    recorder.resume();
    env.deliver(fix(500, T0 + 60_000));
    env.tick();
    const track = await recorder.stop();
    await flush();

    // Whatever else was written, the finished track is last and nothing follows it.
    expect(saves.at(-1)?.status).toBe("finalized");
    expect(saves.at(-1)?.id).toBe(track.id);
    expect(saves.filter((s) => s.status === "finalized")).toHaveLength(1);
  });

  it("never leaves an older snapshot on top of the finished track", async () => {
    const env = createTestEnvironment();
    const { store } = instrumentedStore();
    const recorder = createWebTrackRecorderInternal({ store, autosaveMs: 10_000 }, env.environment);

    await recorder.start();
    env.deliver(fix(0, T0));
    env.tick();
    env.tick();
    const track = await recorder.stop();
    await flush();

    const stored = await store.getTrack(track.id);
    expect(stored?.status).toBe("finalized");
    expect(stored?.stats).toBeDefined();
  });

  it("writes every snapshot under one id, overwriting a single record", async () => {
    const env = createTestEnvironment();
    const { store, saves } = instrumentedStore();
    const recorder = createWebTrackRecorderInternal({ store, autosaveMs: 10_000 }, env.environment);

    await recorder.start();
    for (let i = 0; i < 4; i += 1) {
      env.deliver(fix(i * 500, T0 + i * 60_000));
      env.tick();
      await flush();
    }
    const track = await recorder.stop();
    await flush();

    expect(new Set(saves.map((s) => s.id)).size).toBe(1);
    expect(saves[0]?.id).toBe(track.id);
    expect(await store.listTrackSummaries()).toHaveLength(1);
  });

  it("returns one track and saves once when stop is called concurrently", async () => {
    const env = createTestEnvironment();
    const { store, saves } = instrumentedStore();
    const recorder = createWebTrackRecorderInternal({ store, autosaveMs: 10_000 }, env.environment);

    await recorder.start();
    env.deliver(fix(0, T0));

    const [a, b, c] = await Promise.all([recorder.stop(), recorder.stop(), recorder.stop()]);

    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(saves.filter((s) => s.status === "finalized")).toHaveLength(1);
  });
});

describe("a failed write", () => {
  it("surfaces as a storage error and does not stop the recording", async () => {
    const env = createTestEnvironment();
    const broken = instrumentedStore();
    const recorder = createWebTrackRecorderInternal(
      { store: broken.store, autosaveMs: 10_000 },
      env.environment,
    );
    const errors: TrackRecorderError[] = [];
    recorder.onError((error) => errors.push(error));

    await recorder.start();
    env.deliver(fix(0, T0));
    broken.breakNext();
    env.tick();
    await flush();

    expect(errors).toEqual([{ kind: "storage", message: "quota exceeded" }]);

    // The recording carries on, and the next autosave succeeds.
    env.deliver(fix(500, T0 + 60_000));
    env.tick();
    await flush();
    expect(broken.saves).toHaveLength(1);
    expect((await recorder.stop()).points).toHaveLength(2);
  });

  it("does not poison the queue behind it", async () => {
    const env = createTestEnvironment();
    const broken = instrumentedStore();
    const recorder = createWebTrackRecorderInternal(
      { store: broken.store, autosaveMs: 10_000 },
      env.environment,
    );
    recorder.onError(() => undefined);

    await recorder.start();
    env.deliver(fix(0, T0));
    broken.breakNext(2);
    env.tick();
    await flush();
    env.tick();
    await flush();
    env.tick();
    await flush();

    expect(broken.saves).toHaveLength(1); // the third attempt got through
  });

  it("rejects stop when the final save fails, and can be retried", async () => {
    const env = createTestEnvironment();
    const broken = instrumentedStore();
    const recorder = createWebTrackRecorderInternal(
      { store: broken.store, autosaveMs: 10_000 },
      env.environment,
    );

    await recorder.start();
    env.deliver(fix(0, T0));
    broken.breakNext();

    await expect(recorder.stop()).rejects.toThrow(/quota exceeded/);

    // The finalized track is memoized, so a retry re-attempts the write rather than
    // rebuilding it or losing the trip.
    const track = await recorder.stop();
    expect(track.points).toHaveLength(1);
    expect(broken.saves.at(-1)?.status).toBe("finalized");
  });
});

describe("recovery and resumption", () => {
  async function crashedRecording(): Promise<{ store: StorageAdapter; snapshot: Track }> {
    const env = createTestEnvironment();
    const store = createMemoryStorageAdapter();
    const recorder = createWebTrackRecorderInternal({ store, autosaveMs: 10_000 }, env.environment);

    await recorder.start();
    env.deliver(fix(0, T0));
    env.deliver(fix(500, T0 + 60_000));
    env.tick();
    await flush();
    // ...and the tab dies here: no stop(), no finalization.

    const snapshot = await recoverInterruptedTrack(store);
    if (snapshot === undefined) throw new Error("nothing to recover");
    return { store, snapshot };
  }

  it("leaves a recoverable snapshot behind", async () => {
    const { snapshot } = await crashedRecording();
    expect(snapshot.status).toBe("recording");
    expect(snapshot.points).toHaveLength(2);
  });

  it("continues the same track rather than starting a second one", async () => {
    const { store, snapshot } = await crashedRecording();
    const env = createTestEnvironment(T0 + 3_600_000);
    const recorder = createWebTrackRecorderInternal(
      { store, autosaveMs: 10_000, resumeFrom: snapshot },
      env.environment,
    );

    await recorder.start();
    env.deliver(fix(5000, T0 + 3_600_000));
    const track = await recorder.stop();
    await flush();

    expect(track.id).toBe(snapshot.id);
    expect(track.startedAt).toBe(snapshot.startedAt);
    expect(track.points).toHaveLength(3);
    expect(await store.listTrackSummaries()).toHaveLength(1);
  });

  it("always opens a new segment, because the crash interval was never observed", async () => {
    const { store, snapshot } = await crashedRecording();
    const env = createTestEnvironment(T0 + 3_600_000);
    const recorder = createWebTrackRecorderInternal(
      { store, resumeFrom: snapshot },
      env.environment,
    );

    await recorder.start();
    env.deliver(fix(5000, T0 + 3_600_000));
    const track = await recorder.stop();

    expect(track.segments.map((s) => [s.startIndex, s.endIndex])).toEqual([
      [0, 1],
      [2, 2],
    ]);
    // The gap is not travelled: distance covers the pre-crash leg only, not the 5 km the
    // device moved while nothing was recording.
    expect(track.stats?.distanceM).toBeGreaterThan(490);
    expect(track.stats?.distanceM).toBeLessThan(510);
  });

  it("restores lastKept, so the first post-recovery fix still faces ADR-0020", async () => {
    // The adversarial case: older than the last restored point, but far enough that
    // sample() would take it on distance alone. Without restoring lastKept, recovery would
    // be a hole straight through the stale-fix rule.
    const { store, snapshot } = await crashedRecording();
    const env = createTestEnvironment(T0 + 3_600_000);
    const recorder = createWebTrackRecorderInternal(
      { store, resumeFrom: snapshot },
      env.environment,
    );

    await recorder.start();
    env.deliver(fix(5000, T0 + 30_000)); // 5 km away, but predates the restored point
    const track = await recorder.stop();

    expect(track.points).toHaveLength(2); // nothing added
  });

  it("still accepts a fix sharing the last restored timestamp", async () => {
    const { store, snapshot } = await crashedRecording();
    const env = createTestEnvironment(T0 + 3_600_000);
    const recorder = createWebTrackRecorderInternal(
      { store, resumeFrom: snapshot },
      env.environment,
    );

    await recorder.start();
    env.deliver(fix(5000, T0 + 60_000)); // equal to the last restored point

    expect((await recorder.stop()).points).toHaveLength(3);
  });

  it("carries laps across the crash", async () => {
    const env = createTestEnvironment();
    const store = createMemoryStorageAdapter();
    const first = createWebTrackRecorderInternal({ store, autosaveMs: 10_000 }, env.environment);

    await first.start();
    env.deliver(fix(0, T0));
    env.deliver(fix(500, T0 + 60_000));
    first.markLap("Before the crash");
    env.tick();
    await flush();

    const snapshot = await recoverInterruptedTrack(store);
    if (snapshot === undefined) throw new Error("nothing to recover");

    const resumedEnv = createTestEnvironment(T0 + 3_600_000);
    const second = createWebTrackRecorderInternal(
      { store, resumeFrom: snapshot },
      resumedEnv.environment,
    );

    await second.start();
    resumedEnv.deliver(fix(5000, T0 + 3_600_000));
    second.markLap("After");
    const track = await second.stop();

    expect(track.laps?.map((l) => l.label)).toEqual(["Before the crash", "After"]);
    expect(track.laps?.map((l) => [l.startIndex, l.endIndex])).toEqual([
      [0, 1],
      [2, 2],
    ]);
  });

  it("merges recovered channel descriptors with newly declared ones", async () => {
    const stored: Track = {
      id: "resumed",
      startedAt: T0,
      status: "recording",
      origin: "recorded",
      points: [{ lat: 59.33, lng: 18.06, t: T0 }],
      segments: [{ id: "s", startIndex: 0, endIndex: 0, startedAt: T0 }],
      channels: [{ key: "heartRateBpm", label: "Heart rate", unit: "bpm" }],
    };

    const env = createTestEnvironment(T0 + 1000);
    const depth = createFakeSensorSource({
      id: "depth",
      channels: [{ key: "depthM", label: "Depth", unit: "m" }],
    });
    const recorder = createWebTrackRecorderInternal(
      { resumeFrom: stored, sensors: [depth] },
      env.environment,
    );

    await recorder.start();
    const track = await recorder.stop();

    // Historical descriptor preserved, new key appended.
    expect(track.channels?.map((c) => c.key)).toEqual(["heartRateBpm", "depthM"]);
  });

  it("rejects a conflicting definition for a key already recorded under", async () => {
    // The stored values were recorded under the old definition; adopting a new unit would
    // reinterpret data already on disk.
    const stored: Track = {
      id: "resumed",
      startedAt: T0,
      status: "recording",
      origin: "recorded",
      points: [{ lat: 59.33, lng: 18.06, t: T0 }],
      segments: [{ id: "s", startIndex: 0, endIndex: 0, startedAt: T0 }],
      channels: [{ key: "depthM", label: "Depth", unit: "m" }],
    };

    const env = createTestEnvironment();
    const feet = createFakeSensorSource({
      id: "depth",
      channels: [{ key: "depthM", label: "Depth", unit: "ft" }],
    });

    expect(() =>
      createWebTrackRecorderInternal({ resumeFrom: stored, sensors: [feet] }, env.environment),
    ).toThrow(RecorderResumeError);
  });

  it("rejects a restored track whose timestamps run backwards across a pause", async () => {
    // Stricter than assertValidTrackGeometry, which checks chronology within a segment
    // only: the recorder's own rule spans pauses, so a track like this would validate and
    // then reject every subsequent fix as stale.
    const stored: Track = {
      id: "resumed",
      startedAt: T0,
      status: "paused",
      origin: "recorded",
      points: [
        { lat: 59.33, lng: 18.06, t: T0 + 60_000 },
        { lat: 59.34, lng: 18.07, t: T0 }, // earlier, in the next segment
      ],
      segments: [
        { id: "a", startIndex: 0, endIndex: 0, startedAt: T0 + 60_000 },
        { id: "b", startIndex: 1, endIndex: 1, startedAt: T0 },
      ],
    };

    const env = createTestEnvironment();
    expect(() => createWebTrackRecorderInternal({ resumeFrom: stored }, env.environment)).toThrow(
      RecorderResumeError,
    );
  });

  it("rejects a restored track with malformed geometry", async () => {
    const stored: Track = {
      id: "resumed",
      startedAt: T0,
      status: "recording",
      origin: "recorded",
      points: [{ lat: 59.33, lng: 18.06, t: T0 }],
      segments: [{ id: "a", startIndex: 0, endIndex: 9, startedAt: T0 }],
    };

    const env = createTestEnvironment();
    expect(() => createWebTrackRecorderInternal({ resumeFrom: stored }, env.environment)).toThrow();
  });

  it("does not mutate the snapshot it resumed from", async () => {
    const { store, snapshot } = await crashedRecording();
    const before = structuredClone(snapshot);
    const env = createTestEnvironment(T0 + 3_600_000);
    const recorder = createWebTrackRecorderInternal(
      { store, resumeFrom: snapshot },
      env.environment,
    );

    await recorder.start();
    env.deliver(fix(5000, T0 + 3_600_000));
    await recorder.stop();

    expect(snapshot).toEqual(before);
  });
});
