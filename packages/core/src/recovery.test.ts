// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";

import { newId } from "./ids.js";
import { listInterruptedTracks, recoverInterruptedTrack } from "./recovery.js";
import type { StorageAdapter } from "./storage.js";
import { createMemoryStorageAdapter } from "./testing/memory-storage.js";
import type { Track } from "./track.js";

const T0 = 1_700_000_000_000;

function track(status: Track["status"], startedAt = T0, id = newId()): Track {
  const points = [
    { lat: 59.33, lng: 18.06, t: startedAt },
    { lat: 59.34, lng: 18.07, t: startedAt + 60_000 },
  ];
  return {
    id,
    startedAt,
    status,
    origin: "recorded",
    points,
    segments: [{ id: newId(), startIndex: 0, endIndex: 1, startedAt }],
  };
}

describe("recoverInterruptedTrack", () => {
  it("returns a track left mid-recording", async () => {
    const store = createMemoryStorageAdapter();
    const interrupted = track("recording");
    await store.saveTrack(interrupted);

    const recovered = await recoverInterruptedTrack(store);
    expect(recovered?.id).toBe(interrupted.id);
    expect(recovered?.points).toHaveLength(2);
  });

  it("returns a track left paused — nobody finalized it either", async () => {
    const store = createMemoryStorageAdapter();
    await store.saveTrack(track("paused"));
    expect(await recoverInterruptedTrack(store)).toBeDefined();
  });

  it("returns undefined when every track is finalized", async () => {
    const store = createMemoryStorageAdapter();
    await store.saveTrack(track("finalized"));
    await store.saveTrack(track("finalized", T0 + 1000));

    expect(await recoverInterruptedTrack(store)).toBeUndefined();
  });

  it("returns undefined for an empty store", async () => {
    expect(await recoverInterruptedTrack(createMemoryStorageAdapter())).toBeUndefined();
  });

  it("ignores finalized tracks alongside an interrupted one", async () => {
    const store = createMemoryStorageAdapter();
    await store.saveTrack(track("finalized", T0 + 10_000));
    const interrupted = track("recording", T0);
    await store.saveTrack(interrupted);
    await store.saveTrack(track("finalized", T0 + 20_000));

    expect((await recoverInterruptedTrack(store))?.id).toBe(interrupted.id);
  });

  it("prefers the most recently started when a device crashed more than once", async () => {
    const store = createMemoryStorageAdapter();
    await store.saveTrack(track("recording", T0));
    const newest = track("recording", T0 + 3_600_000);
    await store.saveTrack(newest);
    await store.saveTrack(track("paused", T0 + 1_800_000));

    expect((await recoverInterruptedTrack(store))?.id).toBe(newest.id);
  });

  it("hydrates only the one candidate, reading summaries for the rest", async () => {
    // The projection earning its keep: a device holding a hundred trips must not
    // deserialize a hundred point arrays to answer a question about status.
    const inner = createMemoryStorageAdapter();
    for (let i = 0; i < 20; i += 1) await inner.saveTrack(track("finalized", T0 + i * 1000));
    const interrupted = track("recording", T0 + 99_000);
    await inner.saveTrack(interrupted);

    const getTrack = vi.fn(inner.getTrack);
    const listTrackSummaries = vi.fn(inner.listTrackSummaries);
    const store: StorageAdapter = { ...inner, getTrack, listTrackSummaries };

    const recovered = await recoverInterruptedTrack(store);

    expect(recovered?.id).toBe(interrupted.id);
    expect(listTrackSummaries).toHaveBeenCalledTimes(1);
    expect(getTrack).toHaveBeenCalledTimes(1);
    expect(getTrack).toHaveBeenCalledWith(interrupted.id);
  });

  it("reads nothing at all when there is nothing to recover", async () => {
    const inner = createMemoryStorageAdapter();
    await inner.saveTrack(track("finalized"));
    const getTrack = vi.fn(inner.getTrack);

    await recoverInterruptedTrack({ ...inner, getTrack });

    expect(getTrack).not.toHaveBeenCalled();
  });

  it("does not modify the store", async () => {
    const store = createMemoryStorageAdapter();
    await store.saveTrack(track("recording"));
    const before = await store.listTrackSummaries();

    await recoverInterruptedTrack(store);

    expect(await store.listTrackSummaries()).toEqual(before);
  });
});

describe("listInterruptedTracks", () => {
  it("returns every interrupted track, newest first", async () => {
    const store = createMemoryStorageAdapter();
    const oldest = track("recording", T0);
    const middle = track("paused", T0 + 1000);
    const newest = track("recording", T0 + 2000);
    await store.saveTrack(middle);
    await store.saveTrack(newest);
    await store.saveTrack(oldest);
    await store.saveTrack(track("finalized", T0 + 5000));

    const found = await listInterruptedTracks(store);
    expect(found.map((t) => t.id)).toEqual([newest.id, middle.id, oldest.id]);
  });

  it("returns an empty list when there is nothing to recover", async () => {
    const store = createMemoryStorageAdapter();
    await store.saveTrack(track("finalized"));
    expect(await listInterruptedTracks(store)).toEqual([]);
  });

  it("agrees with recoverInterruptedTrack on which one is first", async () => {
    const store = createMemoryStorageAdapter();
    await store.saveTrack(track("recording", T0));
    await store.saveTrack(track("paused", T0 + 9999));

    const [first] = await listInterruptedTracks(store);
    expect((await recoverInterruptedTrack(store))?.id).toBe(first?.id);
  });
});
