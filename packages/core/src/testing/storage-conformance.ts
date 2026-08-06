// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from "vitest";
import type { MapEvent, Track } from "../types";
import type { StorageAdapter } from "../seams";

/**
 * Reusable {@link StorageAdapter} conformance suite (T2.1). Any adapter — the
 * in-memory fake, the IndexedDB default, or a consumer's remote/sync store —
 * can be verified against the persistence contract in `specs/api.md §3` by
 * calling this with a factory that returns a fresh, empty adapter.
 *
 * The suite lives in `core` (framework-agnostic) but imports `vitest`, so it is
 * excluded from the compiled `dist`; it is consumed only from `*.test.ts` files.
 */
export type AdapterFactory = () => StorageAdapter | Promise<StorageAdapter>;

function sampleTrack(id: string): Track {
  return {
    id,
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_100_000,
    status: "finalized",
    points: [
      { lat: 47.6, lng: -122.33, t: 1_700_000_000_000, accuracyM: 5 },
      { lat: 47.601, lng: -122.331, t: 1_700_000_050_000, accuracyM: 6 },
    ],
    simplified: [
      { lat: 47.6, lng: -122.33, t: 1_700_000_000_000 },
      { lat: 47.601, lng: -122.331, t: 1_700_000_050_000 },
    ],
    distanceM: 140,
    tags: ["morning"],
    meta: { device: "test" },
  };
}

function sampleEvent(id: string, trackId?: string): MapEvent {
  const e: MapEvent = {
    id,
    position: { lat: 47.6005, lng: -122.3305 },
    occurredAt: 1_700_000_025_000,
    comment: "a pinned moment",
    media: [],
    tags: ["note"],
    fields: { note: 42 },
  };
  if (trackId !== undefined) e.trackId = trackId;
  return e;
}

/**
 * Register the conformance test cases against the adapter produced by `make`.
 * Call inside a test file: `runStorageAdapterConformance("memory", makeAdapter)`.
 */
export function runStorageAdapterConformance(
  name: string,
  make: AdapterFactory,
): void {
  describe(`StorageAdapter conformance: ${name}`, () => {
    let store: StorageAdapter;
    beforeEach(async () => {
      store = await make();
    });

    describe("tracks", () => {
      it("returns undefined for an unknown track", async () => {
        expect(await store.getTrack("missing")).toBeUndefined();
      });

      it("saves and reads back a track losslessly", async () => {
        const t = sampleTrack("t1");
        await store.saveTrack(t);
        expect(await store.getTrack("t1")).toEqual(t);
      });

      it("overwrites a track saved under the same id", async () => {
        await store.saveTrack(sampleTrack("t1"));
        const updated: Track = { ...sampleTrack("t1"), distanceM: 999 };
        await store.saveTrack(updated);
        expect((await store.getTrack("t1"))?.distanceM).toBe(999);
      });

      it("lists all saved tracks", async () => {
        await store.saveTrack(sampleTrack("t1"));
        await store.saveTrack(sampleTrack("t2"));
        const ids = (await store.listTracks()).map((t) => t.id).sort();
        expect(ids).toEqual(["t1", "t2"]);
      });

      it("deletes a track", async () => {
        await store.saveTrack(sampleTrack("t1"));
        await store.deleteTrack("t1");
        expect(await store.getTrack("t1")).toBeUndefined();
        expect(await store.listTracks()).toEqual([]);
      });

      it("does not throw deleting an unknown track", async () => {
        await expect(store.deleteTrack("missing")).resolves.toBeUndefined();
      });
    });

    describe("events", () => {
      it("saves and reads back an event losslessly", async () => {
        const e = sampleEvent("e1", "t1");
        await store.saveEvent(e);
        expect(await store.getEvent("e1")).toEqual(e);
      });

      it("scopes listEvents by trackId, including untracked events when unscoped", async () => {
        await store.saveEvent(sampleEvent("e1", "t1"));
        await store.saveEvent(sampleEvent("e2", "t2"));
        await store.saveEvent(sampleEvent("e3")); // no trackId

        const forT1 = (await store.listEvents("t1")).map((e) => e.id);
        expect(forT1).toEqual(["e1"]);

        const all = (await store.listEvents()).map((e) => e.id).sort();
        expect(all).toEqual(["e1", "e2", "e3"]);
      });

      it("deletes an event", async () => {
        await store.saveEvent(sampleEvent("e1"));
        await store.deleteEvent("e1");
        expect(await store.getEvent("e1")).toBeUndefined();
      });
    });

    describe("blobs", () => {
      it("stores a blob under a returned key and reads it back", async () => {
        const blob = new Blob([new Uint8Array([1, 2, 3, 4])], {
          type: "application/octet-stream",
        });
        const key = await store.putBlob(blob);
        expect(typeof key).toBe("string");
        const got = await store.getBlob(key);
        expect(got).toBeDefined();
        expect(await got!.arrayBuffer()).toEqual(await blob.arrayBuffer());
      });

      it("issues distinct keys for successive blobs", async () => {
        const k1 = await store.putBlob(new Blob(["a"]));
        const k2 = await store.putBlob(new Blob(["b"]));
        expect(k1).not.toBe(k2);
      });

      it("deletes a blob", async () => {
        const key = await store.putBlob(new Blob(["x"]));
        await store.deleteBlob(key);
        expect(await store.getBlob(key)).toBeUndefined();
      });

      it("returns undefined for an unknown blob key", async () => {
        expect(await store.getBlob("nope")).toBeUndefined();
      });
    });

    describe("clearAll", () => {
      it("removes every track, event, and blob", async () => {
        await store.saveTrack(sampleTrack("t1"));
        await store.saveEvent(sampleEvent("e1", "t1"));
        const key = await store.putBlob(new Blob(["bytes"]));

        await store.clearAll();

        expect(await store.listTracks()).toEqual([]);
        expect(await store.listEvents()).toEqual([]);
        expect(await store.getBlob(key)).toBeUndefined();
      });
    });
  });
}
