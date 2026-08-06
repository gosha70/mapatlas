// SPDX-License-Identifier: Apache-2.0

/**
 * MAP-ATLAS default persistence — a {@link StorageAdapter} backed by IndexedDB
 * (via the `idb` library) for tracks, events, and media blobs.
 *
 * Conforms to the persistence contract in `specs/api.md §3` and is verified by
 * the shared conformance suite shipped in `@mapatlas/core` (T2.1). The database
 * is opened lazily on first use so importing this module has no side effects
 * (SSR-safe at import time).
 */
import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import {
  newId,
  type Id,
  type MapEvent,
  type StorageAdapter,
  type Track,
} from "@mapatlas/core";

const DEFAULT_DB_NAME = "mapatlas";
const DB_VERSION = 1;

const TRACKS = "tracks";
const EVENTS = "events";
const BLOBS = "blobs";
const EVENTS_BY_TRACK = "byTrack";

interface MapAtlasSchema extends DBSchema {
  [TRACKS]: { key: Id; value: Track };
  [EVENTS]: {
    key: Id;
    value: MapEvent;
    indexes: { [EVENTS_BY_TRACK]: string };
  };
  [BLOBS]: { key: string; value: Blob };
}

function openStore(name: string): Promise<IDBPDatabase<MapAtlasSchema>> {
  return openDB<MapAtlasSchema>(name, DB_VERSION, {
    upgrade(database) {
      if (!database.objectStoreNames.contains(TRACKS)) {
        database.createObjectStore(TRACKS, { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains(EVENTS)) {
        const events = database.createObjectStore(EVENTS, { keyPath: "id" });
        // Sparse by nature: events without a trackId are absent from the index,
        // so an unscoped listEvents() must read the full store, not the index.
        events.createIndex(EVENTS_BY_TRACK, "trackId");
      }
      if (!database.objectStoreNames.contains(BLOBS)) {
        database.createObjectStore(BLOBS);
      }
    },
  });
}

/**
 * Construct the default IndexedDB-backed {@link StorageAdapter}. Pass a
 * `dbName` to isolate stores (e.g. per signed-in identity). A single lazily
 * opened connection is shared across all calls on the returned adapter.
 */
export function createIdbStorageAdapter(
  dbName: string = DEFAULT_DB_NAME,
): StorageAdapter {
  let dbp: Promise<IDBPDatabase<MapAtlasSchema>> | undefined;
  const db = (): Promise<IDBPDatabase<MapAtlasSchema>> =>
    (dbp ??= openStore(dbName));

  return {
    async saveTrack(t: Track): Promise<void> {
      await (await db()).put(TRACKS, t);
    },
    async getTrack(id: Id): Promise<Track | undefined> {
      return (await db()).get(TRACKS, id);
    },
    async listTracks(): Promise<Track[]> {
      return (await db()).getAll(TRACKS);
    },
    async deleteTrack(id: Id): Promise<void> {
      await (await db()).delete(TRACKS, id);
    },

    async saveEvent(e: MapEvent): Promise<void> {
      await (await db()).put(EVENTS, e);
    },
    async getEvent(id: Id): Promise<MapEvent | undefined> {
      return (await db()).get(EVENTS, id);
    },
    async listEvents(trackId?: Id): Promise<MapEvent[]> {
      const conn = await db();
      if (trackId === undefined) return conn.getAll(EVENTS);
      return conn.getAllFromIndex(EVENTS, EVENTS_BY_TRACK, trackId);
    },
    async deleteEvent(id: Id): Promise<void> {
      await (await db()).delete(EVENTS, id);
    },

    async putBlob(blob: Blob): Promise<string> {
      const key = newId();
      await (await db()).put(BLOBS, blob, key);
      return key;
    },
    async getBlob(key: string): Promise<Blob | undefined> {
      return (await db()).get(BLOBS, key);
    },
    async deleteBlob(key: string): Promise<void> {
      await (await db()).delete(BLOBS, key);
    },

    async clearAll(): Promise<void> {
      const conn = await db();
      const tx = conn.transaction([TRACKS, EVENTS, BLOBS], "readwrite");
      await Promise.all([
        tx.objectStore(TRACKS).clear(),
        tx.objectStore(EVENTS).clear(),
        tx.objectStore(BLOBS).clear(),
        tx.done,
      ]);
    },
  };
}
