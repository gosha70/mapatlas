// SPDX-License-Identifier: Apache-2.0

import type { Id, MapEvent, StorageAdapter, Track, TrackSummary } from "@mapatlas/core";
import { newId, summariseTrack } from "@mapatlas/core";

import type { MapAtlasDatabase } from "./schema.js";
import { INDEX, STORE, openMapAtlasDatabase } from "./schema.js";

export interface IdbStorageAdapterOptions {
  /** Override for tests or for a consumer isolating several profiles on one origin. */
  databaseName?: string;
  /** An already-open connection, when a consumer wants to manage the lifecycle itself. */
  database?: MapAtlasDatabase;
}

export interface IdbStorageAdapter extends StorageAdapter {
  /** Close the underlying connection. */
  close(): Promise<void>;
}

function blobKeysOf(event: MapEvent): string[] {
  return event.media
    .map((media) => media.blobKey)
    .filter((key): key is string => key !== undefined);
}

export function createIdbStorageAdapter(options: IdbStorageAdapterOptions = {}): IdbStorageAdapter {
  // Opened lazily and shared: a consumer constructs the adapter during module init, where
  // awaiting is awkward, and every method needs the same connection anyway.
  let connection: Promise<MapAtlasDatabase> | undefined;
  const db = (): Promise<MapAtlasDatabase> => {
    connection ??=
      options.database === undefined
        ? openMapAtlasDatabase(options.databaseName)
        : Promise.resolve(options.database);
    return connection;
  };

  /** Events attached to a track, read through the index rather than by scanning. */
  const eventsOfTrack = async (database: MapAtlasDatabase, trackId: Id): Promise<MapEvent[]> =>
    database.getAllFromIndex(STORE.events, INDEX.eventsByTrackId, trackId);

  return {
    saveTrack: async (track) => {
      const database = await db();
      const eventCount = (await eventsOfTrack(database, track.id)).length;

      // One transaction over both stores. A track and its summary must never be observable
      // in disagreement, and a summary written separately could be lost to a crash between
      // the two writes — leaving a trip that exists but does not appear in any list, or a
      // list entry pointing at nothing.
      const tx = database.transaction([STORE.tracks, STORE.summaries], "readwrite");
      await Promise.all([
        tx.objectStore(STORE.tracks).put(track),
        // `put` replaces the whole record, so an overwrite that changes `startedAt`
        // reindexes automatically: the old index entry goes with the old record.
        tx.objectStore(STORE.summaries).put(summariseTrack(track, eventCount)),
        tx.done,
      ]);
    },

    getTrack: async (id) => (await db()).get(STORE.tracks, id),

    listTrackSummaries: async (): Promise<TrackSummary[]> => {
      const database = await db();
      // A single ordered traversal of the index. The `tracks` store is not touched, which
      // is the point: a trip list must not deserialize a point array per trip.
      return database.getAllFromIndex(STORE.summaries, INDEX.summariesByStartedAt);
    },

    deleteTrack: async (id) => {
      const database = await db();
      const doomed = await eventsOfTrack(database, id);
      const candidates = new Set(doomed.flatMap(blobKeysOf));

      const tx = database.transaction(
        [STORE.tracks, STORE.summaries, STORE.events, STORE.blobs],
        "readwrite",
      );
      const events = tx.objectStore(STORE.events);

      await Promise.all([
        tx.objectStore(STORE.tracks).delete(id),
        tx.objectStore(STORE.summaries).delete(id),
        ...doomed.map((event) => events.delete(event.id)),
      ]);

      // A blob is orphaned only if nothing that survives still points at it. Checked inside
      // the same transaction so a concurrent write cannot make the answer stale.
      if (candidates.size > 0) {
        for (const survivor of await events.getAll()) {
          for (const key of blobKeysOf(survivor)) candidates.delete(key);
        }
        const blobs = tx.objectStore(STORE.blobs);
        await Promise.all([...candidates].map((key) => blobs.delete(key)));
      }

      await tx.done;
    },

    saveEvent: async (event) => {
      const database = await db();
      const tx = database.transaction([STORE.events, STORE.summaries], "readwrite");
      const events = tx.objectStore(STORE.events);

      await events.put(event);

      // `eventCount` lives in the summary, so adding an event to a track changes it. Same
      // transaction, same reason as saveTrack.
      if (event.trackId !== undefined) {
        const summaries = tx.objectStore(STORE.summaries);
        const summary = await summaries.get(event.trackId);
        if (summary !== undefined) {
          const count = (await events.index(INDEX.eventsByTrackId).getAll(event.trackId)).length;
          await summaries.put({ ...summary, eventCount: count });
        }
      }

      await tx.done;
    },

    getEvent: async (id) => (await db()).get(STORE.events, id),

    listEvents: async (trackId) => {
      const database = await db();
      return trackId === undefined
        ? database.getAll(STORE.events)
        : eventsOfTrack(database, trackId);
    },

    deleteEvent: async (id) => {
      const database = await db();
      const tx = database.transaction([STORE.events, STORE.summaries], "readwrite");
      const events = tx.objectStore(STORE.events);

      const event = await events.get(id);
      await events.delete(id);

      if (event?.trackId !== undefined) {
        const summaries = tx.objectStore(STORE.summaries);
        const summary = await summaries.get(event.trackId);
        if (summary !== undefined) {
          const count = (await events.index(INDEX.eventsByTrackId).getAll(event.trackId)).length;
          await summaries.put({ ...summary, eventCount: count });
        }
      }

      await tx.done;
    },

    putBlob: async (blob) => {
      const key = newId();
      await (await db()).put(STORE.blobs, blob, key);
      return key;
    },

    getBlob: async (key) => (await db()).get(STORE.blobs, key),

    deleteBlob: async (key) => {
      await (await db()).delete(STORE.blobs, key);
    },

    clearAll: async () => {
      const database = await db();
      const tx = database.transaction(
        [STORE.tracks, STORE.summaries, STORE.events, STORE.blobs],
        "readwrite",
      );
      await Promise.all([
        tx.objectStore(STORE.tracks).clear(),
        tx.objectStore(STORE.summaries).clear(),
        tx.objectStore(STORE.events).clear(),
        tx.objectStore(STORE.blobs).clear(),
        tx.done,
      ]);
      // Map assets are a different store entirely and are deliberately untouched.
    },

    close: async () => {
      if (connection === undefined) return;
      (await connection).close();
      connection = undefined;
    },
  };
}

/** Re-exported so a caller can name a track type without importing core separately. */
export type { Track };
