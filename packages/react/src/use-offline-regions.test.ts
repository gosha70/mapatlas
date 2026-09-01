// @vitest-environment happy-dom
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { OfflineRegion, OfflineRegionStore } from "@mapatlas/core";

import { renderHook } from "./testing/render-hook.js";
import { useOfflineRegions } from "./use-offline-regions.js";

/**
 * A store that answers when told to, so "which list won" is decided here rather than by timing.
 *
 * `list` parks until `answer` is called unless `auto` is set — the hazards are about overlapping
 * async calls, and a store that resolves immediately cannot express "the older one settles last".
 */
interface FakeStore extends OfflineRegionStore {
  readonly calls: string[];
  answer(regions: OfflineRegion[]): void;
  auto?: OfflineRegion[] | undefined;
  failNext?: { kind: "download" | "delete"; error: Error } | undefined;
  /** Hold `download` open until {@link FakeStore.releaseDownload} is called. */
  parkDownload?: boolean | undefined;
  releaseDownload?: (() => void) | undefined;
}

function fakeStore(): FakeStore {
  const pending: ((regions: OfflineRegion[]) => void)[] = [];
  const calls: string[] = [];

  const reject = (kind: "download" | "delete"): Error | undefined => {
    if (store.failNext?.kind !== kind) return undefined;
    const { error } = store.failNext;
    store.failNext = undefined;
    return error;
  };

  const store: FakeStore = {
    calls,
    auto: undefined,
    failNext: undefined,
    parkDownload: undefined,
    releaseDownload: undefined,
    list: () => {
      calls.push("list");
      if (store.auto !== undefined) return Promise.resolve(store.auto);
      return new Promise<OfflineRegion[]>((resolve) => pending.push(resolve));
    },
    download: (region) => {
      calls.push(`download:${region.name}`);
      const failure = reject("download");
      if (failure !== undefined) return Promise.reject(failure);
      const created = { ...region, id: "minted-by-store" } as OfflineRegion;
      // Parked when asked, so the test can swap the store *while a download is running* —
      // which is the only way to reach the race between a mutation and a store replacement.
      if (store.parkDownload === true) {
        return new Promise<OfflineRegion>((resolve) => {
          store.releaseDownload = () => {
            resolve(created);
          };
        });
      }
      return Promise.resolve(created);
    },
    delete: (id) => {
      calls.push(`delete:${id}`);
      const failure = reject("delete");
      return failure === undefined ? Promise.resolve() : Promise.reject(failure);
    },
    estimateSize: () => Promise.resolve(0),
    answer: (regions) => {
      const waiting = pending.splice(0, pending.length);
      for (const resolve of waiting) resolve(regions);
    },
  };
  return store;
}

const region = (id: string, name = id): OfflineRegion => ({
  id,
  name,
  bbox: [0, 0, 1, 1],
  minZoom: 10,
  maxZoom: 12,
});

const request = (name: string): Parameters<OfflineRegionStore["download"]>[0] => ({
  name,
  bbox: [0, 0, 1, 1],
  minZoom: 10,
  maxZoom: 12,
});

interface Props {
  store: OfflineRegionStore;
}

const mount = async (props: Props, strict = false) =>
  renderHook((p: Props) => useOfflineRegions(p.store), props, { strict });

describe("useOfflineRegions — loading", () => {
  it("lists what the store holds", async () => {
    const store = fakeStore();
    store.auto = [region("r1"), region("r2")];
    const harness = await mount({ store });

    expect(harness.current.regions.map((r) => r.id)).toEqual(["r1", "r2"]);
    await harness.unmount();
  });

  it("preserves the store's order rather than imposing one", async () => {
    // **`OfflineRegionStore.list` states no order**, unlike `listTrackSummaries`, which is
    // contractually sorted. Sorting here would invent a contract the seam does not make — and
    // every other consumer of the store would then have to reimplement it identically. The fake
    // answers in an order no obvious sort would produce.
    const store = fakeStore();
    store.auto = [region("z-last-alphabetically"), region("a-first"), region("m-middle")];
    const harness = await mount({ store });

    expect(harness.current.regions.map((r) => r.id)).toEqual([
      "z-last-alphabetically",
      "a-first",
      "m-middle",
    ]);
    await harness.unmount();
  });

  it("cannot let a slow initial list undo a completed download", async () => {
    // **Two loads in the *same* context, resolving out of order.** The store never changes, so a
    // context token cannot separate them: the initial list and the post-download list carry the
    // same one. Here the initial list is parked, the download's list publishes, and only then
    // does the initial snapshot arrive — carrying the world as it was before the download. A
    // guard that checked context alone would let it through and silently undo the download.
    const store = fakeStore();
    // `auto` unset, so the first list parks until answered.
    const harness = await mount({ store });
    expect(store.calls.filter((call) => call === "list")).toHaveLength(1);

    store.auto = [region("downloaded")];
    await harness.current.download(request("downloaded"));
    await harness.settle();
    expect(harness.current.regions.map((r) => r.id)).toEqual(["downloaded"]);

    // The initial list finally answers, with the pre-download world.
    store.answer([]);
    await harness.settle();

    expect(harness.current.regions.map((r) => r.id)).toEqual(["downloaded"]);
    await harness.unmount();
  });

  it("cannot publish a list from a download that outlived its store", async () => {
    // **The race the initial-effect test does not reach.** A download against store A is still
    // running when the component swaps to store B. When A finally resolves, its refresh must
    // fail the context guard — and it only does if the context token was captured *before* the
    // download was awaited. Sampling it afterwards reads B's token, and A's list wins.
    const first = fakeStore();
    first.auto = [region("from-first")];
    first.parkDownload = true;
    const second = fakeStore();
    second.auto = [region("from-second")];

    const harness = await mount({ store: first });
    const inFlight = harness.current.download(request("slow"));
    await harness.settle();

    await harness.rerender({ store: second });
    expect(harness.current.regions.map((r) => r.id)).toEqual(["from-second"]);

    const listedByFirst = first.calls.filter((call) => call === "list").length;
    first.releaseDownload?.();
    await inFlight;
    await harness.settle();

    expect(harness.current.regions.map((r) => r.id)).toEqual(["from-second"]);
    // **And the replaced store was not asked again.** Publishing the answer is prevented by the
    // guard either way; not making the request is the separate claim, and without this it is
    // just a comment — the pointless list would otherwise go out and be silently discarded.
    expect(first.calls.filter((call) => call === "list")).toHaveLength(listedByFirst);
    await harness.unmount();
  });

  it("cannot publish a replaced store's list", async () => {
    const first = fakeStore();
    const second = fakeStore();
    second.auto = [region("from-second")];
    const harness = await mount({ store: first });

    await harness.rerender({ store: second });
    // The first store's list settles last, and must lose.
    first.answer([region("from-first")]);
    await harness.settle();

    expect(harness.current.regions.map((r) => r.id)).toEqual(["from-second"]);
    await harness.unmount();
  });
});

describe("useOfflineRegions — mutations refresh from the store", () => {
  it("re-lists after a download instead of appending what it returned", async () => {
    // The created region is discarded deliberately. Appending it would guess the store's
    // ordering *and* assume nothing else changed — so the fake returns a list the append could
    // not produce: the new region in the middle, and another region that appeared alongside it.
    const store = fakeStore();
    store.auto = [region("existing")];
    const harness = await mount({ store });

    store.auto = [region("existing"), region("minted-by-store"), region("appeared-too")];
    await harness.current.download(request("minted-by-store"));
    await harness.settle();

    expect(harness.current.regions.map((r) => r.id)).toEqual([
      "existing",
      "minted-by-store",
      "appeared-too",
    ]);
    expect(store.calls.filter((call) => call === "list")).toHaveLength(2);
    await harness.unmount();
  });

  it("re-lists after a removal, and deletes exactly the id it was given", async () => {
    const store = fakeStore();
    store.auto = [region("r1"), region("r2")];
    const harness = await mount({ store });

    store.auto = [region("r2")];
    await harness.current.remove("r1");
    await harness.settle();

    expect(store.calls).toContain("delete:r1");
    expect(harness.current.regions.map((r) => r.id)).toEqual(["r2"]);
    await harness.unmount();
  });

  it("fabricates no local success when a download rejects", async () => {
    const store = fakeStore();
    store.auto = [region("existing")];
    const harness = await mount({ store });

    store.failNext = { kind: "download", error: new Error("no space left") };
    await expect(harness.current.download(request("doomed"))).rejects.toThrow("no space left");
    await harness.settle();

    expect(harness.current.regions.map((r) => r.id)).toEqual(["existing"]);
    // And nothing was re-read for a download that did not happen.
    expect(store.calls.filter((call) => call === "list")).toHaveLength(1);
    await harness.unmount();
  });

  it("keeps a region on screen when its deletion rejects", async () => {
    // An optimistic filter would show the region gone while it is still on disk — the one
    // failure mode that matters here, because the consumer's next action is to free space.
    const store = fakeStore();
    store.auto = [region("r1"), region("r2")];
    const harness = await mount({ store });

    store.failNext = { kind: "delete", error: new Error("busy") };
    await expect(harness.current.remove("r1")).rejects.toThrow("busy");
    await harness.settle();

    expect(harness.current.regions.map((r) => r.id)).toEqual(["r1", "r2"]);
    await harness.unmount();
  });
});

describe("useOfflineRegions — lifecycle", () => {
  it("publishes the second list when StrictMode remounts the effect", async () => {
    const store = fakeStore();
    const harness = await mount({ store }, true);

    expect(store.calls.filter((call) => call === "list").length).toBeGreaterThan(1);
    store.answer([region("answered-once")]);
    await harness.settle();

    expect(harness.current.regions.map((r) => r.id)).toEqual(["answered-once"]);
    await harness.unmount();
  });

  // **A "downloads once under StrictMode" test was written here and removed.** It could not
  // fail: `download()` is an explicit call, and StrictMode double-invokes *effects*, not
  // callbacks, so nothing about StrictMode could make it fire twice. Stubbing StrictMode out of
  // the harness left it green — the same vacuity found in `useTrackRecorder`'s first attempt.
  // The test above earns its place because two lists really are in flight there.
});
