// SPDX-License-Identifier: Apache-2.0

/**
 * @mapatlas/storage-idb — the default {@link StorageAdapter} for MAP-ATLAS,
 * backed by IndexedDB via the `idb` library (tasks T2.2).
 *
 * Three object stores — `tracks`, `events`, `blobs` — mirror the persistence
 * contract in `api.md §3`. Events carry a `trackId` index so `listEvents(id)`
 * is a cheap range query. `clearAll()` empties all three stores, satisfying the
 * "leave no local data" guarantee consumers rely on for a device wipe.
 */
import type { DBSchema, IDBPDatabase } from "idb";
import { wrap } from "idb";
import type { Id, MapEvent, StorageAdapter, Track } from "@mapatlas/core";
import { newId } from "@mapatlas/core";

export const VERSION = "0.1.0";

export const DB_NAME = "mapatlas";
export const DB_VERSION = 1;

interface MapAtlasDB extends DBSchema {
  tracks: {
    key: Id;
    value: Track;
  };
  events: {
    key: Id;
    value: MapEvent;
    indexes: { byTrack: string };
  };
  blobs: {
    key: string;
    value: Blob;
  };
}

/**
 * The `trackId` index value used for events that are not attached to any track.
 * IndexedDB cannot index `undefined`, so unattached events index this sentinel
 * and are excluded from `listEvents(trackId)` results by construction.
 */
const NO_TRACK = "\u0000mapatlas:no-track";

export interface IdbStorageAdapterOptions {
  /** database name (default {@link DB_NAME}); useful to isolate tests */
  dbName?: string;
  /**
   * Optional IndexedDB factory. Defaults to the global `indexedDB`. Tests pass
   * a `fake-indexeddb` factory here so nothing touches a real browser database.
   */
  indexedDB?: IDBFactory;
}

/** Persist events with a non-undefined index key for the `byTrack` index. */
type StoredEvent = MapEvent & { _trackKey: string };

export class IdbStorageAdapter implements StorageAdapter {
  private dbp: Promise<IDBPDatabase<MapAtlasDB>>;

  constructor(opts: IdbStorageAdapterOptions = {}) {
    const dbName = opts.dbName ?? DB_NAME;
    const factory = opts.indexedDB ?? globalThis.indexedDB;
    if (!factory) {
      throw new Error(
        "IndexedDB is unavailable; pass an `indexedDB` factory (e.g. fake-indexeddb) in non-browser environments.",
      );
    }
    this.dbp = openWith(factory, dbName, DB_VERSION);
  }

  private db(): Promise<IDBPDatabase<MapAtlasDB>> {
    return this.dbp;
  }

  async saveTrack(t: Track): Promise<void> {
    const db = await this.db();
    await db.put("tracks", structuredClone(t));
  }

  async getTrack(id: Id): Promise<Track | undefined> {
    const db = await this.db();
    return db.get("tracks", id);
  }

  async listTracks(): Promise<Track[]> {
    const db = await this.db();
    return db.getAll("tracks");
  }

  async deleteTrack(id: Id): Promise<void> {
    const db = await this.db();
    await db.delete("tracks", id);
  }

  async saveEvent(e: MapEvent): Promise<void> {
    const db = await this.db();
    const stored: StoredEvent = {
      ...structuredClone(e),
      _trackKey: e.trackId ?? NO_TRACK,
    };
    await db.put("events", stored);
  }

  async getEvent(id: Id): Promise<MapEvent | undefined> {
    const db = await this.db();
    const stored = (await db.get("events", id)) as StoredEvent | undefined;
    return stored ? strip(stored) : undefined;
  }

  async listEvents(trackId?: Id): Promise<MapEvent[]> {
    const db = await this.db();
    if (trackId === undefined) {
      const all = (await db.getAll("events")) as StoredEvent[];
      return all.map(strip);
    }
    const matched = (await db.getAllFromIndex(
      "events",
      "byTrack",
      trackId,
    )) as StoredEvent[];
    return matched.map(strip);
  }

  async deleteEvent(id: Id): Promise<void> {
    const db = await this.db();
    await db.delete("events", id);
  }

  async putBlob(blob: Blob): Promise<string> {
    const db = await this.db();
    const key = newId();
    await db.put("blobs", blob, key);
    return key;
  }

  async getBlob(key: string): Promise<Blob | undefined> {
    const db = await this.db();
    return db.get("blobs", key);
  }

  async deleteBlob(key: string): Promise<void> {
    const db = await this.db();
    await db.delete("blobs", key);
  }

  async clearAll(): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(["tracks", "events", "blobs"], "readwrite");
    await Promise.all([
      tx.objectStore("tracks").clear(),
      tx.objectStore("events").clear(),
      tx.objectStore("blobs").clear(),
      tx.done,
    ]);
  }

  /** Close the underlying database (chiefly for test isolation). */
  async close(): Promise<void> {
    const db = await this.db();
    db.close();
  }
}

/**
 * Open (and if needed upgrade) the database using an explicit {@link IDBFactory},
 * wrapping the raw request with idb's promise adapter. `idb`'s own `openDB`
 * reads the global `indexedDB`, so we open manually to support injected factories.
 */
function openWith(
  factory: IDBFactory,
  name: string,
  version: number,
): Promise<IDBPDatabase<MapAtlasDB>> {
  const request = factory.open(name, version);
  request.addEventListener("upgradeneeded", () => {
    const db = request.result;
    if (!db.objectStoreNames.contains("tracks")) {
      db.createObjectStore("tracks", { keyPath: "id" });
    }
    if (!db.objectStoreNames.contains("events")) {
      const events = db.createObjectStore("events", { keyPath: "id" });
      events.createIndex("byTrack", "_trackKey");
    }
    if (!db.objectStoreNames.contains("blobs")) {
      db.createObjectStore("blobs");
    }
  });
  return wrap(request) as unknown as Promise<IDBPDatabase<MapAtlasDB>>;
}

/** Drop the internal index helper before returning an event to callers. */
function strip(stored: StoredEvent): MapEvent {
  const clone = structuredClone(stored) as Partial<StoredEvent>;
  delete clone._trackKey;
  return clone as MapEvent;
}

/** Convenience factory returning the adapter typed as the core interface. */
export function createIdbStorageAdapter(
  opts?: IdbStorageAdapterOptions,
): StorageAdapter {
  return new IdbStorageAdapter(opts);
}
