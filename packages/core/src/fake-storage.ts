// SPDX-License-Identifier: Apache-2.0

import type { Id, MapEvent, Track } from "./types.js";
import type { StorageAdapter } from "./interfaces.js";
import { newId } from "./id.js";

/**
 * In-memory `StorageAdapter` for tests and demos. Not persistent — every
 * instance starts empty. Kept in the published surface so downstream adapters
 * (and the future conformance suite, T2.1) have a reference implementation.
 */
export class InMemoryStorageAdapter implements StorageAdapter {
  private readonly tracks = new Map<Id, Track>();
  private readonly events = new Map<Id, MapEvent>();
  private readonly blobs = new Map<string, Blob>();

  saveTrack(t: Track): Promise<void> {
    this.tracks.set(t.id, structuredClone(t));
    return Promise.resolve();
  }

  getTrack(id: Id): Promise<Track | undefined> {
    const t = this.tracks.get(id);
    return Promise.resolve(t ? structuredClone(t) : undefined);
  }

  listTracks(): Promise<Track[]> {
    return Promise.resolve(
      [...this.tracks.values()].map((t) => structuredClone(t)),
    );
  }

  deleteTrack(id: Id): Promise<void> {
    this.tracks.delete(id);
    return Promise.resolve();
  }

  saveEvent(e: MapEvent): Promise<void> {
    this.events.set(e.id, structuredClone(e));
    return Promise.resolve();
  }

  getEvent(id: Id): Promise<MapEvent | undefined> {
    const e = this.events.get(id);
    return Promise.resolve(e ? structuredClone(e) : undefined);
  }

  listEvents(trackId?: Id): Promise<MapEvent[]> {
    const all = [...this.events.values()].map((e) => structuredClone(e));
    return Promise.resolve(
      trackId === undefined ? all : all.filter((e) => e.trackId === trackId),
    );
  }

  deleteEvent(id: Id): Promise<void> {
    this.events.delete(id);
    return Promise.resolve();
  }

  putBlob(blob: Blob): Promise<string> {
    const key = newId();
    this.blobs.set(key, blob);
    return Promise.resolve(key);
  }

  getBlob(key: string): Promise<Blob | undefined> {
    return Promise.resolve(this.blobs.get(key));
  }

  deleteBlob(key: string): Promise<void> {
    this.blobs.delete(key);
    return Promise.resolve();
  }

  clearAll(): Promise<void> {
    this.tracks.clear();
    this.events.clear();
    this.blobs.clear();
    return Promise.resolve();
  }
}
