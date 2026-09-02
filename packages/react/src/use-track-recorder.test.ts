// @vitest-environment happy-dom
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type {
  SamplingPolicy,
  StorageAdapter,
  Track,
  TrackPoint,
  TrackRecorder,
  TrackRecorderError,
  TrackRecorderOptions,
  TrackStatus,
} from "@mapatlas/core";

import type { TrackRecorderHookEnvironment } from "./environment.js";
import { browserRecorderEnvironment } from "./environment.js";
import { renderHook } from "./testing/render-hook.js";
import type { UseTrackRecorderOptions } from "./use-track-recorder.js";
// The internal entry point: the public `useTrackRecorder` takes exactly the options `api.md`
// publishes, and the environment seam these tests count calls on is not among them.
import { useTrackRecorder, useTrackRecorderInternal } from "./use-track-recorder.js";

/**
 * A recorder that records what it was asked to do.
 *
 * Commands are counted rather than merely observed, because "delegates exactly once" is the
 * claim — a hook that called `pause()` twice would satisfy any assertion phrased as "the
 * recorder was paused".
 */
interface FakeRecorder extends TrackRecorder {
  readonly calls: string[];
  readonly laps: (string | undefined)[];
  /** What each `start` was called with, so a dropped `sampling` is visible. */
  readonly startedWith: (Partial<SamplingPolicy> | undefined)[];
  readonly pointListeners: number;
  readonly errorListeners: number;
  /** Every unsubscribe call, so "exactly once" can be asserted rather than "at least once". */
  readonly unsubscribes: number;
  emitPoint(point: TrackPoint): void;
  emitError(error: TrackRecorderError): void;
  finalized: Track;
  failStart?: Error;
}

function fakeRecorder(id = "t1"): FakeRecorder {
  const points: ((p: TrackPoint) => void)[] = [];
  const errors: ((e: TrackRecorderError) => void)[] = [];
  const calls: string[] = [];
  const laps: (string | undefined)[] = [];
  const startedWith: (Partial<SamplingPolicy> | undefined)[] = [];
  let status: TrackStatus = "finalized";
  let unsubscribes = 0;

  const recorder: FakeRecorder = {
    get status() {
      return status;
    },
    get calls() {
      return calls;
    },
    get laps() {
      return laps;
    },
    get startedWith() {
      return startedWith;
    },
    get pointListeners() {
      return points.length;
    },
    get errorListeners() {
      return errors.length;
    },
    get unsubscribes() {
      return unsubscribes;
    },
    finalized: {
      id,
      startedAt: 1,
      status: "finalized",
      origin: "recorded",
      points: [],
      segments: [],
    },
    start: async (sampling) => {
      calls.push("start");
      startedWith.push(sampling);
      if (recorder.failStart !== undefined) throw recorder.failStart;
      status = "recording";
      return Promise.resolve();
    },
    pause: () => {
      calls.push("pause");
      status = "paused";
    },
    resume: () => {
      calls.push("resume");
      status = "recording";
    },
    markLap: (label) => {
      calls.push("markLap");
      laps.push(label);
    },
    stop: async () => {
      calls.push("stop");
      status = "finalized";
      return Promise.resolve(recorder.finalized);
    },
    onPoint: (cb) => {
      points.push(cb);
      return () => {
        unsubscribes += 1;
        // **Throwing rather than tolerating a second call.** `indexOf` returns -1 for a listener
        // already removed, and `splice(-1, 1)` drops the *last* element — so a double
        // unsubscribe would silently detach somebody else's listener. A fake that absorbed that
        // would let the defect through.
        const at = points.indexOf(cb);
        if (at < 0) throw new Error("point listener unsubscribed twice");
        points.splice(at, 1);
      };
    },
    onError: (cb) => {
      errors.push(cb);
      return () => {
        unsubscribes += 1;
        const at = errors.indexOf(cb);
        if (at < 0) throw new Error("error listener unsubscribed twice");
        errors.splice(at, 1);
      };
    },
    emitPoint: (point) => {
      for (const cb of [...points]) cb(point);
    },
    emitError: (error) => {
      for (const cb of [...errors]) cb(error);
    },
  };
  return recorder;
}

/** The seam ADR-0026's rules are asserted against — counts, and the options each call received. */
interface CountedEnvironment extends TrackRecorderHookEnvironment {
  readonly built: TrackRecorderOptions[];
  readonly scanned: StorageAdapter[];
  readonly recorders: FakeRecorder[];
  // `| undefined` explicitly: `exactOptionalPropertyTypes` is on, and these are *reassigned*
  // to undefined once consumed rather than merely omitted at construction.
  candidate?: Track | undefined;
  recoverRejects?: Error | undefined;
  failNextStart?: Error | undefined;
}

function countedEnvironment(): CountedEnvironment {
  const built: TrackRecorderOptions[] = [];
  const scanned: StorageAdapter[] = [];
  const recorders: FakeRecorder[] = [];

  const env: CountedEnvironment = {
    built,
    scanned,
    recorders,
    createRecorder: (options) => {
      built.push(options);
      const made = fakeRecorder(`built-${String(built.length)}`);
      if (env.failNextStart !== undefined) {
        made.failStart = env.failNextStart;
        env.failNextStart = undefined;
      }
      recorders.push(made);
      return made;
    },
    recover: (store) => {
      scanned.push(store);
      if (env.recoverRejects !== undefined) return Promise.reject(env.recoverRejects);
      return Promise.resolve(env.candidate);
    },
  };
  return env;
}

function fakeStore(): StorageAdapter & { deleted: string[]; failDelete?: Error } {
  const store = {
    deleted: [] as string[],
    failDelete: undefined as Error | undefined,
    saveTrack: () => Promise.resolve(),
    getTrack: () => Promise.resolve(undefined),
    listTrackSummaries: () => Promise.resolve([]),
    deleteTrack: (id: string) => {
      if (store.failDelete !== undefined) return Promise.reject(store.failDelete);
      store.deleted.push(id);
      return Promise.resolve();
    },
    saveEvent: () => Promise.resolve(),
    getEvent: () => Promise.resolve(undefined),
    listEvents: () => Promise.resolve([]),
    deleteEvent: () => Promise.resolve(),
    putBlob: () => Promise.resolve(""),
    getBlob: () => Promise.resolve(undefined),
    deleteBlob: () => Promise.resolve(),
    clearAll: () => Promise.resolve(),
  };
  return store as StorageAdapter & { deleted: string[]; failDelete?: Error };
}

const INTERRUPTED: Track = {
  id: "interrupted-1",
  startedAt: 1_000,
  status: "recording",
  origin: "recorded",
  points: [{ lat: 1, lng: 2, t: 1_000 }],
  segments: [{ id: "s1", startIndex: 0, endIndex: 0, startedAt: 1_000 }],
};

const point = (t: number, channels?: Record<string, number>): TrackPoint => ({
  lat: 1,
  lng: 2,
  t,
  ...(channels === undefined ? {} : { channels }),
});

type Props = UseTrackRecorderOptions & { environment?: TrackRecorderHookEnvironment };

const mount = async (props: Props, strict = false) =>
  renderHook(
    (p: Props) => useTrackRecorderInternal(p, p.environment ?? browserRecorderEnvironment),
    props,
    { strict },
  );

describe("useTrackRecorder — who owns the recorder", () => {
  it("builds no recorder and scans nothing when one is injected", async () => {
    // **ADR-0026's rule, asserted as counts.** Checking `recovered === undefined` instead would
    // pass just as well against a hook that built a recorder, scanned the store, and happened to
    // find nothing — which is the defect, not the contract.
    const env = countedEnvironment();
    const injected = fakeRecorder();
    const store = fakeStore();

    const harness = await mount({ recorder: injected, store, environment: env });

    expect(env.built).toHaveLength(0);
    expect(env.scanned).toHaveLength(0);
    expect(harness.current.recovered).toBeUndefined();
    await harness.unmount();
  });

  it("scans once when it owns the recorder and has a store", async () => {
    const env = countedEnvironment();
    env.candidate = INTERRUPTED;
    const store = fakeStore();

    const harness = await mount({ store, environment: env });

    expect(env.scanned).toEqual([store]);
    expect(harness.current.recovered).toEqual(INTERRUPTED);
    // Discovery alone builds nothing: a scan is not a recording.
    expect(env.built).toHaveLength(0);
    await harness.unmount();
  });

  it("does not scan without a store, since there is nowhere to have been interrupted", async () => {
    const env = countedEnvironment();
    const harness = await mount({ environment: env });

    expect(env.scanned).toHaveLength(0);
    expect(harness.current.recovered).toBeUndefined();
    await harness.unmount();
  });

  it("lets a replaced store's scan win over the one it replaced", async () => {
    // The stale-result hazard, made concrete: the first store's scan resolves *after* the
    // second's. Without the liveness guard the hook publishes the older answer and a consumer
    // sees a candidate belonging to a store it no longer holds.
    const first = fakeStore();
    const second = fakeStore();
    const env = countedEnvironment();
    const gate: { release?: () => void } = {};
    env.recover = (store) => {
      env.scanned.push(store);
      if (store === first) {
        return new Promise<Track | undefined>((resolve) => {
          gate.release = () => {
            resolve(INTERRUPTED);
          };
        });
      }
      return Promise.resolve(undefined);
    };

    const harness = await mount({ store: first, environment: env });
    await harness.rerender({ store: second, environment: env });
    gate.release?.();
    await harness.settle();

    expect(harness.current.recovered).toBeUndefined();
    await harness.unmount();
  });
});

describe("useTrackRecorder — recovery is explicit", () => {
  it("starts fresh, leaving the candidate untouched", async () => {
    // `start()` never consumes `recovered` (ADR-0026). The assertion is on the *options the
    // recorder was built with*: a hook that passed `resumeFrom` would resume the old track while
    // still reporting a candidate, and no call count would show it.
    const env = countedEnvironment();
    env.candidate = INTERRUPTED;
    const harness = await mount({ store: fakeStore(), environment: env });

    await harness.current.start();
    await harness.settle();

    expect(env.built).toHaveLength(1);
    expect(env.built[0]?.resumeFrom).toBeUndefined();
    expect(harness.current.recovered).toEqual(INTERRUPTED);
    await harness.unmount();
  });

  it("resumes by building a recorder with the historical track itself", async () => {
    // Not "resumeFrom was truthy": the *identity and contents* of the candidate, because the
    // point of `resumeFrom` is that the id, points and original `startedAt` carry over so the
    // resumed recording overwrites the same record rather than starting a second trip.
    const env = countedEnvironment();
    env.candidate = INTERRUPTED;
    const harness = await mount({ store: fakeStore(), environment: env });

    await harness.current.resumeRecovered();
    await harness.settle();

    expect(env.built).toHaveLength(1);
    expect(env.built[0]?.resumeFrom).toEqual(INTERRUPTED);
    expect(env.built[0]?.resumeFrom?.id).toBe("interrupted-1");
    expect(env.built[0]?.resumeFrom?.startedAt).toBe(1_000);
    expect(harness.current.recovered).toBeUndefined();
    // The ordinary control was not what ran.
    expect(env.recorders[0]?.calls).toEqual(["start"]);
    await harness.unmount();
  });

  it("keeps the candidate when the resumed recorder fails to start", async () => {
    const env = countedEnvironment();
    env.candidate = INTERRUPTED;
    env.failNextStart = new Error("no geolocation permission");
    const harness = await mount({ store: fakeStore(), environment: env });

    await expect(harness.current.resumeRecovered()).rejects.toThrow("no geolocation permission");
    await harness.settle();

    // Available to retry — the whole reason the candidate is cleared only after success.
    expect(harness.current.recovered).toEqual(INTERRUPTED);
    await harness.unmount();
  });

  it("discards by deleting exactly that track", async () => {
    const env = countedEnvironment();
    env.candidate = INTERRUPTED;
    const store = fakeStore();
    const harness = await mount({ store, environment: env });

    await harness.current.discardRecovered();
    await harness.settle();

    expect(store.deleted).toEqual(["interrupted-1"]);
    expect(harness.current.recovered).toBeUndefined();
    await harness.unmount();
  });

  it("keeps the candidate when the deletion fails", async () => {
    const env = countedEnvironment();
    env.candidate = INTERRUPTED;
    const store = fakeStore();
    store.failDelete = new Error("quota");
    const harness = await mount({ store, environment: env });

    await expect(harness.current.discardRecovered()).rejects.toThrow("quota");
    await harness.settle();

    expect(harness.current.recovered).toEqual(INTERRUPTED);
    await harness.unmount();
  });

  it("does nothing on either recovery operation with an injected recorder", async () => {
    const env = countedEnvironment();
    env.candidate = INTERRUPTED;
    const injected = fakeRecorder();
    const store = fakeStore();
    const harness = await mount({ recorder: injected, store, environment: env });

    await harness.current.resumeRecovered();
    await harness.current.discardRecovered();

    expect(env.built).toHaveLength(0);
    expect(store.deleted).toEqual([]);
    expect(injected.calls).toEqual([]);
    await harness.unmount();
  });
});

describe("useTrackRecorder — commands and live state", () => {
  it("delegates every command exactly once, and carries a lap's label", async () => {
    const injected = fakeRecorder();
    const harness = await mount({ recorder: injected, environment: countedEnvironment() });

    await harness.current.start();
    harness.current.pause();
    harness.current.resume();
    harness.current.markLap("Lap 2");
    await harness.current.stop();
    await harness.settle();

    expect(injected.calls).toEqual(["start", "pause", "resume", "markLap", "stop"]);
    expect(injected.laps).toEqual(["Lap 2"]);
    await harness.unmount();
  });

  it("publishes the recorder's own finalized track from stop()", async () => {
    const injected = fakeRecorder();
    injected.finalized = { ...injected.finalized, id: "finished-7" };
    const harness = await mount({ recorder: injected, environment: countedEnvironment() });
    await harness.current.start();

    const returned = await harness.current.stop();
    await harness.settle();

    expect(returned).toBe(injected.finalized);
    expect(harness.current.track).toBe(injected.finalized);
    expect(harness.current.status).toBe("finalized");
    await harness.unmount();
  });

  it("reports the latest point's channels, and nothing carried over from an earlier one", async () => {
    // The case that separates a snapshot from an accumulation. `TrackPoint.channels` is already
    // the recorder's merge result for that point; retaining `cadence` here would invent a second
    // aggregation policy in React and hide that the sensor stopped reporting.
    const injected = fakeRecorder();
    const harness = await mount({ recorder: injected, environment: countedEnvironment() });
    await harness.current.start();

    await harness.settle();
    injected.emitPoint(point(1, { heartRate: 150, cadence: 80 }));
    await harness.settle();
    expect(harness.current.channels).toEqual({ heartRate: 150, cadence: 80 });

    injected.emitPoint(point(2, { heartRate: 151 }));
    await harness.settle();

    expect(harness.current.channels).toEqual({ heartRate: 151 });
    expect(harness.current.livePoint?.t).toBe(2);
    await harness.unmount();
  });

  it("keeps the latest error, and does not clear it when recording resumes", async () => {
    const injected = fakeRecorder();
    const harness = await mount({ recorder: injected, environment: countedEnvironment() });
    const failure: TrackRecorderError = { kind: "position-unavailable", message: "signal lost" };

    injected.emitError(failure);
    await harness.settle();
    expect(harness.current.error).toBe(failure);

    // A later fix nobody performed is not something a subsequent point can report.
    injected.emitPoint(point(3, { heartRate: 140 }));
    await harness.settle();

    expect(harness.current.error).toBe(failure);
    await harness.unmount();
  });
});

describe("useTrackRecorder — the public wrapper", () => {
  it("passes its options through to the recorder it was given", async () => {
    // **The detailed tests drive `useTrackRecorderInternal`, so the exported function's body was
    // untested.** It could discard `options` entirely — binding a default recorder while a
    // consumer's injected one sat unused — and every test above would still pass, because none
    // of them calls it. The conformance check compares types, and a discarded argument
    // type-checks perfectly.
    //
    // Through the barrel's `useTrackRecorder`, then: an injected recorder must be the one the
    // commands reach, and `sampling` must arrive with `start`.
    const injected = fakeRecorder();
    const harness = await renderHook((p: UseTrackRecorderOptions) => useTrackRecorder(p), {
      recorder: injected,
      sampling: { minDistanceM: 7 },
    });

    await harness.current.start();
    harness.current.markLap("wrapper lap");
    await harness.settle();

    expect(injected.calls).toEqual(["start", "markLap"]);
    expect(injected.laps).toEqual(["wrapper lap"]);
    expect(injected.startedWith).toEqual([{ minDistanceM: 7 }]);
    await harness.unmount();
  });
});

describe("useTrackRecorder — React lifecycle", () => {
  it("unsubscribes exactly once on unmount", async () => {
    const injected = fakeRecorder();
    const harness = await mount({ recorder: injected, environment: countedEnvironment() });
    expect(injected.pointListeners).toBe(1);
    expect(injected.errorListeners).toBe(1);

    await harness.unmount();

    expect(injected.pointListeners).toBe(0);
    expect(injected.errorListeners).toBe(0);
  });

  it("releases a hook-owned recorder on stop(), and does not release it again on unmount", async () => {
    // **Exactly once, and only on the path that owns the recorder.** A hook-owned recorder is
    // finished by `stop()` — a later `start()` builds a fresh one — so its subscriptions end
    // there. Unmount must not end them a second time: the fake throws on a repeat, because the
    // obvious implementation of an unsubscribe, `splice(indexOf(cb), 1)`, turns `indexOf`'s -1
    // into "remove the last element" and silently detaches somebody else's listener.
    const env = countedEnvironment();
    const harness = await mount({ store: fakeStore(), environment: env });
    await harness.current.start();
    await harness.settle();
    const owned = env.recorders[0]!;
    expect(owned.pointListeners).toBe(1);

    await harness.current.stop();
    await harness.settle();

    expect(owned.unsubscribes).toBe(2); // one point listener, one error listener
    expect(owned.pointListeners).toBe(0);

    await harness.unmount();

    expect(owned.unsubscribes).toBe(2);
  });

  it("keeps listening to an injected recorder after stop(), because the consumer owns it", async () => {
    // The mirror of the rule above, and the reason it is stated as "hook-owned". A consumer that
    // stops and starts its own recorder still expects the hook to report the new points; ending
    // the subscription at `stop()` would leave the binding silently dead.
    const injected = fakeRecorder();
    const harness = await mount({ recorder: injected, environment: countedEnvironment() });
    await harness.current.start();
    await harness.current.stop();
    await harness.settle();

    expect(injected.unsubscribes).toBe(0);
    injected.emitPoint(point(9, { heartRate: 99 }));
    await harness.settle();
    expect(harness.current.livePoint?.t).toBe(9);

    await harness.unmount();
    expect(injected.unsubscribes).toBe(2);
  });

  it("leaves no second subscription behind when the injected recorder is replaced", async () => {
    const first = fakeRecorder("a");
    const second = fakeRecorder("b");
    const env = countedEnvironment();
    const harness = await mount({ recorder: first, environment: env });

    await harness.rerender({ recorder: second, environment: env });

    expect(first.pointListeners).toBe(0);
    expect(second.pointListeners).toBe(1);
    await harness.unmount();
  });

  it("does not build a second recorder because an options object changed identity", async () => {
    // The reason construction is not in the render body. An inline `{ store }` is a new object
    // every render, and rebuilding on identity would silently replace a recording in progress.
    const env = countedEnvironment();
    const store = fakeStore();
    const harness = await mount({ store, sensors: [], environment: env });
    await harness.current.start();
    await harness.settle();
    expect(env.built).toHaveLength(1);

    await harness.rerender({ store, sensors: [], environment: env });
    await harness.rerender({ store, sensors: [], environment: env });

    expect(env.built).toHaveLength(1);
    await harness.unmount();
  });

  it("discards the first scan's answer when StrictMode remounts the effect", async () => {
    // **What StrictMode can catch here, and the first attempt could not.** A test asserting one
    // subscription under StrictMode was redundant: subscribing in the render body — the defect it
    // was meant to catch — already fails the unmount and replacement tests, which count listeners
    // directly. Correct code behaves identically with and without StrictMode, so a test that
    // merely runs under it proves nothing.
    //
    // This is different. StrictMode mounts the scan effect, cleans it up, and mounts it again, so
    // *two* scans are in flight and the first one's cleanup has already run. The env answers with
    // a different candidate each time, and the first resolves last. Only a hook that honours the
    // liveness guard publishes the second scan's answer; one without it publishes whichever
    // settled last, which is the stale one. No amount of non-strict testing reaches this — a
    // single mount only ever has one scan.
    const env = countedEnvironment();
    const second: Track = { ...INTERRUPTED, id: "from-second-scan" };
    let release: (() => void) | undefined;
    env.recover = (store) => {
      env.scanned.push(store);
      if (env.scanned.length === 1) {
        return new Promise<Track | undefined>((resolve) => {
          release = () => {
            resolve(INTERRUPTED);
          };
        });
      }
      return Promise.resolve(second);
    };

    const harness = await mount({ store: fakeStore(), environment: env }, true);
    release?.();
    await harness.settle();

    expect(env.scanned.length).toBeGreaterThan(1);
    expect(harness.current.recovered).toEqual(second);
    await harness.unmount();
  });
});
