// @vitest-environment happy-dom
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { Id, StorageAdapter, TrackSummary } from "@mapatlas/core";

import { renderHook } from "./testing/render-hook.js";
import { useTrackList } from "./use-track-list.js";

/**
 * A store that answers when told to, so which of two overlapping lists wins is decided here.
 *
 * `getTrack` **throws**. "Summary-backed" is the contract, and a fake that quietly answered it
 * would let a hydrating implementation pass — the claim has to cross a seam rather than be
 * inferred from the type the hook happens to return.
 */
interface FakeStore extends StorageAdapter {
  readonly calls: string[];
  answer(summaries: TrackSummary[]): void;
  /** Resolve only the **oldest** pending list, so two in flight can settle out of order. */
  answerOldest(summaries: TrackSummary[]): void;
  readonly pendingLists: number;
  auto?: TrackSummary[] | undefined;
  failList?: Error | undefined;
  failDelete?: Error | undefined;
  parkDelete?: boolean | undefined;
  releaseDelete?: (() => void) | undefined;
}

function fakeStore(): FakeStore {
  const pending: ((summaries: TrackSummary[]) => void)[] = [];
  const calls: string[] = [];

  const store: FakeStore = {
    calls,
    auto: undefined,
    failList: undefined,
    failDelete: undefined,
    parkDelete: undefined,
    releaseDelete: undefined,
    listTrackSummaries: () => {
      calls.push("listTrackSummaries");
      if (store.failList !== undefined) return Promise.reject(store.failList);
      if (store.auto !== undefined) return Promise.resolve(store.auto);
      return new Promise<TrackSummary[]>((resolve) => pending.push(resolve));
    },
    getTrack: () => {
      calls.push("getTrack");
      throw new Error("useTrackList must never hydrate a track to render a list");
    },
    deleteTrack: (id: Id) => {
      calls.push(`deleteTrack:${id}`);
      if (store.failDelete !== undefined) return Promise.reject(store.failDelete);
      if (store.parkDelete === true) {
        return new Promise<void>((resolve) => {
          store.releaseDelete = resolve;
        });
      }
      return Promise.resolve();
    },
    saveTrack: () => Promise.resolve(),
    saveEvent: () => Promise.resolve(),
    getEvent: () => Promise.resolve(undefined),
    listEvents: () => Promise.resolve([]),
    deleteEvent: () => Promise.resolve(),
    putBlob: () => Promise.resolve(""),
    getBlob: () => Promise.resolve(undefined),
    deleteBlob: () => Promise.resolve(),
    clearAll: () => Promise.resolve(),
    answer: (summaries) => {
      const waiting = pending.splice(0, pending.length);
      for (const resolve of waiting) resolve(summaries);
    },
    answerOldest: (summaries) => {
      const resolve = pending.shift();
      if (resolve === undefined) throw new Error("no list is pending");
      resolve(summaries);
    },
    get pendingLists() {
      return pending.length;
    },
  };
  return store;
}

const summary = (id: string, startedAt = 1): TrackSummary => ({
  id,
  startedAt,
  status: "finalized",
  origin: "recorded",
  pointCount: 3,
});

interface Props {
  store: StorageAdapter;
}

const mount = async (props: Props, strict = false) =>
  renderHook((p: Props) => useTrackList(p.store), props, { strict });

describe("useTrackList — summary-backed loading", () => {
  it("lists summaries and never hydrates a track", async () => {
    const store = fakeStore();
    store.auto = [summary("t1"), summary("t2")];
    const harness = await mount({ store });

    expect(harness.current.tracks.map((t) => t.id)).toEqual(["t1", "t2"]);
    // The seam, not the type: `getTrack` throws, so a hydrating implementation fails outright.
    expect(store.calls).not.toContain("getTrack");
    await harness.unmount();
  });

  it("preserves the adapter's order rather than re-imposing it", async () => {
    // `listTrackSummaries` is contractually ordered by `startedAt`, ties broken by id (ADR-0014),
    // and the storage conformance suite enforces it per adapter. Re-sorting here would duplicate
    // that rule above the seam, where it can drift — so the fake answers in an order neither an
    // id sort nor a reversal would produce, and the hook must pass it through untouched.
    const store = fakeStore();
    store.auto = [summary("zulu", 1), summary("alpha", 2), summary("mike", 3)];
    const harness = await mount({ store });

    expect(harness.current.tracks.map((t) => t.id)).toEqual(["zulu", "alpha", "mike"]);
    await harness.unmount();
  });
});

describe("useTrackList — loading", () => {
  it("starts loading and settles when the list arrives", async () => {
    const store = fakeStore();
    const harness = await mount({ store });

    expect(harness.current.loading).toBe(true);
    store.answer([summary("t1")]);
    await harness.settle();

    expect(harness.current.loading).toBe(false);
    expect(harness.current.tracks.map((t) => t.id)).toEqual(["t1"]);
    await harness.unmount();
  });

  it("is not cleared by an older request while a newer one is pending", async () => {
    // **`loading` means the *newest* request is pending.** If an older one could clear it, the
    // spinner would stop before the answer that will actually be shown has arrived — the list
    // would read as settled while still about to change.
    //
    // The two lists must therefore settle **separately**, oldest first. Resolving both at once
    // cannot distinguish the guard: whichever order the `finally` blocks run in, `loading` ends
    // false, so the assertion has to be made in the window between them.
    const store = fakeStore();
    const harness = await mount({ store });
    const refreshing = harness.current.refresh();
    await harness.settle();
    expect(store.pendingLists).toBe(2);
    expect(harness.current.loading).toBe(true);

    store.answerOldest([summary("older")]);
    await harness.settle();

    // The window: the first request has settled, the second has not.
    expect(store.pendingLists).toBe(1);
    expect(harness.current.loading, "an older request cleared loading").toBe(true);
    expect(harness.current.tracks, "an older request published").toEqual([]);

    store.answerOldest([summary("newest")]);
    await refreshing;
    await harness.settle();

    expect(harness.current.loading).toBe(false);
    expect(harness.current.tracks.map((t) => t.id)).toEqual(["newest"]);
    await harness.unmount();
  });

  it("goes back to loading for a refresh, without blanking what is on screen", async () => {
    // **The false -> true transition, which nothing else here observes.** Every other case
    // starts while the initial load is already pending, so `loading` is true before they look —
    // and deleting `setLoading(true)` from `load` left the whole suite green. A refresh issued
    // after the list has settled is the only place the restart is visible.
    const store = fakeStore();
    store.auto = [summary("t1")];
    const harness = await mount({ store });
    expect(harness.current.loading).toBe(false);

    store.auto = undefined; // the refresh parks
    const refreshing = harness.current.refresh();
    await harness.settle();

    expect(harness.current.loading, "a refresh did not restart loading").toBe(true);
    // And the rows stay while it runs: a list that emptied itself on every refresh would flash.
    expect(harness.current.tracks.map((t) => t.id)).toEqual(["t1"]);

    store.answerOldest([summary("t1"), summary("t2")]);
    await refreshing;
    await harness.settle();

    expect(harness.current.loading).toBe(false);
    expect(harness.current.tracks.map((t) => t.id)).toEqual(["t1", "t2"]);
    await harness.unmount();
  });

  it("is not loading during the delete itself, only during the list that follows", async () => {
    // The boundary `loading` describes: **list work**, not mutation work. A parked
    // `deleteTrack` is not a pending list, so the flag stays false through it and turns true
    // only once the authoritative re-list is issued.
    const store = fakeStore();
    store.auto = [summary("t1"), summary("t2")];
    const harness = await mount({ store });
    expect(harness.current.loading).toBe(false);

    store.parkDelete = true;
    const removing = harness.current.remove("t1");
    await harness.settle();

    expect(harness.current.loading, "a pending delete was reported as loading").toBe(false);
    expect(harness.current.tracks.map((t) => t.id)).toEqual(["t1", "t2"]);

    store.auto = undefined; // so the post-delete list parks and can be observed
    store.releaseDelete?.();
    await harness.settle();

    expect(harness.current.loading, "the post-delete list is list work").toBe(true);

    store.answerOldest([summary("t2")]);
    await removing;
    await harness.settle();

    expect(harness.current.loading).toBe(false);
    expect(harness.current.tracks.map((t) => t.id)).toEqual(["t2"]);
    await harness.unmount();
  });

  it("ends loading and keeps the previous list when the initial list fails", async () => {
    const store = fakeStore();
    store.auto = [summary("already-shown")];
    const harness = await mount({ store });
    expect(harness.current.tracks.map((t) => t.id)).toEqual(["already-shown"]);

    // A replaced store whose first list rejects: nothing to publish, and no error field to put
    // it in, so what was already on screen stays there.
    const failing = fakeStore();
    failing.failList = new Error("storage unavailable");
    await harness.rerender({ store: failing });

    expect(harness.current.tracks.map((t) => t.id)).toEqual(["already-shown"]);
    expect(harness.current.loading).toBe(false);
    await harness.unmount();
  });

  it("rejects an explicit refresh failure to its caller", async () => {
    // Unlike the initial load, a refresh was asked for — so its failure has somewhere to go.
    const store = fakeStore();
    store.auto = [summary("t1")];
    const harness = await mount({ store });

    store.failList = new Error("read failed");
    await expect(harness.current.refresh()).rejects.toThrow("read failed");
    await harness.settle();

    expect(harness.current.tracks.map((t) => t.id)).toEqual(["t1"]);
    expect(harness.current.loading).toBe(false);
    await harness.unmount();
  });
});

describe("useTrackList — removal is authoritative", () => {
  it("deletes exactly that id, then re-lists from the store", async () => {
    const store = fakeStore();
    store.auto = [summary("t1"), summary("t2")];
    const harness = await mount({ store });

    store.auto = [summary("t2")];
    await harness.current.remove("t1");
    await harness.settle();

    expect(store.calls).toContain("deleteTrack:t1");
    expect(harness.current.tracks.map((t) => t.id)).toEqual(["t2"]);
    expect(store.calls.filter((call) => call === "listTrackSummaries")).toHaveLength(2);
    await harness.unmount();
  });

  it("keeps the row and issues no re-list when the delete rejects", async () => {
    const store = fakeStore();
    store.auto = [summary("t1"), summary("t2")];
    const harness = await mount({ store });

    store.failDelete = new Error("busy");
    await expect(harness.current.remove("t1")).rejects.toThrow("busy");
    await harness.settle();

    expect(harness.current.tracks.map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(store.calls.filter((call) => call === "listTrackSummaries")).toHaveLength(1);
    await harness.unmount();
  });
});

describe("useTrackList — async ordering", () => {
  it("cannot let a slow initial list undo a completed removal", async () => {
    // Two loads in the *same* context, resolving out of order — the store never changes, so a
    // context token cannot separate them. Only a per-request sequence can.
    const store = fakeStore();
    const harness = await mount({ store });
    expect(store.calls.filter((call) => call === "listTrackSummaries")).toHaveLength(1);

    store.auto = [summary("survivor")];
    await harness.current.remove("doomed");
    await harness.settle();
    expect(harness.current.tracks.map((t) => t.id)).toEqual(["survivor"]);

    // The initial list finally answers, with the world as it was before the delete.
    store.answer([summary("doomed"), summary("survivor")]);
    await harness.settle();

    expect(harness.current.tracks.map((t) => t.id)).toEqual(["survivor"]);
    await harness.unmount();
  });

  it("cannot publish a list from a removal that outlived its store", async () => {
    const first = fakeStore();
    first.auto = [summary("from-first")];
    first.parkDelete = true;
    const second = fakeStore();
    second.auto = [summary("from-second")];

    const harness = await mount({ store: first });
    const inFlight = harness.current.remove("t1");
    await harness.settle();

    await harness.rerender({ store: second });
    expect(harness.current.tracks.map((t) => t.id)).toEqual(["from-second"]);

    const listedByFirst = first.calls.filter((call) => call === "listTrackSummaries").length;
    first.releaseDelete?.();
    await inFlight;
    await harness.settle();

    expect(harness.current.tracks.map((t) => t.id)).toEqual(["from-second"]);
    // The replaced store was not asked again: a request whose answer can only be discarded
    // should not be made.
    expect(first.calls.filter((call) => call === "listTrackSummaries")).toHaveLength(listedByFirst);
    await harness.unmount();
  });

  it("a stale removal does not invalidate the replacement store's pending list", async () => {
    // **What the pre-request context guard is actually for.** Skipping the old store's re-list
    // is not merely a saved read. Issuing it would make it the *newest* request, so it would
    // publish the old store's rows and clear `loading`, and the replacement store's answer —
    // arriving after it — would be the one the sequence guard discards. The consumer would be
    // left looking at a store they had already navigated away from.
    const first = fakeStore();
    first.auto = [summary("from-first")];
    first.parkDelete = true;
    const second = fakeStore();

    const harness = await mount({ store: first });
    const removing = harness.current.remove("t1");
    await harness.settle();

    // The replacement's list is deliberately left pending across the stale mutation.
    await harness.rerender({ store: second });
    expect(second.pendingLists).toBe(1);

    first.releaseDelete?.();
    await removing;
    await harness.settle();

    // Now the new store answers. It must still be allowed to publish.
    second.answerOldest([summary("from-second")]);
    await harness.settle();

    expect(
      harness.current.tracks.map((t) => t.id),
      "the new store's list was invalidated",
    ).toEqual(["from-second"]);
    expect(harness.current.loading).toBe(false);
    await harness.unmount();
  });

  it("cannot publish a replaced store's list", async () => {
    const first = fakeStore();
    const second = fakeStore();
    second.auto = [summary("from-second")];
    const harness = await mount({ store: first });

    await harness.rerender({ store: second });
    first.answer([summary("from-first")]);
    await harness.settle();

    expect(harness.current.tracks.map((t) => t.id)).toEqual(["from-second"]);
    await harness.unmount();
  });

  it("publishes the second list when StrictMode remounts the effect", async () => {
    const store = fakeStore();
    const harness = await mount({ store }, true);

    expect(store.calls.filter((call) => call === "listTrackSummaries").length).toBeGreaterThan(1);
    store.answer([summary("answered-once")]);
    await harness.settle();

    expect(harness.current.tracks.map((t) => t.id)).toEqual(["answered-once"]);
    expect(harness.current.loading).toBe(false);
    await harness.unmount();
  });
});
