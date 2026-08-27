// SPDX-License-Identifier: Apache-2.0

import type { Id, MapEvent, StorageAdapter, Track, TrackSummary } from "@mapatlas/core";
import { newId, summariseTrack } from "@mapatlas/core";

import type { MapAtlasDatabase, MapAtlasEventStore, MapAtlasTransaction } from "./schema.js";
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

/**
 * Bring every affected summary's `eventCount` back in step, inside the caller's transaction.
 *
 * Takes a list of possibly-undefined track ids because the interesting cases are exactly
 * the ones with two: an event moved from A to B, or one whose `trackId` was removed
 * altogether. Recomputing only the new owner is what leaves A still counting an event it
 * no longer holds.
 */
async function recountOwners(
  tx: MapAtlasTransaction,
  events: MapAtlasEventStore,
  trackIds: readonly (Id | undefined)[],
): Promise<void> {
  const affected = new Set(trackIds.filter((id): id is Id => id !== undefined));
  if (affected.size === 0) return;

  const summaries = tx.objectStore(STORE.summaries);
  for (const trackId of affected) {
    const summary = await summaries.get(trackId);
    // A track that does not exist has no summary to correct — an event may legitimately
    // reference one that was never stored, or was deleted.
    if (summary === undefined) continue;
    const count = (await events.index(INDEX.eventsByTrackId).getAll(trackId)).length;
    await summaries.put({ ...summary, eventCount: count });
  }
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

      // One transaction over all three stores. A track and its summary must never be
      // observable in disagreement, and a summary written separately could be lost to a
      // crash between the two writes — leaving a trip that exists but appears in no list,
      // or a list entry pointing at nothing.
      //
      // `events` is in scope because `eventCount` is read from it. Counting beforehand, in
      // a transaction of its own, is not the same thing: a concurrent `saveEvent` can
      // commit between the count and the write, and the summary then reports a number that
      // was already wrong when it was written.
      const tx = database.transaction([STORE.tracks, STORE.summaries, STORE.events], "readwrite");
      const eventCount = (
        await tx.objectStore(STORE.events).index(INDEX.eventsByTrackId).getAll(track.id)
      ).length;

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

      const tx = database.transaction(
        [STORE.tracks, STORE.summaries, STORE.events, STORE.blobs],
        "readwrite",
      );
      const events = tx.objectStore(STORE.events);

      // Selected inside the transaction. A snapshot taken beforehand can miss an event that
      // commits between the read and the delete, leaving it attached to a track that no
      // longer exists — which is not what either ordering of the two operations would have
      // produced, so it is not a race a caller could have reasoned about.
      const doomed = await events.index(INDEX.eventsByTrackId).getAll(id);
      const candidates = new Set(doomed.flatMap(blobKeysOf));

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

      // `put` may be replacing an event that belonged to a different track, or to none.
      // Reading the previous owner first is what makes a *move* work: recomputing only the
      // new track leaves the old one still counting an event it no longer holds.
      const previous = await events.get(event.id);
      await events.put(event);

      await recountOwners(tx, events, [previous?.trackId, event.trackId]);
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

      await recountOwners(tx, events, [event?.trackId]);
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
