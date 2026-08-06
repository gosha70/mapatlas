// SPDX-License-Identifier: Apache-2.0

/**
 * Reusable `StorageAdapter` conformance suite (tasks T2.1).
 *
 * Any adapter — the in-memory fake, the IndexedDB default, or a
 * consumer-supplied remote adapter — can be validated against the persistence
 * contract in `api.md §3` by calling {@link runStorageAdapterConformance} from
 * a test file. The suite is framework-agnostic beyond depending on Vitest's
 * globals, which every package in the monorepo already uses for tests.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { MapEvent, Track } from "../types.js";
import type { StorageAdapter } from "../interfaces.js";

/** Factory for a fresh, empty adapter per test. May be async. */
export type MakeAdapter = () => StorageAdapter | Promise<StorageAdapter>;

function makeTrack(over: Partial<Track> = {}): Track {
  return {
    id: "trk-1",
    startedAt: 1000,
    status: "finalized",
    points: [
      { lat: 10, lng: 20, t: 1000 },
      { lat: 10.001, lng: 20.001, t: 2000 },
    ],
    ...over,
  };
}

function makeEvent(over: Partial<MapEvent> = {}): MapEvent {
  return {
    id: "evt-1",
    position: { lat: 10, lng: 20 },
    occurredAt: 1500,
    media: [],
    tags: [],
    ...over,
  };
}

/**
 * Register the conformance suite for one adapter implementation.
 *
 * @param name  human label for the `describe` block (e.g. the adapter name)
 * @param makeAdapter  returns a fresh, empty adapter for each test
 */
export function runStorageAdapterConformance(
  name: string,
  makeAdapter: MakeAdapter,
): void {
  describe(`StorageAdapter conformance: ${name}`, () => {
    let store: StorageAdapter;

    beforeEach(async () => {
      store = await makeAdapter();
      // A freshly-made adapter must start empty.
      expect(await store.listTracks()).toEqual([]);
      expect(await store.listEvents()).toEqual([]);
    });

    describe("tracks", () => {
      it("saves and reads a track back by id", async () => {
        const t = makeTrack();
        await store.saveTrack(t);
        expect(await store.getTrack(t.id)).toEqual(t);
      });

      it("returns undefined for a missing track", async () => {
        expect(await store.getTrack("nope")).toBeUndefined();
      });

      it("lists all saved tracks", async () => {
        await store.saveTrack(makeTrack({ id: "a" }));
        await store.saveTrack(makeTrack({ id: "b" }));
        const ids = (await store.listTracks()).map((t) => t.id).sort();
        expect(ids).toEqual(["a", "b"]);
      });

      it("overwrites a track on repeated save", async () => {
        await store.saveTrack(makeTrack({ id: "a", distanceM: 1 }));
        await store.saveTrack(makeTrack({ id: "a", distanceM: 2 }));
        expect((await store.getTrack("a"))?.distanceM).toBe(2);
        expect(await store.listTracks()).toHaveLength(1);
      });

      it("deletes a track", async () => {
        const t = makeTrack();
        await store.saveTrack(t);
        await store.deleteTrack(t.id);
        expect(await store.getTrack(t.id)).toBeUndefined();
        expect(await store.listTracks()).toEqual([]);
      });

      it("does not alias the stored object (defensive copy)", async () => {
        const t = makeTrack();
        await store.saveTrack(t);
        t.points.push({ lat: 0, lng: 0, t: 3000 });
        expect((await store.getTrack(t.id))?.points).toHaveLength(2);
      });
    });

    describe("events", () => {
      it("saves and reads an event back by id", async () => {
        const e = makeEvent({ comment: "hi" });
        await store.saveEvent(e);
        expect(await store.getEvent(e.id)).toEqual(e);
      });

      it("returns undefined for a missing event", async () => {
        expect(await store.getEvent("nope")).toBeUndefined();
      });

      it("lists events, optionally filtered by track", async () => {
        await store.saveEvent(makeEvent({ id: "e1", trackId: "t1" }));
        await store.saveEvent(makeEvent({ id: "e2", trackId: "t1" }));
        await store.saveEvent(makeEvent({ id: "e3", trackId: "t2" }));
        expect(await store.listEvents()).toHaveLength(3);
        expect(await store.listEvents("t1")).toHaveLength(2);
        expect(await store.listEvents("t2")).toHaveLength(1);
        expect(await store.listEvents("none")).toHaveLength(0);
      });

      it("deletes an event", async () => {
        const e = makeEvent();
        await store.saveEvent(e);
        await store.deleteEvent(e.id);
        expect(await store.getEvent(e.id)).toBeUndefined();
      });
    });

    describe("blobs", () => {
      it("puts a blob and reads identical bytes back", async () => {
        const blob = new Blob(["hello world"], { type: "text/plain" });
        const key = await store.putBlob(blob);
        expect(typeof key).toBe("string");
        const got = await store.getBlob(key);
        expect(got).toBeDefined();
        expect(await got!.text()).toBe("hello world");
      });

      it("assigns distinct keys to successive blobs", async () => {
        const a = await store.putBlob(new Blob(["a"]));
        const b = await store.putBlob(new Blob(["b"]));
        expect(a).not.toBe(b);
      });

      it("returns undefined for a missing blob", async () => {
        expect(await store.getBlob("nope")).toBeUndefined();
      });

      it("deletes a blob", async () => {
        const key = await store.putBlob(new Blob(["x"]));
        await store.deleteBlob(key);
        expect(await store.getBlob(key)).toBeUndefined();
      });
    });

    describe("clearAll", () => {
      it("removes every track, event, and blob", async () => {
        await store.saveTrack(makeTrack());
        await store.saveEvent(makeEvent());
        const key = await store.putBlob(new Blob(["x"]));

        await store.clearAll();

        expect(await store.listTracks()).toEqual([]);
        expect(await store.listEvents()).toEqual([]);
        expect(await store.getBlob(key)).toBeUndefined();
      });
    });
  });
}
