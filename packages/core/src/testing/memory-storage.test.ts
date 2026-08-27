// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import type { MapEvent } from "../event.js";
import { newId } from "../ids.js";
import type { Track } from "../track.js";
import { createMemoryMapAssetStore, createMemoryStorageAdapter } from "./memory-storage.js";

const T0 = 1_700_000_000_000;

function track(overrides: Partial<Track> = {}): Track {
  const points = [
    { lat: 59.33, lng: 18.06, t: T0 },
    { lat: 59.34, lng: 18.07, t: T0 + 60_000 },
  ];
  return {
    id: newId(),
    startedAt: T0,
    endedAt: T0 + 60_000,
    status: "finalized",
    origin: "recorded",
    points,
    segments: [{ id: newId(), startIndex: 0, endIndex: 1, startedAt: T0 }],
    ...overrides,
  };
}

function event(overrides: Partial<MapEvent> = {}): MapEvent {
  return {
    id: newId(),
    position: { lat: 59.33, lng: 18.06 },
    occurredAt: T0,
    media: [],
    tags: [],
    ...overrides,
  };
}

const blob = (text: string): Blob => new Blob([text], { type: "text/plain" });

describe("value semantics — the property a shipped reference implementation must have", () => {
  it("does not let a caller mutate stored state through what getTrack returned", async () => {
    // The divergence this prevents: IndexedDB serialises and hands back a copy, so code
    // that mutates a retrieved track passes against a naive in-memory store and fails
    // against real persistence.
    const store = createMemoryStorageAdapter();
    const original = track();
    await store.saveTrack(original);

    const retrieved = await store.getTrack(original.id);
    retrieved?.points.push({ lat: 0, lng: 0, t: 0 });
    retrieved?.tags?.push("mutated");

    const again = await store.getTrack(original.id);
    expect(again?.points).toHaveLength(2);
    expect(again?.tags).toBeUndefined();
  });

  it("does not let a caller mutate stored state through the object it saved", async () => {
    const store = createMemoryStorageAdapter();
    const original = track();
    await store.saveTrack(original);

    original.points.push({ lat: 0, lng: 0, t: 0 });

    expect((await store.getTrack(original.id))?.points).toHaveLength(2);
  });

  it("applies the same copying to events", async () => {
    const store = createMemoryStorageAdapter();
    const original = event({ tags: ["a"] });
    await store.saveEvent(original);

    original.tags.push("b");
    (await store.getEvent(original.id))?.tags.push("c");

    expect((await store.getEvent(original.id))?.tags).toEqual(["a"]);
  });

  it("returns copies from listEvents too", async () => {
    const store = createMemoryStorageAdapter();
    await store.saveEvent(event({ tags: ["a"] }));

    const listed = await store.listEvents();
    listed[0]?.tags.push("mutated");

    expect((await store.listEvents())[0]?.tags).toEqual(["a"]);
  });
});

describe("tracks", () => {
  it("round-trips a track", async () => {
    const store = createMemoryStorageAdapter();
    const saved = track();
    await store.saveTrack(saved);
    expect(await store.getTrack(saved.id)).toEqual(saved);
  });

  it("returns undefined for an unknown id", async () => {
    expect(await createMemoryStorageAdapter().getTrack(newId())).toBeUndefined();
  });

  it("overwrites on a second save", async () => {
    const store = createMemoryStorageAdapter();
    const original = track({ tags: ["first"] });
    await store.saveTrack(original);
    await store.saveTrack({ ...original, tags: ["second"] });

    expect((await store.getTrack(original.id))?.tags).toEqual(["second"]);
    expect(await store.listTrackSummaries()).toHaveLength(1);
  });
});

describe("summaries", () => {
  it("carries no point array — the observable shape of the projection", async () => {
    const store = createMemoryStorageAdapter();
    await store.saveTrack(track());

    const [summary] = await store.listTrackSummaries();
    expect(summary).not.toHaveProperty("points");
    expect(summary).not.toHaveProperty("simplifiedSegments");
    expect(summary).not.toHaveProperty("segments");
  });

  it("reports counts, bounds and endpoints", async () => {
    const store = createMemoryStorageAdapter();
    const saved = track();
    await store.saveTrack(saved);
    await store.saveEvent(event({ trackId: saved.id }));
    await store.saveEvent(event({ trackId: saved.id }));

    const [summary] = await store.listTrackSummaries();
    expect(summary?.pointCount).toBe(2);
    expect(summary?.eventCount).toBe(2);
    expect(summary?.bbox).toEqual([18.06, 59.33, 18.07, 59.34]);
    expect(summary?.start).toEqual({ lat: 59.33, lng: 18.06 });
    expect(summary?.finish).toEqual({ lat: 59.34, lng: 18.07 });
  });

  it("returns startedAt order, not id order (ADR-0014)", async () => {
    // The trap: an imported 2019 trip is minted today, so it sorts last by id and first by
    // startedAt. The returned order is asserted directly — sorting it here first would
    // normalise away exactly what is under test.
    const store = createMemoryStorageAdapter();
    const recent = track({ startedAt: T0 });
    const importedOld = track({ startedAt: T0 - 200_000_000_000, origin: "imported" });

    await store.saveTrack(recent);
    await store.saveTrack(importedOld);

    expect((await store.listTrackSummaries()).map((s) => s.id)).toEqual([
      importedOld.id,
      recent.id,
    ]);
    expect(importedOld.id > recent.id).toBe(true); // and id order would have been the reverse
  });

  it("breaks ties by id, so the order is total", async () => {
    const store = createMemoryStorageAdapter();
    const shared = T0 + 5000;
    const tracks = [track({ startedAt: shared }), track({ startedAt: shared })];
    for (const t of tracks) await store.saveTrack(t);

    const expected = tracks.map((t) => t.id).sort((a, b) => a.localeCompare(b));
    expect((await store.listTrackSummaries()).map((s) => s.id)).toEqual(expected);
  });

  it("returns an empty list for an empty store", async () => {
    expect(await createMemoryStorageAdapter().listTrackSummaries()).toEqual([]);
  });
});

describe("events", () => {
  it("filters by track, and returns everything when unfiltered", async () => {
    const store = createMemoryStorageAdapter();
    const a = newId();
    const b = newId();
    await store.saveEvent(event({ trackId: a }));
    await store.saveEvent(event({ trackId: a }));
    await store.saveEvent(event({ trackId: b }));
    await store.saveEvent(event());

    expect(await store.listEvents(a)).toHaveLength(2);
    expect(await store.listEvents(b)).toHaveLength(1);
    expect(await store.listEvents()).toHaveLength(4);
  });

  it("deletes an event without touching its neighbours", async () => {
    const store = createMemoryStorageAdapter();
    const doomed = event();
    await store.saveEvent(doomed);
    await store.saveEvent(event());

    await store.deleteEvent(doomed.id);

    expect(await store.getEvent(doomed.id)).toBeUndefined();
    expect(await store.listEvents()).toHaveLength(1);
  });
});

describe("blobs and cascade deletion", () => {
  it("round-trips a blob", async () => {
    const store = createMemoryStorageAdapter();
    const key = await store.putBlob(blob("photo bytes"));
    expect(await (await store.getBlob(key))?.text()).toBe("photo bytes");
  });

  it("deletes a track's events and the blobs only they referenced", async () => {
    const store = createMemoryStorageAdapter();
    const trip = track();
    const key = await store.putBlob(blob("photo"));
    await store.saveTrack(trip);
    await store.saveEvent(
      event({ trackId: trip.id, media: [{ id: newId(), mime: "image/jpeg", blobKey: key }] }),
    );

    await store.deleteTrack(trip.id);

    expect(await store.getTrack(trip.id)).toBeUndefined();
    expect(await store.listEvents()).toHaveLength(0);
    expect(await store.getBlob(key)).toBeUndefined();
  });

  it("keeps a blob another event still references", async () => {
    const store = createMemoryStorageAdapter();
    const trip = track();
    const shared = await store.putBlob(blob("shared"));
    const media = [{ id: newId(), mime: "image/jpeg", blobKey: shared }];

    await store.saveTrack(trip);
    await store.saveEvent(event({ trackId: trip.id, media }));
    await store.saveEvent(event({ media })); // belongs to no track, survives

    await store.deleteTrack(trip.id);

    expect(await store.getBlob(shared)).toBeDefined();
    expect(await store.listEvents()).toHaveLength(1);
  });

  it("leaves events belonging to other tracks alone", async () => {
    const store = createMemoryStorageAdapter();
    const doomed = track();
    const survivor = track();
    await store.saveTrack(doomed);
    await store.saveTrack(survivor);
    await store.saveEvent(event({ trackId: doomed.id }));
    await store.saveEvent(event({ trackId: survivor.id }));

    await store.deleteTrack(doomed.id);

    expect(await store.listEvents()).toHaveLength(1);
    expect(await store.getTrack(survivor.id)).toBeDefined();
  });
});

describe("clearAll", () => {
  it("removes every track, event and blob", async () => {
    const store = createMemoryStorageAdapter();
    await store.saveTrack(track());
    await store.saveEvent(event());
    await store.putBlob(blob("x"));

    await store.clearAll();

    expect(await store.listTrackSummaries()).toEqual([]);
    expect(await store.listEvents()).toEqual([]);
    expect(store.blobKeys()).toEqual([]);
  });
});

describe("map assets are a separate store (ADR-0016)", () => {
  it("survives a clearAll of the consumer's data", async () => {
    const data = createMemoryStorageAdapter();
    const assets = createMemoryMapAssetStore();

    await data.saveTrack(track());
    await assets.put("region-1.pmtiles", blob("map bytes"));

    await data.clearAll();

    // Signing out must not force a multi-hundred-megabyte re-download.
    expect(await assets.get("region-1.pmtiles")).toBeDefined();
  });

  it("clearing map assets does not touch tracks or events", async () => {
    const data = createMemoryStorageAdapter();
    const assets = createMemoryMapAssetStore();

    const trip = track();
    await data.saveTrack(trip);
    await assets.put("region-1.pmtiles", blob("map bytes"));

    await assets.clear();

    expect(await data.getTrack(trip.id)).toBeDefined();
    expect(await assets.list()).toEqual([]);
  });

  it("estimates its size from what it holds", async () => {
    const assets = createMemoryMapAssetStore();
    await assets.put("a", blob("1234567890"));
    await assets.put("b", blob("12345"));
    expect(await assets.estimateBytes()).toBe(15);
  });
});
