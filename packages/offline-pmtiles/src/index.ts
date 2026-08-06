// SPDX-License-Identifier: Apache-2.0

/**
 * MAP-ATLAS offline map regions — a PMTiles-backed OfflineRegionStore plus
 * storage-persistence helpers. Renderer-neutral (no Leaflet, no React): a
 * renderer reads a downloaded region's tiles via the store's `readTile`.
 */
export { tilesForRegion, countTiles } from "./tiles";
export type { TileCoord } from "./tiles";

export {
  createPMTilesOfflineRegionStore,
  createMemoryTileCache,
  pmtilesTileByteSource,
} from "./store";
export type {
  TileCache,
  TileByteSource,
  PMTilesOfflineRegionStore,
  PMTilesOfflineOptions,
} from "./store";

export {
  requestPersistentStorage,
  isStoragePersisted,
  installGuidance,
} from "./persistence";
export type { InstallGuidance, InstallPlatform } from "./persistence";
