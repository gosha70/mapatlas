// SPDX-License-Identifier: Apache-2.0

/**
 * `@mapatlas/offline-pmtiles` — PMTiles-backed OfflineRegionStore for offline map regions.
 */

export const PACKAGE_NAME = "@mapatlas/offline-pmtiles";
export { OfflineLicenseError, assertOfflineLicensed } from "./offline-license.js";
export { createPMTilesRegionStore, UnsupportedTransportError } from "./region-store.js";
export type { RegionFetch } from "./region-store.js";
