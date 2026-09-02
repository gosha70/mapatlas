// @vitest-environment happy-dom
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { EventLog, Id, MapEvent, StorageAdapter } from "@mapatlas/core";
import { createEventLog } from "@mapatlas/core";

import { renderHook } from "./testing/render-hook.js";
// The internal entry point, not the barrel's: the public `useEventLog` takes exactly the two
// parameters `api.md` publishes, and the seam these tests need is deliberately not among them.
import { useEventLog, useEventLogInternal } from "./use-event-log.js";

/**
 * A log that answers on demand, so "which list won" can be decided by the test.
 *
 * Deliberately *not* a real `createEventLog` over a fake store: the hazards here are about
 * ordering between overlapping async calls, and a log that resolves immediately cannot express
 * "the older list settles last".
 */
interface FakeLog extends EventLog {
  readonly calls: string[];
  readonly listed: (Id | undefined)[];
  /** Resolve the pending `list` for this trackId with the given events. */
  answer(trackId: Id | undefined, events: MapEvent[]): void;
  /** Fail the next mutation of this kind. */
  failNext?: { kind: "add" | "update" | "remove"; error: Error } | undefined;
  /** When set, `list` resolves immediately with this rather than waiting to be answered. */
  auto?: MapEvent[] | undefined;
  /** Hold `add` open until {@link FakeLog.releaseAdd} is called. */
  parkAdd?: boolean | undefined;
  releaseAdd?: (() => void) | undefined;
}

function fakeLog(): FakeLog {
  const pending = new Map<string, ((events: MapEvent[]) => void)[]>();
  const calls: string[] = [];
  const listed: (Id | undefined)[] = [];

  const reject = (kind: "add" | "update" | "remove"): Error | undefined => {
    if (log.failNext?.kind !== kind) return undefined;
    const { error } = log.failNext;
    log.failNext = undefined;
    return error;
  };

  const log: FakeLog = {
    calls,
    listed,
    failNext: undefined,
    auto: undefined,
    parkAdd: undefined,
    releaseAdd: undefined,
    list: (trackId) => {
      calls.push("list");
      listed.push(trackId);
      if (log.auto !== undefined) return Promise.resolve(log.auto);
      return new Promise<MapEvent[]>((resolve) => {
        const key = String(trackId);
        pending.set(key, [...(pending.get(key) ?? []), resolve]);
      });
    },
    add: (input) => {
      calls.push("add");
      const failure = reject("add");
      if (failure !== undefined) return Promise.reject(failure);
      const created = { ...input, id: "minted-by-core" } as MapEvent;
      // Parked when asked, so a mutation can still be running when the store or trackId changes.
      if (log.parkAdd === true) {
        return new Promise<MapEvent>((resolve) => {
          log.releaseAdd = () => {
            resolve(created);
          };
        });
      }
      return Promise.resolve(created);
    },
    update: () => {
      calls.push("update");
      const failure = reject("update");
      return failure === undefined ? Promise.resolve() : Promise.reject(failure);
    },
    get: () => Promise.resolve(undefined),
    remove: (id) => {
      calls.push(`remove:${id}`);
      const failure = reject("remove");
      return failure === undefined ? Promise.resolve() : Promise.reject(failure);
    },
    answer: (trackId, events) => {
      const key = String(trackId);
      const waiting = pending.get(key) ?? [];
      pending.set(key, []);
      for (const resolve of waiting) resolve(events);
    },
  };
  return log;
}

const store = (): StorageAdapter => ({}) as StorageAdapter;

const event = (id: string, occurredAt = 1): MapEvent =>
  ({
    id,
    trackId: "t1",
    position: { lat: 1, lng: 2 },
    occurredAt,
    media: [],
    tags: [],
  }) as MapEvent;

interface Props {
  store: StorageAdapter;
  trackId?: Id | undefined;
  createLog?: ((s: StorageAdapter) => EventLog) | undefined;
}

const mount = async (props: Props, strict = false) =>
  renderHook(
    (p: Props) => useEventLogInternal(p.store, p.trackId, p.createLog ?? createEventLog),
    props,
    { strict },
  );

describe("useEventLog — loading", () => {
  it("lists for the track it was given", async () => {
    const log = fakeLog();
    log.auto = [event("e1")];
    const harness = await mount({ store: store(), trackId: "t1", createLog: () => log });

    expect(log.listed).toEqual(["t1"]);
    expect(harness.current.events).toEqual([event("e1")]);
    await harness.unmount();
  });

  it("does not let an older track's list overwrite a newer one", async () => {
    // **The hazard the context token exists for.** A list for A resolving after one for B
    // leaves the component showing another track's events, with nothing anywhere reporting an
    // error. Ordering is decided here rather than hoped for: B is answered first, then A.
    const log = fakeLog();
    // The same store throughout, so `trackId` is the only thing that changed — a new store would
    // also rebuild the log and make the test about two things at once.
    const shared = store();
    const harness = await mount({ store: shared, trackId: "a", createLog: () => log });
    await harness.rerender({ store: shared, trackId: "b", createLog: () => log });

    log.answer("b", [event("from-b")]);
    await harness.settle();
    log.answer("a", [event("from-a")]);
    await harness.settle();

    expect(harness.current.events).toEqual([event("from-b")]);
    await harness.unmount();
  });

  it("cannot let a slow initial list undo a completed add", async () => {
    // Two loads in the *same* context, resolving out of order — neither the store nor the
    // trackId changes, so a context token cannot separate them. The initial list is parked, the
    // add's re-read publishes, and only then does the initial snapshot arrive with the world as
    // it was before the add. A context-only guard would admit it and undo the add.
    const log = fakeLog();
    const shared = store();
    const harness = await mount({ store: shared, trackId: "t1", createLog: () => log });
    expect(log.calls.filter((call) => call === "list")).toHaveLength(1);

    log.auto = [event("added")];
    await harness.current.addEvent(event("added") as never);
    await harness.settle();
    expect(harness.current.events.map((e) => e.id)).toEqual(["added"]);

    // The initial list finally answers, with the pre-add world.
    log.auto = undefined;
    log.answer("t1", []);
    await harness.settle();

    expect(harness.current.events.map((e) => e.id)).toEqual(["added"]);
    await harness.unmount();
  });

  it("cannot publish events from a mutation that outlived its trackId", async () => {
    // **The race the initial-effect test does not reach.** An add against trackId A is still in
    // flight when the component switches to B. Its re-read must fail the context guard, and
    // only does if the context token was captured *before* the add was awaited — sampling it
    // afterwards reads B's token and lets A's events win.
    const log = fakeLog();
    log.auto = [event("from-a")];
    log.parkAdd = true;
    const shared = store();

    const harness = await mount({ store: shared, trackId: "a", createLog: () => log });
    const inFlight = harness.current.addEvent(event("pending") as never);
    await harness.settle();

    log.auto = [event("from-b")];
    await harness.rerender({ store: shared, trackId: "b", createLog: () => log });
    expect(harness.current.events.map((e) => e.id)).toEqual(["from-b"]);

    log.auto = [event("from-a")];
    const listedSoFar = log.calls.filter((call) => call === "list").length;
    log.releaseAdd?.();
    await inFlight;
    await harness.settle();

    expect(harness.current.events.map((e) => e.id)).toEqual(["from-b"]);
    // The stale mutation issues no re-read at all: the guard would discard its answer, and a
    // request whose answer can only be discarded should not be made.
    expect(log.calls.filter((call) => call === "list")).toHaveLength(listedSoFar);
    await harness.unmount();
  });

  it("cannot publish the previous store's events after the store is replaced", async () => {
    const first = fakeLog();
    const second = fakeLog();
    second.auto = [event("from-second-store")];
    const logs = [first, second];
    let built = 0;
    const createLog = (): EventLog => logs[Math.min(built++, 1)]!;

    const harness = await mount({ store: store(), trackId: "t1", createLog });
    await harness.rerender({ store: store(), trackId: "t1", createLog });

    // The first store's list settles last, and must lose.
    first.answer("t1", [event("from-first-store")]);
    await harness.settle();

    expect(harness.current.events).toEqual([event("from-second-store")]);
    await harness.unmount();
  });
});

describe("useEventLog — mutations go through the log", () => {
  it("takes state after an add from the log, not from the returned event", async () => {
    // **Not local array surgery.** Splicing the created event in would put it wherever the array
    // ended, while the log orders by `occurredAt` with ties broken by id — so a consumer would
    // see one order until it refreshed and another afterwards. The fake proves the difference by
    // answering with an order the naive patch could not produce.
    const log = fakeLog();
    log.auto = [event("existing", 1)];
    const harness = await mount({ store: store(), trackId: "t1", createLog: () => log });

    log.auto = [event("minted-by-core", 0), event("existing", 1)];
    const created = await harness.current.addEvent({ ...event("ignored"), id: undefined } as never);
    await harness.settle();

    expect(created.id).toBe("minted-by-core");
    // Ordered before the existing one, which only a re-read from the log can produce.
    expect(harness.current.events.map((e) => e.id)).toEqual(["minted-by-core", "existing"]);
    expect(log.calls.filter((call) => call === "list")).toHaveLength(2);
    await harness.unmount();
  });

  it("re-reads after an update and after a delete", async () => {
    const log = fakeLog();
    log.auto = [event("e1"), event("e2")];
    const harness = await mount({ store: store(), trackId: "t1", createLog: () => log });

    log.auto = [event("e1", 5), event("e2")];
    await harness.current.updateEvent(event("e1", 5));
    await harness.settle();
    expect(harness.current.events[0]?.occurredAt).toBe(5);

    log.auto = [event("e2")];
    await harness.current.deleteEvent("e1");
    await harness.settle();

    expect(log.calls).toContain("remove:e1");
    expect(harness.current.events.map((e) => e.id)).toEqual(["e2"]);
    await harness.unmount();
  });

  it("leaves the rendered events untouched when a mutation rejects", async () => {
    const log = fakeLog();
    log.auto = [event("e1")];
    const harness = await mount({ store: store(), trackId: "t1", createLog: () => log });
    const before = harness.current.events;

    log.failNext = { kind: "update", error: new Error("no event with id e1") };
    await expect(harness.current.updateEvent(event("e1", 9))).rejects.toThrow("no event with id");
    await harness.settle();

    expect(harness.current.events).toEqual(before);
    // And no re-read was issued for a mutation that did not happen.
    expect(log.calls.filter((call) => call === "list")).toHaveLength(1);
    await harness.unmount();
  });

  it("does not swallow a rejected add, and adds nothing locally", async () => {
    const log = fakeLog();
    log.auto = [];
    const harness = await mount({ store: store(), trackId: "t1", createLog: () => log });

    log.failNext = { kind: "add", error: new Error("quota") };
    await expect(harness.current.addEvent(event("e9") as never)).rejects.toThrow("quota");
    await harness.settle();

    expect(harness.current.events).toEqual([]);
    await harness.unmount();
  });
});

describe("useEventLog — the public wrapper", () => {
  it("forwards its trackId into a real event log over the given store", async () => {
    // **The detailed tests above drive `useEventLogInternal`, so nothing was exercising the
    // exported function's body.** It could drop `trackId` — or ignore `store` — while every
    // lifecycle test stayed green, and the conformance check would not notice either: that
    // compares types, and a discarded argument still type-checks.
    //
    // So this one goes through the barrel's `useEventLog` and a real `createEventLog`, over a
    // store that records which trackId reached it. Two tracks, so forwarding `undefined` fails.
    const listed: (Id | undefined)[] = [];
    const stored: StorageAdapter = {
      ...store(),
      listEvents: (trackId) => {
        listed.push(trackId);
        return Promise.resolve(trackId === "t-second" ? [event("only-in-second")] : []);
      },
    };

    const harness = await renderHook((p: { trackId: Id }) => useEventLog(stored, p.trackId), {
      trackId: "t-second",
    });

    expect(listed).toEqual(["t-second"]);
    expect(harness.current.events.map((e) => e.id)).toEqual(["only-in-second"]);
    await harness.unmount();
  });
});

describe("useEventLog — lifecycle", () => {
  it("publishes the second list when StrictMode remounts the effect", async () => {
    // The StrictMode-specific oracle: two lists in flight because the effect mounts, cleans up
    // and mounts again, with the first answered last. Only a hook that invalidates on teardown
    // publishes the second.
    const log = fakeLog();
    const harness = await mount({ store: store(), trackId: "t1", createLog: () => log }, true);

    expect(log.calls.filter((call) => call === "list").length).toBeGreaterThan(1);
    log.answer("t1", [event("answering-both")]);
    await harness.settle();

    expect(harness.current.events).toEqual([event("answering-both")]);
    await harness.unmount();
  });

  it("sets no state from a list that resolves after unmount", async () => {
    const log = fakeLog();
    const harness = await mount({ store: store(), trackId: "t1", createLog: () => log });
    await harness.unmount();

    // Resolving now must not throw an act warning or update a torn-down tree.
    log.answer("t1", [event("too-late")]);
    expect(harness.current.events).toEqual([]);
  });
});
