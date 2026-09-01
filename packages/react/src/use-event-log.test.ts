// @vitest-environment happy-dom
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { EventLog, Id, MapEvent, StorageAdapter } from "@mapatlas/core";

import { renderHook } from "./testing/render-hook.js";
import { useEventLog } from "./use-event-log.js";

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
      return Promise.resolve({ ...input, id: "minted-by-core" } as MapEvent);
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
    (p: Props) =>
      useEventLog(p.store, p.trackId, { ...(p.createLog ? { createLog: p.createLog } : {}) }),
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
    // **The hazard the generation counter exists for.** A list for A resolving after one for B
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
