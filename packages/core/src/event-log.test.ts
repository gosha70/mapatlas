// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from "vitest";
import { EventLog } from "./event-log";
import type { StorageAdapter } from "./seams";
import type { Id, MapEvent, Track } from "./types";

/** Minimal in-memory StorageAdapter for exercising engine logic with fakes. */
class InMemoryStorage implements StorageAdapter {
  readonly tracks = new Map<Id, Track>();
  readonly events = new Map<Id, MapEvent>();
  readonly blobs = new Map<string, Blob>();
  #blobSeq = 0;

  saveTrack(t: Track): Promise<void> {
    this.tracks.set(t.id, t);
    return Promise.resolve();
  }
  getTrack(id: Id): Promise<Track | undefined> {
    return Promise.resolve(this.tracks.get(id));
  }
  listTracks(): Promise<Track[]> {
    return Promise.resolve([...this.tracks.values()]);
  }
  deleteTrack(id: Id): Promise<void> {
    this.tracks.delete(id);
    return Promise.resolve();
  }

  saveEvent(e: MapEvent): Promise<void> {
    this.events.set(e.id, e);
    return Promise.resolve();
  }
  getEvent(id: Id): Promise<MapEvent | undefined> {
    return Promise.resolve(this.events.get(id));
  }
  listEvents(trackId?: Id): Promise<MapEvent[]> {
    const all = [...this.events.values()];
    return Promise.resolve(
      trackId === undefined ? all : all.filter((e) => e.trackId === trackId),
    );
  }
  deleteEvent(id: Id): Promise<void> {
    this.events.delete(id);
    return Promise.resolve();
  }

  putBlob(blob: Blob): Promise<string> {
    const key = `blob:${this.#blobSeq++}`;
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

const baseEvent = (over: Partial<MapEvent> = {}): Omit<MapEvent, "id"> => ({
  position: { lat: 10, lng: 20 },
  occurredAt: 1000,
  media: [],
  tags: [],
  ...over,
});

describe("EventLog", () => {
  let store: InMemoryStorage;

  beforeEach(() => {
    store = new InMemoryStorage();
  });

  it("creates an event with a fresh id and persists it", async () => {
    const log = new EventLog(store);
    const created = await log.create(baseEvent({ comment: "here" }));

    expect(created.id).toBeTruthy();
    expect(await store.getEvent(created.id)).toEqual(created);
  });

  it("updates an existing event", async () => {
    const log = new EventLog(store);
    const created = await log.create(baseEvent());

    const updated: MapEvent = { ...created, comment: "edited" };
    await log.update(updated);

    expect((await store.getEvent(created.id))?.comment).toBe("edited");
  });

  it("deletes an event", async () => {
    const log = new EventLog(store);
    const created = await log.create(baseEvent());

    await log.delete(created.id);
    expect(await store.getEvent(created.id)).toBeUndefined();
  });

  it("lists all events when unscoped", async () => {
    const log = new EventLog(store);
    await log.create(baseEvent({ trackId: "T1" }));
    await log.create(baseEvent({ trackId: "T2" }));

    expect(await log.list()).toHaveLength(2);
  });

  it("scopes list to its track id", async () => {
    await new EventLog(store).create(baseEvent({ trackId: "T1" }));
    await new EventLog(store).create(baseEvent({ trackId: "T2" }));

    const scoped = new EventLog(store, "T1");
    const events = await scoped.list();
    expect(events).toHaveLength(1);
    expect(events[0]?.trackId).toBe("T1");
  });
});
