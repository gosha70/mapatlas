// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { createMemoryStorageAdapter } from "./memory-storage";
import { runStorageAdapterConformance } from "./testing/storage-conformance";

// The in-memory fake is the reference implementation the conformance suite is
// proven against (T2.1 AC: "passes against an in-memory fake").
runStorageAdapterConformance("memory", () => createMemoryStorageAdapter());

describe("createMemoryStorageAdapter isolation", () => {
  it("does not leak state between instances", async () => {
    const a = createMemoryStorageAdapter();
    await a.saveTrack({
      id: "t1",
      startedAt: 0,
      status: "finalized",
      points: [],
    });
    const b = createMemoryStorageAdapter();
    expect(await b.listTracks()).toEqual([]);
  });

  it("does not expose stored records by reference", async () => {
    const store = createMemoryStorageAdapter();
    const track = {
      id: "t1",
      startedAt: 0,
      status: "recording" as const,
      points: [],
      tags: ["a"],
    };
    await store.saveTrack(track);
    track.tags.push("mutated-after-save");
    const stored = await store.getTrack("t1");
    expect(stored?.tags).toEqual(["a"]);
  });
});
