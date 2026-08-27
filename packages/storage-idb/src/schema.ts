// SPDX-License-Identifier: Apache-2.0

import type { MapEvent, Track, TrackSummary } from "@mapatlas/core";
import type { DBSchema, IDBPDatabase, IDBPObjectStore, IDBPTransaction } from "idb";
import { openDB } from "idb";

/**
 * The engine's own data. Map assets live in a **separate** store with its own name, so
 * clearing or deleting one cannot touch the other.
 *
 * What that buys is lifecycle isolation and a bounded blast radius, **not** quota
 * isolation: browsers evict per origin, so a device under storage pressure can still take
 * both. Separating them is what lets a consumer evict the replaceable half deliberately,
 * and what stops a sign-out wipe costing a re-download. (ADR-0016)
 */
export const DEFAULT_DATABASE_NAME = "mapatlas";
export const SCHEMA_VERSION = 1;

export const STORE = {
  tracks: "tracks",
  summaries: "summaries",
  events: "events",
  blobs: "blobs",
} as const;

export const INDEX = {
  /** Chronological listing without reading a track. */
  summariesByStartedAt: "by-startedAt",
  /** Cascade delete and per-track listing without scanning every event. */
  eventsByTrackId: "by-trackId",
} as const;

export interface MapAtlasSchema extends DBSchema {
  [STORE.tracks]: { key: string; value: Track };
  /**
   * The list projection, stored **beside** the track rather than derived on read.
   *
   * This is the whole reason the schema has two stores. IndexedDB has no projection: a read
   * deserializes the entire record, so listing from `tracks` would pull every point of
   * every trip to display a list that shows none of them. A summary record is a few hundred
   * bytes and carries its own `startedAt` index, so listing is one ordered traversal of
   * small records.
   *
   * The cost is that the two can disagree, which is why every write that touches one
   * touches the other in the same transaction.
   */
  [STORE.summaries]: {
    key: string;
    value: TrackSummary;
    indexes: { [INDEX.summariesByStartedAt]: number };
  };
  [STORE.events]: {
    key: string;
    value: MapEvent;
    indexes: { [INDEX.eventsByTrackId]: string };
  };
  [STORE.blobs]: { key: string; value: Blob };
}

export type MapAtlasDatabase = IDBPDatabase<MapAtlasSchema>;

export type StoreName = (typeof STORE)[keyof typeof STORE];

/** A read-write transaction spanning any of the stores. */
export type MapAtlasTransaction = IDBPTransaction<MapAtlasSchema, StoreName[], "readwrite">;

export type MapAtlasEventStore = IDBPObjectStore<
  MapAtlasSchema,
  StoreName[],
  typeof STORE.events,
  "readwrite"
>;

export function openMapAtlasDatabase(name = DEFAULT_DATABASE_NAME): Promise<MapAtlasDatabase> {
  return openDB<MapAtlasSchema>(name, SCHEMA_VERSION, {
    upgrade(db) {
      db.createObjectStore(STORE.tracks, { keyPath: "id" });

      const summaries = db.createObjectStore(STORE.summaries, { keyPath: "id" });
      // Equal keys are ordered by primary key, which is the track id — so this index alone
      // delivers the contract's order: startedAt ascending, ties broken by id.
      summaries.createIndex(INDEX.summariesByStartedAt, "startedAt");

      const events = db.createObjectStore(STORE.events, { keyPath: "id" });
      events.createIndex(INDEX.eventsByTrackId, "trackId");

      // Out-of-line keys: a Blob has no id of its own, and putBlob mints one.
      db.createObjectStore(STORE.blobs);
    },
  });
}
