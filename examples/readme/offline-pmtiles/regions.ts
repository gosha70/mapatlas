// SPDX-License-Identifier: Apache-2.0
import type { OfflineRegion, TileSource } from "@mapatlas/core";
import { createPMTilesRegionStore } from "@mapatlas/offline-pmtiles";
import { createIdbMapAssetStore } from "@mapatlas/storage-idb";

// Your archive, served by your application: the engine bundles no map data.
const basemap: TileSource = {
  id: "basemap",
  kind: "vector",
  transport: "pmtiles",
  url: new URL("/basemap.pmtiles", window.location.href).toString(),
  attribution: "© your basemap provider",
  // A policy declaration, and yours to make: bulk download runs only against a source you host
  // yourself or are explicitly licensed to prefetch. Absent, `download()` refuses.
  offlineLicensed: true,
};

// Downloaded regions are kept in IndexedDB. Keeping them is this store's job; making the renderer
// read them is a separate step — `installOfflineArchives`, in this package — and nothing below does it.
export const regions = createPMTilesRegionStore({
  sources: [basemap],
  assets: createIdbMapAssetStore(),
});

export function downloadValley(): Promise<OfflineRegion> {
  return regions.download(
    { name: "the valley", bbox: [6.9, 45.85, 7.1, 45.95], minZoom: 8, maxZoom: 14 },
    (fraction) => console.log(`${String(Math.round(fraction * 100))}%`),
  );
}
