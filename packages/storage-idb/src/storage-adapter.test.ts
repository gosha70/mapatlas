// SPDX-License-Identifier: Apache-2.0
import "fake-indexeddb/auto";

import { newId } from "@mapatlas/core";
import type { MapEvent, Track } from "@mapatlas/core";
import { storageAdapterContract } from "@mapatlas/core/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { STORE } from "./schema.js";
import { createIdbStorageAdapter } from "./storage-adapter.js";
import type { IdbStorageAdapter } from "./storage-adapter.js";

const T0 = 1_700_000_000_000;

/**
 * A uniquely named store per call, deleted afterwards.
 *
 * The contract requires a fresh, **empty backing store** — a new adapter object over shared
 * storage leaks state between cases and produces failures that read as contract violations.
 */
const opened: IdbStorageAdapter[] = [];
const names: string[] = [];
let counter = 0;

function freshAdapter(): IdbStorageAdapter {
  const databaseName = `mapatlas-test-${String(counter++)}-${newId()}`;
  names.push(databaseName);
  const adapter = createIdbStorageAdapter({ databaseName });
  opened.push(adapter);
  return adapter;
}

afterEach(async () => {
  for (const adapter of opened.splice(0)) await adapter.close();
  for (const name of names.splice(0)) indexedDB.deleteDatabase(name);
});

function makeTrack(overrides: Partial<Track> = {}): Track {
  const points = [
    { lat: 59.33, lng: 18.06, t: T0 },
    { lat: 59.34, lng: 18.07, t: T0 + 60_000 },
  ];
  return {
    id: newId(),
    startedAt: T0,
    endedAt: T0 + 60_000,
    status: "finalized",
    origin: "recorded",
    points,
    segments: [{ id: newId(), startIndex: 0, endIndex: 1, startedAt: T0 }],
    ...overrides,
  };
}

const makeEvent = (o: Partial<MapEvent> = {}): MapEvent => ({
  id: newId(),
  position: { lat: 59.33, lng: 18.06 },
  occurredAt: T0,
  media: [],
  tags: [],
  ...o,
});

describe("createIdbStorageAdapter satisfies the published StorageAdapter contract", () => {
  for (const { name, run } of storageAdapterContract(freshAdapter)) {
    it(name, run);
  }
});

describe("atomicity of the track and its summary", () => {
  let store: IdbStorageAdapter;

  beforeEach(() => {
    store = freshAdapter();
  });

  it("writes both in one transaction, so neither exists without the other", async () => {
    const track = makeTrack();
    await store.saveTrack(track);

    expect(await store.getTrack(track.id)).toEqual(track);
    expect((await store.listTrackSummaries())[0]?.id).toBe(track.id);
  });

  it("keeps the summary in step with an overwrite", async () => {
    const track = makeTrack({ tags: ["before"] });
    await store.saveTrack(track);
    await store.saveTrack({ ...track, tags: ["after"], status: "recording" });

    const [summary] = await store.listTrackSummaries();
    expect(summary?.tags).toEqual(["after"]);
    expect(summary?.status).toBe("recording");
    expect(await store.listTrackSummaries()).toHaveLength(1);
  });

  it("reindexes when an overwrite changes startedAt", async () => {
    // The failure this guards: an index entry left pointing at the old key, so the trip
    // sorts by a time it no longer has.
    const early = makeTrack({ startedAt: T0 - 100_000 });
    const late = makeTrack({ startedAt: T0 + 100_000 });
    await store.saveTrack(early);
    await store.saveTrack(late);

    expect((await store.listTrackSummaries()).map((s) => s.id)).toEqual([early.id, late.id]);

    // Move the first trip after the second and re-save it.
    await store.saveTrack({ ...early, startedAt: T0 + 200_000 });

    const summaries = await store.listTrackSummaries();
    expect(summaries.map((s) => s.id)).toEqual([late.id, early.id]);
    expect(summaries).toHaveLength(2);
    expect(summaries.find((s) => s.id === early.id)?.startedAt).toBe(T0 + 200_000);
  });

  it("does not leave a stale index entry behind after several moves", async () => {
    const track = makeTrack({ startedAt: T0 });
    await store.saveTrack(track);
    for (const startedAt of [T0 + 1000, T0 - 5000, T0 + 9000]) {
      await store.saveTrack({ ...track, startedAt });
    }

    const summaries = await store.listTrackSummaries();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.startedAt).toBe(T0 + 9000);
  });

  it("keeps eventCount current as events come and go", async () => {
    const track = makeTrack();
    await store.saveTrack(track);
    const first = makeEvent({ trackId: track.id });
    await store.saveEvent(first);
    await store.saveEvent(makeEvent({ trackId: track.id }));

    expect((await store.listTrackSummaries())[0]?.eventCount).toBe(2);

    await store.deleteEvent(first.id);
    expect((await store.listTrackSummaries())[0]?.eventCount).toBe(1);
  });

  it("agrees with the track after a summary-affecting change", async () => {
    const track = makeTrack();
    await store.saveTrack(track);
    await store.saveEvent(makeEvent({ trackId: track.id }));

    const rewritten = { ...track, startedAt: T0 + 50_000, tags: ["moved"] };
    await store.saveTrack(rewritten);

    const [summary] = await store.listTrackSummaries();
    const stored = await store.getTrack(track.id);
    expect(summary?.startedAt).toBe(stored?.startedAt);
    expect(summary?.tags).toEqual(stored?.tags);
    expect(summary?.pointCount).toBe(stored?.points.length);
    expect(summary?.eventCount).toBe(1); // preserved across the track rewrite
  });
});

describe("reads that inform a write happen inside its transaction", () => {
  /**
   * The invariants these guard, whatever order two concurrent operations land in:
   *
   *   - every summary's `eventCount` equals the events actually attached to that track
   *   - a summary exists exactly when its track does
   *
   * Asserting a *specific* outcome would be wrong: with delete-then-save, an event
   * referencing a track that no longer exists is a legitimate serialization, and the
   * contract permits an event whose `trackId` names nothing. What must never happen is an
   * outcome matching neither ordering.
   */
  async function assertConsistent(store: IdbStorageAdapter): Promise<void> {
    const summaries = await store.listTrackSummaries();
    const events = await store.listEvents();

    for (const summary of summaries) {
      const actual = events.filter((event) => event.trackId === summary.id).length;
      expect(summary.eventCount).toBe(actual);
      expect(await store.getTrack(summary.id)).toBeDefined();
    }
  }

  it("keeps eventCount correct when saveTrack and saveEvent overlap", async () => {
    // Regression: saveTrack counted events in a transaction of its own, so a saveEvent
    // committing in between left the summary reporting a number already stale when
    // written. Reproduced 20/20 before the fix.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const store = freshAdapter();
      const track = makeTrack();
      await store.saveTrack(track);

      await Promise.all([
        store.saveTrack(track),
        store.saveEvent(makeEvent({ trackId: track.id })),
      ]);

      await assertConsistent(store);
    }
  });

  it("stays consistent when deleteTrack and saveEvent overlap, either way round", async () => {
    // Regression: the cascade snapshot was taken before the transaction, so an event could
    // commit after the snapshot but before the delete — an outcome matching neither
    // ordering of the two operations. Reproduced 20/20 with deleteTrack going first.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const store = freshAdapter();
      const track = makeTrack();
      await store.saveTrack(track);

      const operations = [
        store.deleteTrack(track.id),
        store.saveEvent(makeEvent({ trackId: track.id })),
      ];
      await Promise.all(attempt % 2 === 0 ? operations : operations.reverse());

      await assertConsistent(store);
      expect(await store.getTrack(track.id)).toBeUndefined();
    }
  });

  it("stays consistent under a burst of interleaved writes", async () => {
    const store = freshAdapter();
    const tracks = Array.from({ length: 4 }, (_, i) => makeTrack({ startedAt: T0 + i * 1000 }));
    for (const track of tracks) await store.saveTrack(track);

    await Promise.all(
      tracks.flatMap((track) => [
        store.saveEvent(makeEvent({ trackId: track.id })),
        store.saveEvent(makeEvent({ trackId: track.id })),
        store.saveTrack({ ...track, tags: ["rewritten"] }),
      ]),
    );

    await assertConsistent(store);
    for (const summary of await store.listTrackSummaries()) {
      expect(summary.eventCount).toBe(2);
    }
  });
});

describe("an event that changes owner repairs both summaries", () => {
  it("moves the count from the old track to the new one", async () => {
    // Regression: only the new owner was recomputed, so moving one event from A to B left
    // both reporting 1.
    const store = freshAdapter();
    const a = makeTrack({ startedAt: T0 });
    const b = makeTrack({ startedAt: T0 + 1000 });
    await store.saveTrack(a);
    await store.saveTrack(b);

    const event = makeEvent({ trackId: a.id });
    await store.saveEvent(event);
    await store.saveEvent({ ...event, trackId: b.id });

    const summaries = await store.listTrackSummaries();
    expect(summaries.find((s) => s.id === a.id)?.eventCount).toBe(0);
    expect(summaries.find((s) => s.id === b.id)?.eventCount).toBe(1);
  });

  it("decrements the old track when trackId is removed entirely", async () => {
    const store = freshAdapter();
    const track = makeTrack();
    await store.saveTrack(track);

    const event = makeEvent({ trackId: track.id });
    await store.saveEvent(event);
    expect((await store.listTrackSummaries())[0]?.eventCount).toBe(1);

    const detached = { ...event };
    delete detached.trackId;
    await store.saveEvent(detached);

    expect((await store.listTrackSummaries())[0]?.eventCount).toBe(0);
    expect(await store.listEvents()).toHaveLength(1);
  });

  it("increments the new track when a trackId is added to a detached event", async () => {
    const store = freshAdapter();
    const track = makeTrack();
    await store.saveTrack(track);

    const event = makeEvent();
    await store.saveEvent(event);
    expect((await store.listTrackSummaries())[0]?.eventCount).toBe(0);

    await store.saveEvent({ ...event, trackId: track.id });
    expect((await store.listTrackSummaries())[0]?.eventCount).toBe(1);
  });

  it("tolerates an event naming a track that was never stored", async () => {
    const store = freshAdapter();
    await expect(store.saveEvent(makeEvent({ trackId: newId() }))).resolves.toBeUndefined();
    expect(await store.listEvents()).toHaveLength(1);
  });

  it("moves the count back again", async () => {
    const store = freshAdapter();
    const a = makeTrack({ startedAt: T0 });
    const b = makeTrack({ startedAt: T0 + 1000 });
    await store.saveTrack(a);
    await store.saveTrack(b);

    const event = makeEvent({ trackId: a.id });
    for (const owner of [a.id, b.id, a.id, b.id, a.id]) {
      await store.saveEvent({ ...event, trackId: owner });
    }

    const summaries = await store.listTrackSummaries();
    expect(summaries.find((s) => s.id === a.id)?.eventCount).toBe(1);
    expect(summaries.find((s) => s.id === b.id)?.eventCount).toBe(0);
  });
});

describe("listing does not read the point payload", () => {
  /**
   * Instrumentation rather than inference.
   *
   * A large fixture and a stopwatch would only suggest the point arrays were skipped. This
   * records which object store every read touches, so "the tracks store was never opened
   * for reading" is observed directly — and it is the check that stops a future
   * implementation quietly regressing to scan-and-sort while still passing the contract.
   */
  const READ_METHODS = ["get", "getAll", "getAllKeys", "openCursor", "openKeyCursor", "count"];

  function recordStoreReads(): { names: string[]; restore: () => void } {
    const touched: string[] = [];
    const restorers: (() => void)[] = [];

    // Both prototypes. An index read reaches the same records but arrives through IDBIndex,
    // so patching IDBObjectStore alone records nothing for the very call under test — which
    // is what the `toContain(summaries)` guard below exists to catch.
    const patch = (proto: object, storeName: (self: never) => string): void => {
      const target = proto as unknown as Record<string, unknown>;
      for (const method of READ_METHODS) {
        const original = target[method];
        if (typeof original !== "function") continue;
        const fn = original as (...args: unknown[]) => unknown;
        target[method] = function patched(this: never, ...args: unknown[]) {
          touched.push(storeName(this));
          return fn.apply(this, args);
        };
        restorers.push(() => {
          target[method] = original;
        });
      }
    };

    patch(IDBObjectStore.prototype, (self) => (self as IDBObjectStore).name);
    patch(IDBIndex.prototype, (self) => (self as IDBIndex).objectStore.name);

    return {
      names: touched,
      restore: () => {
        for (const restore of restorers) restore();
      },
    };
  }

  it("never opens the tracks store while listing summaries", async () => {
    const store = freshAdapter();
    for (let i = 0; i < 5; i += 1) {
      await store.saveTrack(makeTrack({ startedAt: T0 + i * 1000 }));
    }

    const reads = recordStoreReads();
    try {
      const summaries = await store.listTrackSummaries();
      expect(summaries).toHaveLength(5);
    } finally {
      reads.restore();
    }

    expect(reads.names).not.toContain(STORE.tracks);
    expect(reads.names).toContain(STORE.summaries);
  });

  it("does read the tracks store when a track is actually asked for", async () => {
    // The control: without it, the assertion above would pass against instrumentation that
    // silently recorded nothing.
    const store = freshAdapter();
    const track = makeTrack();
    await store.saveTrack(track);

    const reads = recordStoreReads();
    try {
      await store.getTrack(track.id);
    } finally {
      reads.restore();
    }

    expect(reads.names).toContain(STORE.tracks);
  });

  it("stays off the tracks store as the trip list grows", async () => {
    const store = freshAdapter();
    for (let i = 0; i < 40; i += 1) {
      await store.saveTrack(makeTrack({ startedAt: T0 + i * 1000 }));
    }

    const reads = recordStoreReads();
    try {
      expect(await store.listTrackSummaries()).toHaveLength(40);
    } finally {
      reads.restore();
    }

    expect(reads.names.filter((name) => name === STORE.tracks)).toEqual([]);
  });
});

describe("ordering comes from the index, not a sort", () => {
  it("returns startedAt order from a traversal", async () => {
    const store = freshAdapter();
    const times = [T0 + 5000, T0 - 90_000, T0, T0 + 100, T0 - 1];
    const tracks = times.map((startedAt) => makeTrack({ startedAt }));
    for (const track of tracks) await store.saveTrack(track);

    const expected = [...tracks]
      .sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id))
      .map((t) => t.id);

    expect((await store.listTrackSummaries()).map((s) => s.id)).toEqual(expected);
  });

  it("breaks ties by id, which the index gives for free", async () => {
    // IndexedDB orders equal index keys by primary key, and the primary key is the track
    // id — so the contract's tiebreak needs no code of its own.
    const store = freshAdapter();
    const shared = T0 + 7000;
    const tracks = [
      makeTrack({ startedAt: shared }),
      makeTrack({ startedAt: shared }),
      makeTrack({ startedAt: shared }),
    ];
    for (const track of tracks) await store.saveTrack(track);

    const expected = tracks.map((t) => t.id).sort((a, b) => a.localeCompare(b));
    expect((await store.listTrackSummaries()).map((s) => s.id)).toEqual(expected);
  });
});

describe("persistence across connections", () => {
  it("survives closing and reopening the same store", async () => {
    const databaseName = `mapatlas-reopen-${newId()}`;
    names.push(databaseName);

    const first = createIdbStorageAdapter({ databaseName });
    const track = makeTrack();
    await first.saveTrack(track);
    await first.saveEvent(makeEvent({ trackId: track.id }));
    await first.close();

    const second = createIdbStorageAdapter({ databaseName });
    opened.push(second);

    expect(await second.getTrack(track.id)).toEqual(track);
    expect((await second.listTrackSummaries())[0]?.eventCount).toBe(1);
  });

  it("keeps two named stores independent", async () => {
    const a = freshAdapter();
    const b = freshAdapter();
    await a.saveTrack(makeTrack());

    expect(await a.listTrackSummaries()).toHaveLength(1);
    expect(await b.listTrackSummaries()).toHaveLength(0);
  });
});
