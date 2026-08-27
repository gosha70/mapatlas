// SPDX-License-Identifier: Apache-2.0

import type { MapEvent } from "../event.js";
import type { Id } from "../ids.js";
import { newId } from "../ids.js";
import type { MapAssetStore, StorageAdapter } from "../storage.js";
import type { BBox, LatLng } from "../geo.js";
import type { Track, TrackSummary } from "../track.js";

/**
 * A complete, in-memory {@link StorageAdapter} — shipped, not test-only.
 *
 * `StorageAdapter` is a seam: the engine tells consumers to implement it and plug in their
 * own persistence. Shipping the same reference implementation the engine validates itself
 * against means a consumer can unit-test without IndexedDB, an adapter author gets a
 * canonical executable example, and nobody has to invent a subtly different storage mock.
 *
 * "Memory", not "fake": this is a legitimate implementation of the interface whose
 * persistence happens to be process-local. It models the **contract's semantics**, not
 * IndexedDB's architecture.
 *
 * It obeys the same purity boundary as the rest of `core` — no React, no MapLibre, no
 * IndexedDB, no DOM runtime, no Node-only dependency. A `Map`, some arrays and cloned
 * values are enough.
 */

/**
 * Deep-copy on the way in and on the way out, so the store has the value semantics of real
 * persistence.
 *
 * Without this, `const t = await store.getTrack(id); t.points.push(p)` would silently
 * mutate what the store holds, and a test would pass against memory while failing against
 * IndexedDB — which serialises, and therefore hands back a copy. That divergence is exactly
 * what a shipped reference implementation must not have.
 */
function copy<T>(value: T): T {
  return structuredClone(value);
}

function boundsOf(track: Track): { bbox?: BBox; start?: LatLng; finish?: LatLng } {
  const first = track.points[0];
  const last = track.points[track.points.length - 1];
  if (first === undefined || last === undefined) return {};

  let west = first.lng;
  let east = first.lng;
  let south = first.lat;
  let north = first.lat;

  for (const point of track.points) {
    west = Math.min(west, point.lng);
    east = Math.max(east, point.lng);
    south = Math.min(south, point.lat);
    north = Math.max(north, point.lat);
  }

  return {
    bbox: [west, south, east, north],
    start: { lat: first.lat, lng: first.lng },
    finish: { lat: last.lat, lng: last.lng },
  };
}

/**
 * Derive the list projection from a stored track.
 *
 * Computed on demand here, which is semantically correct and enough for an in-memory store.
 * The point of the projection is the externally observable shape — a summary with no point
 * array — not the storage-layer optimisation; `@mapatlas/storage-idb` is where avoiding a
 * read of the point blob actually matters, and where that is proven.
 */
function summarise(track: Track, eventCount: number): TrackSummary {
  const channelKeys = track.channels?.map((c) => c.key);

  return {
    id: track.id,
    startedAt: track.startedAt,
    ...(track.endedAt === undefined ? {} : { endedAt: track.endedAt }),
    status: track.status,
    origin: track.origin,
    ...(track.stats === undefined ? {} : { stats: copy(track.stats) }),
    pointCount: track.points.length,
    eventCount,
    ...boundsOf(track),
    ...(channelKeys === undefined || channelKeys.length === 0 ? {} : { channelKeys }),
    ...(track.tags === undefined ? {} : { tags: [...track.tags] }),
    ...(track.meta === undefined ? {} : { meta: copy(track.meta) }),
  };
}

export interface MemoryStorageAdapter extends StorageAdapter {
  /** Blobs currently held, for a test that wants to assert cascade behaviour directly. */
  blobKeys(): string[];
}

export function createMemoryStorageAdapter(): MemoryStorageAdapter {
  const tracks = new Map<Id, Track>();
  const events = new Map<Id, MapEvent>();
  const blobs = new Map<string, Blob>();

  const blobKeysOf = (event: MapEvent): string[] =>
    event.media.map((m) => m.blobKey).filter((k): k is string => k !== undefined);

  return {
    saveTrack: (track) => {
      tracks.set(track.id, copy(track));
      return Promise.resolve();
    },

    getTrack: (id) => {
      const track = tracks.get(id);
      return Promise.resolve(track === undefined ? undefined : copy(track));
    },

    listTrackSummaries: () => {
      const counts = new Map<Id, number>();
      for (const event of events.values()) {
        if (event.trackId !== undefined) {
          counts.set(event.trackId, (counts.get(event.trackId) ?? 0) + 1);
        }
      }
      return Promise.resolve(
        [...tracks.values()].map((track) => summarise(track, counts.get(track.id) ?? 0)),
      );
    },

    deleteTrack: (id) => {
      tracks.delete(id);

      // Cascade: the track's events go with it, and so does any blob only they referenced.
      const orphaned = new Set<string>();
      for (const [eventId, event] of [...events]) {
        if (event.trackId !== id) continue;
        for (const key of blobKeysOf(event)) orphaned.add(key);
        events.delete(eventId);
      }

      // A blob still referenced by a surviving event is not orphaned.
      for (const event of events.values()) {
        for (const key of blobKeysOf(event)) orphaned.delete(key);
      }
      for (const key of orphaned) blobs.delete(key);

      return Promise.resolve();
    },

    saveEvent: (event) => {
      events.set(event.id, copy(event));
      return Promise.resolve();
    },

    getEvent: (id) => {
      const event = events.get(id);
      return Promise.resolve(event === undefined ? undefined : copy(event));
    },

    listEvents: (trackId) =>
      Promise.resolve(
        [...events.values()]
          .filter((event) => trackId === undefined || event.trackId === trackId)
          .map(copy),
      ),

    deleteEvent: (id) => {
      events.delete(id);
      return Promise.resolve();
    },

    // Blobs are immutable, so a reference is already value semantics — cloning one would
    // cost a copy of the bytes for nothing.
    putBlob: (blob) => {
      const key = newId();
      blobs.set(key, blob);
      return Promise.resolve(key);
    },

    getBlob: (key) => Promise.resolve(blobs.get(key)),

    deleteBlob: (key) => {
      blobs.delete(key);
      return Promise.resolve();
    },

    clearAll: () => {
      tracks.clear();
      events.clear();
      blobs.clear();
      return Promise.resolve();
    },

    blobKeys: () => [...blobs.keys()],
  };
}

/**
 * An in-memory {@link MapAssetStore}, separate from the adapter above exactly as the real
 * ones are: clearing map assets must not touch tracks, and clearing tracks must not destroy
 * a downloaded basemap. (ADR-0016)
 */
export function createMemoryMapAssetStore(): MapAssetStore {
  const assets = new Map<string, Blob>();

  return {
    put: (key, data) => {
      assets.set(key, data);
      return Promise.resolve();
    },
    get: (key) => Promise.resolve(assets.get(key)),
    delete: (key) => {
      assets.delete(key);
      return Promise.resolve();
    },
    list: () => Promise.resolve([...assets.keys()]),
    estimateBytes: () =>
      Promise.resolve([...assets.values()].reduce((total, blob) => total + blob.size, 0)),
    clear: () => {
      assets.clear();
      return Promise.resolve();
    },
  };
}
