// SPDX-License-Identifier: Apache-2.0

import type { Id } from "./ids.js";
import type { MapEvent } from "./event.js";
import type { Track, TrackSummary } from "./track.js";

/**
 * Persistence for a consumer's own data: tracks, events, and media blobs.
 *
 * The default implementation is IndexedDB (`@mapatlas/storage-idb`); a consumer may supply
 * a remote or syncing one instead. The engine treats storage as async CRUD and assumes no
 * locality beyond that.
 */
export interface StorageAdapter {
  saveTrack(t: Track): Promise<void>;
  getTrack(id: Id): Promise<Track | undefined>;
  /**
   * The list projection. Must not hydrate point arrays — a consumer showing hundreds of
   * trips pays only for what it displays.
   *
   * **Ordered by `startedAt` ascending, ties broken by id.** Required, not optional: an
   * unspecified order pushes the sort into every consumer, and the obvious wrong answer —
   * ordering by id — looks right until an imported trip appears, since ids sort by mint
   * time and an imported 2019 trip is minted today. Making the order part of the contract
   * is what lets an adapter be tested for it. (ADR-0014)
   */
  listTrackSummaries(): Promise<TrackSummary[]>;
  /** Also removes that track's events, and any blob referenced only by them. */
  deleteTrack(id: Id): Promise<void>;

  saveEvent(e: MapEvent): Promise<void>;
  getEvent(id: Id): Promise<MapEvent | undefined>;
  listEvents(trackId?: Id): Promise<MapEvent[]>;
  deleteEvent(id: Id): Promise<void>;

  putBlob(blob: Blob): Promise<string>;
  getBlob(key: string): Promise<Blob | undefined>;
  deleteBlob(key: string): Promise<void>;

  /** Wipe everything a consumer owns. Must not touch map assets — those are a separate store. */
  clearAll(): Promise<void>;
}

/**
 * Persistence for downloaded **map assets**, deliberately not the {@link StorageAdapter}.
 *
 * Map bytes are large, replaceable, and the right thing to evict first; tracks and photos
 * are irreplaceable. Sharing one store meant a sign-out wipe destroyed hundreds of megabytes
 * of basemap. Separation buys lifecycle isolation and a bounded blast radius — **not** quota
 * isolation, since browsers evict per origin. (ADR-0016)
 */
export interface MapAssetStore {
  put(key: string, data: Blob): Promise<void>;
  get(key: string): Promise<Blob | undefined>;
  delete(key: string): Promise<void>;
  list(): Promise<string[]>;
  estimateBytes(): Promise<number>;
  /** Wipes map assets only. `StorageAdapter.clearAll()` must not touch them, and vice versa. */
  clear(): Promise<void>;
}
