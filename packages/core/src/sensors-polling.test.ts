// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import type { ChannelDescriptor } from "./channels.js";
import type { Scheduler } from "./sensors-polling.js";
import { createPollingSensorSourceInternal } from "./sensors-polling.js";
import type { SensorSample, SensorSourceError } from "./sensors.js";

const HEART_RATE: ChannelDescriptor = {
  key: "heartRateBpm",
  label: "Heart rate",
  unit: "bpm",
  aggregate: "avg",
};

/** A clock and timer a test drives by hand — no fake timers, no real waiting. */
function createTestScheduler(startAt = 1_000_000) {
  let time = startAt;
  const callbacks = new Map<number, { cb: () => void; intervalMs: number }>();
  let nextHandle = 1;

  return {
    scheduler: {
      now: () => time,
      setInterval: (cb: () => void, intervalMs: number) => {
        const handle = nextHandle++;
        callbacks.set(handle, { cb, intervalMs });
        return handle;
      },
      clearInterval: (handle: unknown) => {
        callbacks.delete(handle as number);
      },
    } satisfies Scheduler,
    /** Advance the clock and fire every registered interval once. */
    tick(byMs = 1000) {
      time += byMs;
      for (const { cb } of [...callbacks.values()]) cb();
    },
    advance(byMs: number) {
      time += byMs;
    },
    get activeTimers() {
      return callbacks.size;
    },
    get time() {
      return time;
    },
  };
}

/** Let queued promise callbacks run. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

describe("construction validates its inputs", () => {
  const scheduler = createTestScheduler().scheduler;
  const ok = { id: "hr", channels: [HEART_RATE], read: () => Promise.resolve({}) };

  it("rejects a non-positive or non-finite interval", () => {
    for (const intervalMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => createPollingSensorSourceInternal({ ...ok, intervalMs }, scheduler)).toThrow(
        RangeError,
      );
    }
  });

  it("rejects duplicate channel descriptor keys", () => {
    expect(() =>
      createPollingSensorSourceInternal(
        { ...ok, intervalMs: 1000, channels: [HEART_RATE, { ...HEART_RATE, label: "Again" }] },
        scheduler,
      ),
    ).toThrow(/duplicate channel descriptor key: heartRateBpm/);
  });
});

describe("polling", () => {
  it("emits a sample per tick, stamped at completion", async () => {
    const clock = createTestScheduler();
    const samples: SensorSample[] = [];
    let beat = 120;

    const source = createPollingSensorSourceInternal(
      {
        id: "hr",
        channels: [HEART_RATE],
        intervalMs: 1000,
        read: () => Promise.resolve({ heartRateBpm: beat++ }),
      },
      clock.scheduler,
    );
    source.onSample((s) => samples.push(s));
    await source.start();

    clock.tick(1000);
    await flush();
    clock.tick(1000);
    await flush();

    expect(samples).toEqual([
      { t: 1_001_000, values: { heartRateBpm: 120 } },
      { t: 1_002_000, values: { heartRateBpm: 121 } },
    ]);
  });

  it("uses the scheduler's clock, not the wall clock", async () => {
    const clock = createTestScheduler(5_000_000);
    const samples: SensorSample[] = [];
    const source = createPollingSensorSourceInternal(
      {
        id: "hr",
        channels: [HEART_RATE],
        intervalMs: 1000,
        read: () => Promise.resolve({ heartRateBpm: 1 }),
      },
      clock.scheduler,
    );
    source.onSample((s) => samples.push(s));
    await source.start();
    clock.tick(1000);
    await flush();

    expect(samples[0]?.t).toBe(5_001_000);
  });

  it("emits nothing when read resolves undefined", async () => {
    const clock = createTestScheduler();
    const samples: SensorSample[] = [];
    const source = createPollingSensorSourceInternal(
      {
        id: "hr",
        channels: [HEART_RATE],
        intervalMs: 1000,
        read: () => Promise.resolve(undefined),
      },
      clock.scheduler,
    );
    source.onSample((s) => samples.push(s));
    await source.start();
    clock.tick(1000);
    await flush();

    expect(samples).toEqual([]);
  });

  it("copies the values it emits, so a consumer's object cannot be mutated later", async () => {
    const clock = createTestScheduler();
    const samples: SensorSample[] = [];
    const shared = { heartRateBpm: 120 };
    const source = createPollingSensorSourceInternal(
      { id: "hr", channels: [HEART_RATE], intervalMs: 1000, read: () => Promise.resolve(shared) },
      clock.scheduler,
    );
    source.onSample((s) => samples.push(s));
    await source.start();
    clock.tick(1000);
    await flush();

    shared.heartRateBpm = 999;
    expect(samples[0]?.values).toEqual({ heartRateBpm: 120 });
  });
});

describe("at most one read is in flight — skip, never queue", () => {
  it("skips ticks while a slow read is still running", async () => {
    const clock = createTestScheduler();
    const samples: SensorSample[] = [];
    let started = 0;
    let resolve: ((v: Record<string, number>) => void) | undefined;

    const source = createPollingSensorSourceInternal(
      {
        id: "slow",
        channels: [HEART_RATE],
        intervalMs: 1000,
        read: () => {
          started += 1;
          return new Promise((r) => {
            resolve = r;
          });
        },
      },
      clock.scheduler,
    );
    source.onSample((s) => samples.push(s));
    await source.start();

    clock.tick(1000); // read starts
    await flush();
    clock.tick(1000); // skipped
    clock.tick(1000); // skipped
    await flush();

    expect(started).toBe(1);
    expect(samples).toEqual([]);

    resolve?.({ heartRateBpm: 130 });
    await flush();

    // Exactly one sample from the one read — no backlog of three catching up.
    expect(samples).toHaveLength(1);

    clock.tick(1000);
    await flush();
    expect(started).toBe(2);
  });

  it("resumes on the next eligible tick after a slow read finishes", async () => {
    const clock = createTestScheduler();
    let started = 0;
    let resolve: ((v: Record<string, number>) => void) | undefined;
    const source = createPollingSensorSourceInternal(
      {
        id: "slow",
        channels: [HEART_RATE],
        intervalMs: 1000,
        read: () => {
          started += 1;
          return new Promise((r) => {
            resolve = r;
          });
        },
      },
      clock.scheduler,
    );
    await source.start();

    clock.tick(1000);
    await flush();
    resolve?.({ heartRateBpm: 1 });
    await flush();
    clock.tick(1000);
    await flush();

    expect(started).toBe(2);
  });
});

describe("errors surface but never stop polling", () => {
  it("reports a rejected read and keeps going", async () => {
    const clock = createTestScheduler();
    const errors: SensorSourceError[] = [];
    const samples: SensorSample[] = [];
    let attempt = 0;

    const source = createPollingSensorSourceInternal(
      {
        id: "flaky",
        channels: [HEART_RATE],
        intervalMs: 1000,
        read: () => {
          attempt += 1;
          return attempt === 1
            ? Promise.reject(new Error("strap disconnected"))
            : Promise.resolve({ heartRateBpm: 140 });
        },
      },
      clock.scheduler,
    );
    source.onError((e) => errors.push(e));
    source.onSample((s) => samples.push(s));
    await source.start();

    clock.tick(1000);
    await flush();
    expect(errors).toEqual([{ kind: "read-failed", message: "flaky: strap disconnected" }]);
    expect(samples).toEqual([]);

    // Losing a strap must not lose the trip: the next tick still runs.
    clock.tick(1000);
    await flush();
    expect(samples).toHaveLength(1);
  });

  it("clears the in-flight flag even when the read throws", async () => {
    const clock = createTestScheduler();
    let started = 0;
    const source = createPollingSensorSourceInternal(
      {
        id: "flaky",
        channels: [HEART_RATE],
        intervalMs: 1000,
        read: () => {
          started += 1;
          return Promise.reject(new Error("boom"));
        },
      },
      clock.scheduler,
    );
    await source.start();

    for (let i = 0; i < 3; i += 1) {
      clock.tick(1000);
      await flush();
    }

    // A stuck flag would have frozen polling after the first failure.
    expect(started).toBe(3);
  });

  it("rejects an undeclared channel rather than storing telemetry nothing can describe", async () => {
    const clock = createTestScheduler();
    const errors: SensorSourceError[] = [];
    const samples: SensorSample[] = [];
    const source = createPollingSensorSourceInternal(
      {
        id: "typo",
        channels: [HEART_RATE],
        intervalMs: 1000,
        // "hearRate" — the typo the descriptor exists to catch.
        read: () => Promise.resolve({ hearRate: 120 }),
      },
      clock.scheduler,
    );
    source.onError((e) => errors.push(e));
    source.onSample((s) => samples.push(s));
    await source.start();
    clock.tick(1000);
    await flush();

    expect(errors[0]?.kind).toBe("read-failed");
    expect(errors[0]?.message).toContain('undeclared channel "hearRate"');
    expect(samples).toEqual([]);
  });

  it("rejects a non-finite value", async () => {
    const clock = createTestScheduler();
    const errors: SensorSourceError[] = [];
    const source = createPollingSensorSourceInternal(
      {
        id: "nan",
        channels: [HEART_RATE],
        intervalMs: 1000,
        read: () => Promise.resolve({ heartRateBpm: Number.NaN }),
      },
      clock.scheduler,
    );
    source.onError((e) => errors.push(e));
    await source.start();
    clock.tick(1000);
    await flush();

    expect(errors[0]?.message).toContain("not a finite number");
  });

  it("accepts a read supplying only some declared channels", async () => {
    const clock = createTestScheduler();
    const samples: SensorSample[] = [];
    const depth: ChannelDescriptor = { key: "depthM", label: "Depth", unit: "m" };
    const source = createPollingSensorSourceInternal(
      {
        id: "partial",
        channels: [HEART_RATE, depth],
        intervalMs: 1000,
        read: () => Promise.resolve({ depthM: 12 }),
      },
      clock.scheduler,
    );
    source.onSample((s) => samples.push(s));
    await source.start();
    clock.tick(1000);
    await flush();

    expect(samples[0]?.values).toEqual({ depthM: 12 });
  });
});

describe("lifecycle", () => {
  it("start is idempotent — a second call does not add a timer", async () => {
    const clock = createTestScheduler();
    const source = createPollingSensorSourceInternal(
      { id: "hr", channels: [HEART_RATE], intervalMs: 1000, read: () => Promise.resolve({}) },
      clock.scheduler,
    );
    await source.start();
    await source.start();
    await source.start();

    expect(clock.activeTimers).toBe(1);
  });

  it("stop is idempotent and clears future ticks immediately", async () => {
    const clock = createTestScheduler();
    let reads = 0;
    const source = createPollingSensorSourceInternal(
      {
        id: "hr",
        channels: [HEART_RATE],
        intervalMs: 1000,
        read: () => {
          reads += 1;
          return Promise.resolve({ heartRateBpm: 1 });
        },
      },
      clock.scheduler,
    );
    await source.start();
    await source.stop();
    await source.stop();

    clock.tick(1000);
    await flush();

    expect(clock.activeTimers).toBe(0);
    expect(reads).toBe(0);
  });

  it("discards a read still in flight when stop happens", async () => {
    const clock = createTestScheduler();
    const samples: SensorSample[] = [];
    let resolve: ((v: Record<string, number>) => void) | undefined;

    const source = createPollingSensorSourceInternal(
      {
        id: "hr",
        channels: [HEART_RATE],
        intervalMs: 1000,
        read: () =>
          new Promise((r) => {
            resolve = r;
          }),
      },
      clock.scheduler,
    );
    source.onSample((s) => samples.push(s));
    await source.start();

    clock.tick(1000);
    await flush();
    await source.stop();

    resolve?.({ heartRateBpm: 150 });
    await flush();

    expect(samples).toEqual([]);
  });

  it("does not let an old session's read contaminate a new one", async () => {
    // read A starts -> stop() -> start() -> read A resolves. Without a generation guard,
    // session A injects a sample into session B.
    const clock = createTestScheduler();
    const samples: SensorSample[] = [];
    const resolvers: ((v: Record<string, number>) => void)[] = [];

    const source = createPollingSensorSourceInternal(
      {
        id: "hr",
        channels: [HEART_RATE],
        intervalMs: 1000,
        read: () =>
          new Promise((r) => {
            resolvers.push(r);
          }),
      },
      clock.scheduler,
    );
    source.onSample((s) => samples.push(s));

    await source.start();
    clock.tick(1000); // read A begins
    await flush();
    await source.stop();
    await source.start();

    resolvers[0]?.({ heartRateBpm: 111 }); // A, from the previous session
    await flush();
    expect(samples).toEqual([]);

    clock.tick(1000); // read B begins
    await flush();
    resolvers[1]?.({ heartRateBpm: 222 });
    await flush();

    expect(samples).toHaveLength(1);
    expect(samples[0]?.values).toEqual({ heartRateBpm: 222 });
  });

  it("stops delivering to an unsubscribed listener", async () => {
    const clock = createTestScheduler();
    const samples: SensorSample[] = [];
    const source = createPollingSensorSourceInternal(
      {
        id: "hr",
        channels: [HEART_RATE],
        intervalMs: 1000,
        read: () => Promise.resolve({ heartRateBpm: 1 }),
      },
      clock.scheduler,
    );
    const unsubscribe = source.onSample((s) => samples.push(s));
    await source.start();

    clock.tick(1000);
    await flush();
    unsubscribe();
    clock.tick(1000);
    await flush();

    expect(samples).toHaveLength(1);
  });
});
