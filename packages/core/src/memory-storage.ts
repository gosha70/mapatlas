// SPDX-License-Identifier: Apache-2.0
import type { Id, MapEvent, Track } from "./types";
import type { StorageAdapter } from "./seams";
import { newId } from "./id";

/**
 * In-memory {@link StorageAdapter}. Holds tracks, events, and blobs in `Map`s
 * with no persistence — everything is lost when the process (or tab) ends.
 *
 * It is dependency-free and DOM-free, which makes it useful in three places:
 * as the reference implementation the conformance suite (T2.1) is proven
 * against, as a fake in unit tests, and as a throwaway store for SSR / preview
 * environments where IndexedDB is unavailable. It clones values on the way in
 * and out so callers cannot mutate stored records by reference.
 */
export function createMemoryStorageAdapter(): StorageAdapter {
  const tracks = new Map<Id, Track>();
  const events = new Map<Id, MapEvent>();
  const blobs = new Map<string, Blob>();

  const cloneTrack = (t: Track): Track => structuredClone(t);
  const cloneEvent = (e: MapEvent): MapEvent => structuredClone(e);

  return {
    saveTrack(t: Track): Promise<void> {
      tracks.set(t.id, cloneTrack(t));
      return Promise.resolve();
    },
    getTrack(id: Id): Promise<Track | undefined> {
      const t = tracks.get(id);
      return Promise.resolve(t ? cloneTrack(t) : undefined);
    },
    listTracks(): Promise<Track[]> {
      return Promise.resolve([...tracks.values()].map(cloneTrack));
    },
    deleteTrack(id: Id): Promise<void> {
      tracks.delete(id);
      return Promise.resolve();
    },

    saveEvent(e: MapEvent): Promise<void> {
      events.set(e.id, cloneEvent(e));
      return Promise.resolve();
    },
    getEvent(id: Id): Promise<MapEvent | undefined> {
      const e = events.get(id);
      return Promise.resolve(e ? cloneEvent(e) : undefined);
    },
    listEvents(trackId?: Id): Promise<MapEvent[]> {
      const all = [...events.values()].map(cloneEvent);
      return Promise.resolve(
        trackId === undefined ? all : all.filter((e) => e.trackId === trackId),
      );
    },
    deleteEvent(id: Id): Promise<void> {
      events.delete(id);
      return Promise.resolve();
    },

    putBlob(blob: Blob): Promise<string> {
      const key = newId();
      blobs.set(key, blob);
      return Promise.resolve(key);
    },
    getBlob(key: string): Promise<Blob | undefined> {
      return Promise.resolve(blobs.get(key));
    },
    deleteBlob(key: string): Promise<void> {
      blobs.delete(key);
      return Promise.resolve();
    },

    clearAll(): Promise<void> {
      tracks.clear();
      events.clear();
      blobs.clear();
      return Promise.resolve();
    },
  };
}
