// SPDX-License-Identifier: Apache-2.0

/**
 * `@mapatlas/offline-pmtiles` — PMTiles-backed OfflineRegionStore for offline map regions.
 */

export const PACKAGE_NAME = "@mapatlas/offline-pmtiles";
export {
  MissingArchiveError,
  createStoredArchiveSource,
  installOfflineArchives,
} from "./archive-source.js";
export type { ArchiveRegistrar } from "./archive-source.js";
// `assertOfflineLicensed` is deliberately **not** published. It is the store's internal guard,
// `api.md` never declared it, and a consumer calling it directly would be checking a licence
// the store checks again anyway — while making the check's signature a compatibility promise.
// `OfflineLicenseError` is published because a caller has to be able to catch it.
export { OfflineLicenseError } from "./offline-license.js";
export {
  createPMTilesRegionStore,
  UnknownArchiveSizeError,
  UnsupportedTransportError,
} from "./region-store.js";
export type { RegionFetch } from "./region-store.js";
