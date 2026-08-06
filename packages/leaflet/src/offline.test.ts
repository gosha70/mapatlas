// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

/**
 * T6.1 acceptance: a PMTiles-backed OfflineRegionStore downloads a bbox×zoom
 * range, lists/deletes regions, and estimates size — and a downloaded region
 * renders with the network disabled (the offline tile layer draws from the
 * cache and never calls `fetch`).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PmtilesOfflineRegionStore,
  createOfflineTileLayer,
  countTiles,
  enumerateTiles,
} from "./offline.js";
import type { TileFetcher } from "./offline.js";

// A fake archive: every tile in the enumerated range yields deterministic bytes.
const fakeFetcher: TileFetcher = async (z, x, y) =>
  new Uint8Array([z, x & 0xff, y & 0xff, 42]);

const BBOX: [number, number, number, number] = [-0.2, 51.4, 0.0, 51.6];

afterEach(() => vi.restoreAllMocks());

describe("PmtilesOfflineRegionStore", () => {
  it("requires an archiveUrl or a tileFetcher", () => {
    expect(() => new PmtilesOfflineRegionStore()).toThrow(/archiveUrl/);
  });

  it("downloads, lists, and deletes a region with progress", async () => {
    const store = new PmtilesOfflineRegionStore({ tileFetcher: fakeFetcher });
    const progress: number[] = [];
    const region = await store.download(
      { name: "london", bbox: BBOX, minZoom: 10, maxZoom: 12 },
      (f) => progress.push(f),
    );

    expect(region.id).toBeTruthy();
    expect(region.sizeBytes).toBeGreaterThan(0);
    expect(region.downloadedAt).toBeTypeOf("number");
    expect(progress.at(-1)).toBe(1);

    expect(await store.list()).toHaveLength(1);
    await store.delete(region.id);
    expect(await store.list()).toHaveLength(0);
  });

  it("estimates size from the tile count", async () => {
    const store = new PmtilesOfflineRegionStore({
      tileFetcher: fakeFetcher,
      avgTileBytes: 1000,
    });
    const n = countTiles(BBOX, 10, 12);
    const est = await store.estimateSize({
      bbox: BBOX,
      minZoom: 10,
      maxZoom: 12,
    });
    expect(est).toBe(n * 1000);
  });

  it("renders a downloaded region offline — no network calls", async () => {
    const store = new PmtilesOfflineRegionStore({ tileFetcher: fakeFetcher });
    const region = await store.download({
      name: "london",
      bbox: BBOX,
      minZoom: 10,
      maxZoom: 11,
    });
    expect(region.sizeBytes).toBeGreaterThan(0);

    // Disable the network entirely; rendering must not touch it.
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("network disabled"));
    // jsdom lacks object URLs; install a stub, then assert it's used (not fetch).
    const createObjectURL = vi.fn(() => "blob:tile");
    globalThis.URL.createObjectURL = createObjectURL;
    globalThis.URL.revokeObjectURL = vi.fn();

    const layer = createOfflineTileLayer(store.cache);

    // A cached tile: pick the first enumerated coordinate.
    const [coord] = enumerateTiles(BBOX, 10, 11);
    const tile = layer.createTile(
      { x: coord!.x, y: coord!.y, z: coord!.z } as never,
      () => {},
    ) as HTMLImageElement;
    expect(tile.tagName).toBe("IMG");
    expect(tile.src).toBe("blob:tile");
    expect(createObjectURL).toHaveBeenCalledTimes(1);

    // A tile far outside the region falls back to a transparent data URI.
    const missing = layer.createTile(
      { x: 0, y: 0, z: 11 } as never,
      () => {},
    ) as HTMLImageElement;
    expect(missing.src.startsWith("data:image/png")).toBe(true);

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
