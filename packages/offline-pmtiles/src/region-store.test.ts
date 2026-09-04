// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { createMemoryMapAssetStore } from "@mapatlas/core/testing";
import type { MapAssetStore, TileSource } from "@mapatlas/core";

import { OfflineLicenseError } from "./offline-license.js";
import { UnsupportedTransportError, createPMTilesRegionStore } from "./region-store.js";
import type { RegionFetch } from "./region-store.js";

const archive = (id: string, over: Partial<TileSource> = {}): TileSource =>
  ({
    id,
    kind: "raster-dem",
    transport: "pmtiles",
    url: `https://self-hosted.invalid/${id}.pmtiles`,
    attribution: "fixture",
    offlineLicensed: true,
    ...over,
  }) as TileSource;

/** Records what was fetched, and answers with identifiable bytes per url. */
function fetcher(): RegionFetch & { fetched: string[]; sized: string[] } {
  const fetched: string[] = [];
  const sized: string[] = [];
  return {
    fetched,
    sized,
    bytes: (url) => {
      fetched.push(url);
      return Promise.resolve(new Blob([`bytes-of:${url}`]));
    },
    size: (url) => {
      sized.push(url);
      return Promise.resolve(url.length);
    },
  };
}

const REGION = {
  name: "test region",
  bbox: [10, 50, 11, 51] as [number, number, number, number],
  minZoom: 8,
  maxZoom: 12,
};

const build = (
  sources: TileSource[],
): {
  store: ReturnType<typeof createPMTilesRegionStore>;
  assets: MapAssetStore;
  net: ReturnType<typeof fetcher>;
} => {
  const assets = createMemoryMapAssetStore();
  const net = fetcher();
  return { store: createPMTilesRegionStore({ sources, assets, fetcher: net }), assets, net };
};

describe("createPMTilesRegionStore (ADR-0034)", () => {
  it("copies the whole archive into the asset store", async () => {
    // §5's "cached whole for offline": the archive is the unit, and bbox/zoom describe the
    // region rather than selecting within it. A range-served region can look downloaded and
    // fail in the field (ADR-0017), which is what copying the bytes avoids.
    const { store, assets, net } = build([archive("terrain")]);
    const region = await store.download({ ...REGION, sourceIds: ["terrain"] });

    expect(net.fetched, "the archive itself, once").toEqual([
      "https://self-hosted.invalid/terrain.pmtiles",
    ]);
    const keys = await assets.list();
    const stored = keys.filter((key) => key.includes("/archive/"));
    expect(stored, "one archive blob, keyed by region and source").toHaveLength(1);
    expect(stored[0]).toContain(region.id);
    expect(stored[0]).toContain("terrain");
  });

  it("returns a region carrying its own id, size and timestamp", async () => {
    const { store } = build([archive("terrain")]);
    const before = Date.now();
    const region = await store.download({ ...REGION, sourceIds: ["terrain"] });
    expect(region.id, "minted, not the caller's").toEqual(expect.any(String));
    expect(region.sizeBytes, "the bytes actually stored").toBeGreaterThan(0);
    expect(region.downloadedAt ?? 0).toBeGreaterThanOrEqual(before);
    expect(region.name).toBe(REGION.name);
  });

  it("lists what it downloaded, and forgets it on delete", async () => {
    const { store, assets } = build([archive("a"), archive("b")]);
    const one = await store.download({ ...REGION, sourceIds: ["a"] });
    await store.download({ ...REGION, sourceIds: ["b"] });
    expect(await store.list()).toHaveLength(2);

    await store.delete(one.id);
    const left = await store.list();
    expect(left, "the other region survives").toHaveLength(1);
    expect(left[0]?.id).not.toBe(one.id);
    const orphans = (await assets.list()).filter((key) => key.includes(one.id));
    expect(orphans, "delete must take the region's archives with it").toEqual([]);
  });

  it("estimates from the archive's size, and says so by asking for it", async () => {
    const { store, net } = build([archive("terrain")]);
    const size = await store.estimateSize({ ...REGION, sourceIds: ["terrain"] });
    expect(net.sized).toEqual(["https://self-hosted.invalid/terrain.pmtiles"]);
    expect(size).toBeGreaterThan(0);
    expect(net.fetched, "estimating must not download").toEqual([]);
  });

  it("refuses an unlicensed source from download AND from estimateSize", async () => {
    // One check, two callers (ADR-0033): a UI able to quote a size for a region the store will
    // then refuse has already misled its user.
    const { store, net } = build([archive("unlicensed", { offlineLicensed: false })]);
    await expect(store.download({ ...REGION, sourceIds: ["unlicensed"] })).rejects.toThrow(
      OfflineLicenseError,
    );
    await expect(store.estimateSize({ ...REGION, sourceIds: ["unlicensed"] })).rejects.toThrow(
      OfflineLicenseError,
    );
    expect(net.fetched, "nothing may be fetched from a refused source").toEqual([]);
    expect(net.sized).toEqual([]);
  });

  it("refuses a non-pmtiles transport rather than skipping it", async () => {
    // Skipping would produce a region that looks downloaded and is not — ADR-0017's failure.
    const { store, net } = build([
      archive("ok"),
      archive("raster", { transport: "template", url: "https://x.invalid/{z}/{x}/{y}.png" }),
    ]);
    await expect(store.download({ ...REGION, sourceIds: ["ok", "raster"] })).rejects.toThrow(
      UnsupportedTransportError,
    );
    expect(net.fetched, "the refusal must precede any fetching").toEqual([]);
    await expect(store.estimateSize({ ...REGION, sourceIds: ["ok", "raster"] })).rejects.toThrow(
      UnsupportedTransportError,
    );
  });

  it("defaults sourceIds to base and overlay only, which omits terrain", async () => {
    // Recorded rather than fixed (ADR-0034): the default has no criterion driving a change, but
    // a defaulted region omits the DEM — the exact thing T6.1's acceptance criterion is about.
    const { store, net } = build([
      archive("contours", { role: "overlay" }),
      archive("terrain", { role: "hillshade" }),
    ]);
    await store.download(REGION);
    expect(net.fetched.map((url) => url.split("/").pop())).toEqual(["contours.pmtiles"]);
  });

  it("reports progress once per source, ending at one", async () => {
    const seen: number[] = [];
    const { store } = build([archive("a"), archive("b")]);
    await store.download({ ...REGION, sourceIds: ["a", "b"] }, (fraction) => {
      seen.push(fraction);
    });
    expect(seen).toEqual([0.5, 1]);
  });

  it("keeps its manifests under its own prefix, which clear() takes with it", async () => {
    const { store, assets } = build([archive("a")]);
    await store.download({ ...REGION, sourceIds: ["a"] });
    expect((await assets.list()).every((key) => key.startsWith("mapatlas/"))).toBe(true);

    await assets.clear();
    expect(await store.list(), "clear() wipes map bytes together (ADR-0016)").toEqual([]);
  });
});
