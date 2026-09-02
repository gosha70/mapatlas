// @vitest-environment happy-dom
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { StorageAdapter, Track, TrackDraft } from "@mapatlas/core";
import { createTrackDraft } from "@mapatlas/core";

import { renderHook } from "./testing/render-hook.js";
import type { UseTrackDraftOptions } from "./use-track-draft.js";
import { useTrackDraft, useTrackDraftInternal } from "./use-track-draft.js";

/**
 * A **real** `createTrackDraft`, not a fake.
 *
 * The point of this hook is that core owns the editing, so a fake draft would let React's own
 * bookkeeping stand in for the thing under test — `canUndo` could be computed here and agree
 * with a fake that computed it the same way. The counting wrapper below records only *which*
 * calls arrived, and answers everything from the genuine draft.
 */
interface CountingDraft extends TrackDraft {
  readonly calls: string[];
  readonly subscriptions: number;
}

function countingDraft(from?: Track): CountingDraft {
  const inner = createTrackDraft(from);
  const calls: string[] = [];
  let subscriptions = 0;

  return {
    get points() {
      return inner.points;
    },
    get canUndo() {
      return inner.canUndo;
    },
    get canRedo() {
      return inner.canRedo;
    },
    get untimedIndices() {
      return inner.untimedIndices;
    },
    get calls() {
      return calls;
    },
    get subscriptions() {
      return subscriptions;
    },
    append: (p) => {
      calls.push(`append:${JSON.stringify(p)}`);
      inner.append(p);
    },
    insertAt: (i, p) => {
      calls.push(`insertAt:${String(i)}:${JSON.stringify(p)}`);
      inner.insertAt(i, p);
    },
    moveAt: (i, to) => {
      calls.push(`moveAt:${String(i)}:${JSON.stringify(to)}`);
      inner.moveAt(i, to);
    },
    removeAt: (i) => {
      calls.push(`removeAt:${String(i)}`);
      inner.removeAt(i);
    },
    setTimeAt: (i, t) => {
      calls.push(`setTimeAt:${String(i)}:${String(t)}`);
      inner.setTimeAt(i, t);
    },
    interpolateTimes: (o) => {
      calls.push(`interpolateTimes:${JSON.stringify(o)}`);
      inner.interpolateTimes(o);
    },
    breakAt: (i) => {
      calls.push(`breakAt:${String(i)}`);
      inner.breakAt(i);
    },
    undo: () => {
      calls.push("undo");
      inner.undo();
    },
    redo: () => {
      calls.push("redo");
      inner.redo();
    },
    onChange: (cb) => {
      subscriptions += 1;
      const off = inner.onChange(cb);
      return () => {
        subscriptions -= 1;
        off();
      };
    },
    toTrack: (meta) => {
      calls.push(`toTrack:${JSON.stringify(meta ?? {})}`);
      return inner.toTrack(meta);
    },
  };
}

function fakeStore(): StorageAdapter & {
  saved: Track[];
  attempted: Track[];
  failSave?: Error | undefined;
} {
  const store = {
    saved: [] as Track[],
    /** Every track handed to `saveTrack`, **including rejected ones**. */
    attempted: [] as Track[],
    failSave: undefined as Error | undefined,
    saveTrack: (t: Track) => {
      store.attempted.push(t);
      if (store.failSave !== undefined) return Promise.reject(store.failSave);
      store.saved.push(t);
      return Promise.resolve();
    },
    getTrack: () => Promise.resolve(undefined),
    listTrackSummaries: () => Promise.resolve([]),
    deleteTrack: () => Promise.resolve(),
    saveEvent: () => Promise.resolve(),
    getEvent: () => Promise.resolve(undefined),
    listEvents: () => Promise.resolve([]),
    deleteEvent: () => Promise.resolve(),
    putBlob: () => Promise.resolve(""),
    getBlob: () => Promise.resolve(undefined),
    deleteBlob: () => Promise.resolve(),
    clearAll: () => Promise.resolve(),
  };
  return store as StorageAdapter & {
    saved: Track[];
    attempted: Track[];
    failSave?: Error | undefined;
  };
}

const recorded = (id: string): Track => ({
  id,
  startedAt: 1_000,
  status: "finalized",
  origin: "recorded",
  points: [
    { lat: 1, lng: 2, t: 1_000 },
    { lat: 1.001, lng: 2.001, t: 2_000 },
  ],
  segments: [{ id: `${id}-s1`, startIndex: 0, endIndex: 1, startedAt: 1_000 }],
});

interface Props extends UseTrackDraftOptions {
  build?: ((from?: Track) => TrackDraft) | undefined;
}

const mount = async (props: Props, strict = false) =>
  renderHook((p: Props) => useTrackDraftInternal(p, p.build ?? createTrackDraft), props, {
    strict,
  });

describe("useTrackDraft — state comes from the draft", () => {
  it("starts blank with nothing to undo", async () => {
    const harness = await mount({});

    expect(harness.current.points).toEqual([]);
    expect(harness.current.canUndo).toBe(false);
    expect(harness.current.canRedo).toBe(false);
    expect(harness.current.untimedIndices).toEqual([]);
    await harness.unmount();
  });

  it("seeds from a track without mutating it, and seeding is not an edit", async () => {
    const source = recorded("t1");
    const before = structuredClone(source);
    const harness = await mount({ from: source });

    expect(harness.current.points).toHaveLength(2);
    expect(harness.current.canUndo, "seeding left an undo entry").toBe(false);
    expect(source).toEqual(before);
    await harness.unmount();
  });

  it("republishes points, history and untimed indices from the draft after each edit", async () => {
    // Read back from the draft rather than tracked alongside it: a second copy of `canUndo` in
    // React would agree with the first right up until it did not, and nothing would say which
    // was right.
    const harness = await mount({});

    harness.current.append({ lat: 1, lng: 2 });
    await harness.settle();
    expect(harness.current.points).toHaveLength(1);
    expect(harness.current.canUndo).toBe(true);
    expect(harness.current.untimedIndices, "an appended vertex must be untimed").toEqual([0]);

    harness.current.setTimeAt(0, 5_000);
    await harness.settle();
    expect(harness.current.untimedIndices).toEqual([]);

    harness.current.undo();
    await harness.settle();
    expect(harness.current.untimedIndices).toEqual([0]);
    expect(harness.current.canRedo).toBe(true);
    await harness.unmount();
  });

  it("appends an untimed vertex, not one it timed itself", async () => {
    // `append(LatLng)` deliberately creates an untimed point. Enriching it with a timestamp here
    // would leave `untimedIndices` permanently empty and let `save()` succeed on geometry nobody
    // had timed — the check `toTrack` exists to make.
    const draft = countingDraft();
    const harness = await mount({ build: () => draft });

    harness.current.append({ lat: 1, lng: 2 });
    await harness.settle();

    expect(draft.calls).toEqual(['append:{"lat":1,"lng":2}']);
    expect(harness.current.untimedIndices).toEqual([0]);
    await harness.unmount();
  });

  it("delegates every edit with its exact arguments", async () => {
    const draft = countingDraft();
    const harness = await mount({ build: () => draft });

    harness.current.append({ lat: 1, lng: 2 });
    harness.current.insertAt(0, { lat: 3, lng: 4 });
    harness.current.moveAt(1, { lat: 5, lng: 6 });
    harness.current.setTimeAt(0, 1_000);
    harness.current.setTimeAt(1, 2_000);
    harness.current.breakAt(1);
    harness.current.interpolateTimes({ startedAt: 1_000, endedAt: 2_000 });
    harness.current.removeAt(1);
    harness.current.undo();
    harness.current.redo();
    await harness.settle();

    expect(draft.calls).toEqual([
      'append:{"lat":1,"lng":2}',
      'insertAt:0:{"lat":3,"lng":4}',
      'moveAt:1:{"lat":5,"lng":6}',
      "setTimeAt:0:1000",
      "setTimeAt:1:2000",
      "breakAt:1",
      'interpolateTimes:{"startedAt":1000,"endedAt":2000}',
      "removeAt:1",
      "undo",
      "redo",
    ]);
    await harness.unmount();
  });

  it("leaves the snapshot untouched when a core edit rejects", async () => {
    const harness = await mount({});
    harness.current.append({ lat: 1, lng: 2 });
    await harness.settle();
    const before = harness.current.points;

    // Out of range: core refuses, emits no change, and React has nothing to publish.
    expect(() => {
      harness.current.removeAt(9);
    }).toThrow();
    await harness.settle();

    expect(harness.current.points).toBe(before);
    await harness.unmount();
  });
});

describe("useTrackDraft — the draft context is the track id", () => {
  it("keeps unsaved edits when the same id arrives as a new object", async () => {
    // The ordinary React case: a parent re-renders and hands down an equivalent fresh `Track`.
    // Rebuilding on object identity would silently discard everything the user had drawn.
    const harness = await mount({ from: recorded("t1") });
    harness.current.append({ lat: 9, lng: 9 });
    await harness.settle();
    expect(harness.current.points).toHaveLength(3);

    await harness.rerender({ from: recorded("t1") });

    expect(harness.current.points, "a new object with the same id rebuilt the draft").toHaveLength(
      3,
    );
    expect(harness.current.canUndo, "the history was discarded").toBe(true);
    await harness.unmount();
  });

  it("installs a new draft when the id changes", async () => {
    const harness = await mount({ from: recorded("t1") });
    harness.current.append({ lat: 9, lng: 9 });
    await harness.settle();
    expect(harness.current.points).toHaveLength(3);

    await harness.rerender({ from: recorded("t2") });

    expect(harness.current.points).toHaveLength(2);
    expect(harness.current.canUndo).toBe(false);
    await harness.unmount();
  });

  it("begins a blank draft when the track is removed", async () => {
    const harness = await mount({ from: recorded("t1") });
    await harness.rerender({});

    expect(harness.current.points).toEqual([]);
    await harness.unmount();
  });

  it("releases the old draft's subscription when the draft is replaced", async () => {
    const first = countingDraft(recorded("t1"));
    const second = countingDraft(recorded("t2"));
    const drafts = [first, second];
    let built = 0;
    const build = (): TrackDraft => drafts[Math.min(built++, 1)]!;

    const harness = await mount({ from: recorded("t1"), build });
    expect(first.subscriptions).toBe(1);

    await harness.rerender({ from: recorded("t2"), build });

    expect(first.subscriptions, "the replaced draft is still subscribed").toBe(0);
    expect(second.subscriptions).toBe(1);
    await harness.unmount();
    expect(second.subscriptions).toBe(0);
  });
});

describe("useTrackDraft — saving", () => {
  it("refuses to reach storage while a point is untimed", async () => {
    const store = fakeStore();
    const harness = await mount({ store });
    harness.current.append({ lat: 1, lng: 2 });
    await harness.settle();

    await expect(harness.current.save()).rejects.toThrow();

    expect(store.saved, "an incomplete draft reached storage").toEqual([]);
    await harness.unmount();
  });

  it("resolves with the authored track and persists exactly it", async () => {
    const store = fakeStore();
    const harness = await mount({ store });
    harness.current.append({ lat: 1, lng: 2 });
    harness.current.setTimeAt(0, 1_000);
    harness.current.append({ lat: 3, lng: 4 });
    harness.current.setTimeAt(1, 2_000);
    await harness.settle();

    const saved = await harness.current.save();

    expect(saved.origin).toBe("authored");
    expect(store.saved).toHaveLength(1);
    expect(store.saved[0]).toBe(saved);
    await harness.unmount();
  });

  it("authors without a store, touching no adapter", async () => {
    const harness = await mount({});
    harness.current.append({ lat: 1, lng: 2 });
    harness.current.setTimeAt(0, 1_000);
    await harness.settle();

    const saved = await harness.current.save();

    expect(saved.origin).toBe("authored");
    expect(saved.points).toHaveLength(1);
    await harness.unmount();
  });
});

describe("useTrackDraft — one session, one identity", () => {
  const timedBlank = async (store?: StorageAdapter) => {
    const harness = await mount(store === undefined ? {} : { store });
    harness.current.append({ lat: 1, lng: 2 });
    harness.current.setTimeAt(0, 1_000);
    await harness.settle();
    return harness;
  };

  it("reuses the first id after a rejected save, rather than minting another", async () => {
    // **The rule that matters most.** A write that rejects may still have landed, so retrying
    // under a freshly minted id would create a second trip instead of overwriting the uncertain
    // first one. The id is therefore adopted *before* `saveTrack` is awaited.
    const store = fakeStore();
    store.failSave = new Error("quota exceeded");
    const harness = await timedBlank(store);

    await expect(harness.current.save()).rejects.toThrow("quota exceeded");
    store.failSave = undefined;
    const retried = await harness.current.save();

    // **Compared against the *failed* attempt, not against the retry's own id.** Asserting that
    // the stored track matches what the retry returned is true however the id was chosen, which
    // is why the first version of this test could not see an id minted after a successful write.
    expect(store.attempted).toHaveLength(2);
    expect(store.attempted[1]?.id, "the retry minted a second identity").toBe(
      store.attempted[0]?.id,
    );
    expect(retried.id).toBe(store.attempted[0]?.id);
    expect(store.saved).toHaveLength(1);
    await harness.unmount();
  });

  it("keeps one id across later edit-and-save cycles", async () => {
    const store = fakeStore();
    const harness = await timedBlank(store);
    const first = await harness.current.save();

    harness.current.append({ lat: 3, lng: 4 });
    harness.current.setTimeAt(1, 2_000);
    await harness.settle();
    const second = await harness.current.save();

    expect(second.id).toBe(first.id);
    expect(store.saved.map((t) => t.id)).toEqual([first.id, first.id]);
    await harness.unmount();
  });

  it("keeps a rejected save's edits, history and identity", async () => {
    const store = fakeStore();
    store.failSave = new Error("offline");
    const harness = await timedBlank(store);

    await expect(harness.current.save()).rejects.toThrow("offline");
    await harness.settle();

    expect(harness.current.points).toHaveLength(1);
    expect(harness.current.canUndo).toBe(true);
    await harness.unmount();
  });

  it("saves a seeded draft under from.id, never an adopted one", async () => {
    // An existing trip must not fork on its first save.
    const store = fakeStore();
    const harness = await mount({ from: recorded("seeded-1"), store });

    const saved = await harness.current.save();

    expect(saved.id).toBe("seeded-1");
    expect(store.saved[0]?.id).toBe("seeded-1");
    await harness.unmount();
  });

  it("starts a fresh identity when the draft is replaced", async () => {
    // A different track is a different session: carrying the adopted id across would write the
    // new draft over the old one's record.
    const store = fakeStore();
    const harness = await timedBlank(store);
    const first = await harness.current.save();

    await harness.rerender({ store, from: recorded("t9") });
    const second = await harness.current.save();

    expect(second.id).toBe("t9");
    expect(second.id).not.toBe(first.id);
    await harness.unmount();
  });
});

describe("useTrackDraft — the public wrapper", () => {
  it("passes its options through to a real draft", async () => {
    // The tests above drive `useTrackDraftInternal`, so the exported function's body would
    // otherwise be untested: it could discard `from` or `store` and every one of them would
    // still pass, and a discarded argument type-checks perfectly.
    const store = fakeStore();
    const harness = await renderHook((p: UseTrackDraftOptions) => useTrackDraft(p), {
      from: recorded("wrapped-1"),
      store,
    });

    expect(harness.current.points).toHaveLength(2);
    const saved = await harness.current.save();

    expect(saved.id).toBe("wrapped-1");
    expect(store.saved[0]?.id).toBe("wrapped-1");
    await harness.unmount();
  });
});
