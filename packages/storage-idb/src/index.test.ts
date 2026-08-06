// SPDX-License-Identifier: Apache-2.0
import "fake-indexeddb/auto";
import { describe, it, expect } from "vitest";
import { runStorageAdapterConformance } from "../../core/src/testing/storage-conformance";
import { createIdbStorageAdapter } from "./index";

// A unique database per adapter keeps conformance cases isolated without
// tearing down IndexedDB between them.
let seq = 0;
const freshAdapter = () => createIdbStorageAdapter(`mapatlas-test-${seq++}`);

runStorageAdapterConformance("indexeddb", freshAdapter);

describe("@mapatlas/storage-idb clearAll", () => {
  it("wipes tracks, events, and blobs in one transaction", async () => {
    const store = freshAdapter();
    await store.saveTrack({
      id: "t1",
      startedAt: 0,
      status: "finalized",
      points: [],
    });
    await store.saveEvent({
      id: "e1",
      position: { lat: 1, lng: 2 },
      occurredAt: 0,
      media: [],
      tags: [],
    });
    const key = await store.putBlob(new Blob(["bytes"]));

    await store.clearAll();

    expect(await store.listTracks()).toEqual([]);
    expect(await store.listEvents()).toEqual([]);
    expect(await store.getBlob(key)).toBeUndefined();
  });
});
