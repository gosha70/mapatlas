// SPDX-License-Identifier: Apache-2.0

/**
 * An IndexedDB-backed {@link TileCache} for the demo, so downloaded offline
 * regions survive a reload. Kept in the app (not the engine) because it is a
 * consumer wiring choice — a different consumer might cache tiles elsewhere.
 */
import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { TileCache } from "@mapatlas/offline-pmtiles";

const STORE = "tiles";

interface TileDBSchema extends DBSchema {
  [STORE]: { key: string; value: ArrayBuffer };
}

export function createIdbTileCache(dbName = "mapatlas-demo-tiles"): TileCache {
  let dbp: Promise<IDBPDatabase<TileDBSchema>> | undefined;
  const db = (): Promise<IDBPDatabase<TileDBSchema>> =>
    (dbp ??= openDB<TileDBSchema>(dbName, 1, {
      upgrade(database) {
        if (!database.objectStoreNames.contains(STORE)) {
          database.createObjectStore(STORE);
        }
      },
    }));

  return {
    async put(key, bytes) {
      await (await db()).put(STORE, bytes, key);
    },
    async get(key) {
      return (await db()).get(STORE, key);
    },
    async delete(key) {
      await (await db()).delete(STORE, key);
    },
    async keys(prefix) {
      const all = await (await db()).getAllKeys(STORE);
      return all.map(String).filter((k) => k.startsWith(prefix));
    },
  };
}
