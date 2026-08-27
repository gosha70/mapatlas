// SPDX-License-Identifier: Apache-2.0

import type { MapAssetStore } from "@mapatlas/core";
import type { DBSchema, IDBPDatabase } from "idb";
import { openDB } from "idb";

/**
 * Downloaded map assets, in a store of their own.
 *
 * A **separate name**, not merely a separate object store: the point of ADR-0016 is that
 * clearing one cannot reach the other, and sharing a name would put both behind the same
 * lifecycle — one `deleteDatabase`, one version upgrade, one accidental `clear()` away from
 * taking the user's trips with the basemap.
 *
 * Map bytes are large and replaceable; tracks and photos are irreplaceable. Keeping them
 * apart is what lets a consumer evict the former first, and what stops a sign-out wipe
 * costing a multi-hundred-megabyte re-download.
 */
export const DEFAULT_ASSET_DATABASE_NAME = "mapatlas-assets";
export const ASSET_SCHEMA_VERSION = 1;
export const ASSET_STORE = "assets";

interface MapAssetSchema extends DBSchema {
  [ASSET_STORE]: { key: string; value: Blob };
}

export interface IdbMapAssetStoreOptions {
  databaseName?: string;
}

export interface IdbMapAssetStore extends MapAssetStore {
  close(): Promise<void>;
}

export function createIdbMapAssetStore(options: IdbMapAssetStoreOptions = {}): IdbMapAssetStore {
  let connection: Promise<IDBPDatabase<MapAssetSchema>> | undefined;

  const db = (): Promise<IDBPDatabase<MapAssetSchema>> => {
    connection ??= openDB<MapAssetSchema>(
      options.databaseName ?? DEFAULT_ASSET_DATABASE_NAME,
      ASSET_SCHEMA_VERSION,
      {
        upgrade(database) {
          database.createObjectStore(ASSET_STORE);
        },
      },
    );
    return connection;
  };

  return {
    put: async (key, data) => {
      await (await db()).put(ASSET_STORE, data, key);
    },

    get: async (key) => (await db()).get(ASSET_STORE, key),

    delete: async (key) => {
      await (await db()).delete(ASSET_STORE, key);
    },

    list: async () => (await db()).getAllKeys(ASSET_STORE),

    estimateBytes: async () => {
      // Summed from what is held rather than from navigator.storage.estimate(), which
      // reports the whole origin — including the trips this store deliberately excludes.
      const assets = await (await db()).getAll(ASSET_STORE);
      return assets.reduce((total, asset) => total + asset.size, 0);
    },

    clear: async () => {
      await (await db()).clear(ASSET_STORE);
      // Trips are in another database entirely and are deliberately untouched.
    },

    close: async () => {
      if (connection === undefined) return;
      (await connection).close();
      connection = undefined;
    },
  };
}
