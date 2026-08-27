// SPDX-License-Identifier: Apache-2.0

/**
 * `@mapatlas/storage-idb` — the default persistence for a browser.
 *
 * Two stores with separate names, never one: user data and downloaded map assets have
 * opposite properties. Trips and photos are irreplaceable and small; map bytes are large,
 * replaceable, and the right thing to evict first. (ADR-0016)
 */

export type { IdbStorageAdapter, IdbStorageAdapterOptions } from "./storage-adapter.js";
export { createIdbStorageAdapter } from "./storage-adapter.js";

export type { IdbMapAssetStore, IdbMapAssetStoreOptions } from "./map-asset-store.js";
export {
  ASSET_SCHEMA_VERSION,
  ASSET_STORE,
  DEFAULT_ASSET_DATABASE_NAME,
  createIdbMapAssetStore,
} from "./map-asset-store.js";

export type { MapAtlasDatabase, MapAtlasSchema } from "./schema.js";
export {
  DEFAULT_DATABASE_NAME,
  INDEX,
  SCHEMA_VERSION,
  STORE,
  openMapAtlasDatabase,
} from "./schema.js";

/** Package identity, so a consumer can report which engine build it embeds. */
export const PACKAGE_NAME = "@mapatlas/storage-idb";
