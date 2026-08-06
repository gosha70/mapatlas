// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  createMemoryTileCache,
  createPMTilesOfflineRegionStore,
  type TileByteSource,
} from "./store";
import { tilesForRegion } from "./tiles";

const REGION = {
  name: "Elliott Bay",
  bbox: [-122.34, 47.6, -122.33, 47.61] as [number, number, number, number],
  minZoom: 14,
  maxZoom: 15,
};

/** A network source that can be switched "offline" (throws) after download. */
function fakeSource() {
  const state = { online: true, calls: 0 };
  const source: TileByteSource = {
    getTile(z, x, y) {
      state.calls++;
      if (!state.online) throw new Error("network disabled");
      return Promise.resolve(
        new TextEncoder().encode(`tile-${z}/${x}/${y}`).buffer,
      );
    },
  };
  return { source, state };
}

describe("createPMTilesOfflineRegionStore", () => {
  it("downloads a bbox × zoom range, reporting progress and size", async () => {
    const { source } = fakeSource();
    const store = createPMTilesOfflineRegionStore({
      source,
      cache: createMemoryTileCache(),
      now: () => 1700,
    });

    let lastProgress = 0;
    const region = await store.download(REGION, (f) => (lastProgress = f));

    expect(lastProgress).toBe(1);
    expect(region.id).toBeTruthy();
    expect(region.sizeBytes).toBeGreaterThan(0);
    expect(region.downloadedAt).toBe(1700);
    expect(await store.list()).toEqual([region]);
  });

  it("renders offline: readTile serves every downloaded tile with the network disabled", async () => {
    const { source, state } = fakeSource();
    const store = createPMTilesOfflineRegionStore({
      source,
      cache: createMemoryTileCache(),
    });
    const region = await store.download(REGION);

    // Cut the network. Any getTile now throws.
    state.online = false;

    const tiles = tilesForRegion(REGION.bbox, REGION.minZoom, REGION.maxZoom);
    expect(tiles.length).toBeGreaterThan(0);
    for (const t of tiles) {
      const bytes = await store.readTile(region.id, t.z, t.x, t.y);
      expect(bytes).toBeDefined();
      expect(new TextDecoder().decode(bytes!)).toBe(
        `tile-${t.z}/${t.x}/${t.y}`,
      );
    }
  });

  it("deletes a region's tiles and metadata", async () => {
    const { source } = fakeSource();
    const store = createPMTilesOfflineRegionStore({
      source,
      cache: createMemoryTileCache(),
    });
    const region = await store.download(REGION);
    const t = tilesForRegion(REGION.bbox, REGION.minZoom, REGION.maxZoom)[0]!;

    await store.delete(region.id);

    expect(await store.list()).toEqual([]);
    expect(await store.readTile(region.id, t.z, t.x, t.y)).toBeUndefined();
  });

  it("estimates size from tile count without touching the network", async () => {
    const { source, state } = fakeSource();
    const store = createPMTilesOfflineRegionStore({
      source,
      cache: createMemoryTileCache(),
      avgTileBytes: 1000,
    });
    const n = tilesForRegion(
      REGION.bbox,
      REGION.minZoom,
      REGION.maxZoom,
    ).length;
    expect(await store.estimateSize(REGION)).toBe(n * 1000);
    expect(state.calls).toBe(0);
  });

  it("keeps multiple regions independent", async () => {
    const { source } = fakeSource();
    const store = createPMTilesOfflineRegionStore({
      source,
      cache: createMemoryTileCache(),
    });
    const a = await store.download(REGION);
    const b = await store.download({ ...REGION, name: "Other" });
    expect(new Set([a.id, b.id]).size).toBe(2);
    expect((await store.list()).map((r) => r.id).sort()).toEqual(
      [a.id, b.id].sort(),
    );
  });
});
