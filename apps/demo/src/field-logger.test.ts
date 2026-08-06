// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

/**
 * T7.1 acceptance: the full record → pin → photo → review loop works with no
 * network, survives a reload (a new adapter over the same IndexedDB database),
 * and exports valid GeoJSON.
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Track,
  TrackPoint,
  TrackRecorder,
  TrackRecorderError,
} from "@mapatlas/core";
import { geoJSONToTrack, noopAnalyzer } from "@mapatlas/core";
import { IdbStorageAdapter } from "@mapatlas/storage-idb";
import { FieldLogger } from "./field-logger.js";

/** A scripted recorder that yields a fixed finalized track on stop(). */
class ScriptedRecorder implements TrackRecorder {
  status: TrackRecorder["status"] = "paused";
  constructor(private readonly track: Track) {}
  start = async (): Promise<void> => {
    this.status = "recording";
  };
  pause = (): void => {
    this.status = "paused";
  };
  resume = (): void => {
    this.status = "recording";
  };
  stop = async (): Promise<Track> => {
    this.status = "finalized";
    return this.track;
  };
  onPoint(_cb: (p: TrackPoint) => void): () => void {
    return () => {};
  }
  onError(_cb: (e: TrackRecorderError) => void): () => void {
    return () => {};
  }
}

const TRACK: Track = {
  id: "trip-1",
  startedAt: 1000,
  endedAt: 4000,
  status: "finalized",
  points: [
    { lat: 51.5, lng: -0.1, t: 1000 },
    { lat: 51.51, lng: -0.09, t: 2500 },
    { lat: 51.52, lng: -0.08, t: 4000 },
  ],
  simplified: [
    { lat: 51.5, lng: -0.1, t: 1000 },
    { lat: 51.52, lng: -0.08, t: 4000 },
  ],
  distanceM: 2400,
};

const DB = "field-logger-test";

beforeEach(() => {
  globalThis.URL.createObjectURL = vi.fn(() => "blob:mock");
});

afterEach(() => vi.restoreAllMocks());

describe("FieldLogger loop", () => {
  it("records, pins a photo event, reviews, survives reload, exports GeoJSON", async () => {
    // Offline: forbid the network for the whole loop.
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("network disabled"));

    const storage = new IdbStorageAdapter({
      dbName: DB,
      indexedDB: new IDBFactory(),
    });
    const logger = new FieldLogger({
      storage,
      recorder: new ScriptedRecorder(TRACK),
      analyzer: noopAnalyzer,
    });

    // record
    await logger.start();
    expect(logger.status).toBe("recording");
    const track = await logger.stop();
    expect(track.id).toBe("trip-1");

    // pin + photo
    const photo = new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" });
    const event = await logger.addEvent({
      at: { lat: 51.51, lng: -0.09 },
      comment: "a heron",
      tags: ["bird"],
      photos: [{ blob: photo }],
    });
    expect(event.trackId).toBe("trip-1");
    expect(event.media[0]!.blobKey).toBeTruthy();

    // review
    const trip = await logger.loadTrip("trip-1");
    expect(trip?.events).toHaveLength(1);
    const url = await logger.photoUrl(trip!.events[0]!.media[0]!);
    expect(url).toBe("blob:mock");

    // export valid GeoJSON (round-trips)
    const fc = await logger.exportGeoJSON("trip-1");
    expect(fc.type).toBe("FeatureCollection");
    expect(fc.features.length).toBe(2);
    for (const f of fc.features) {
      expect(f.type).toBe("Feature");
      expect(f.geometry).not.toBeNull(); // ADR-0008
    }
    const back = geoJSONToTrack(fc);
    expect(back.track.id).toBe("trip-1");
    expect(back.events[0]!.comment).toBe("a heron");
    expect(back.events[0]!.media[0]!.blobKey).toBe(event.media[0]!.blobKey);

    // Reload survival is covered by the next test (same IndexedDB factory).
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("persists across a reload using the same IndexedDB factory", async () => {
    const factory = new IDBFactory();
    const dbName = "field-logger-reload";

    const first = new IdbStorageAdapter({ dbName, indexedDB: factory });
    const logger1 = new FieldLogger({
      storage: first,
      recorder: new ScriptedRecorder(TRACK),
    });
    await logger1.start();
    await logger1.stop();
    await logger1.addEvent({
      at: { lat: 51.5, lng: -0.1 },
      comment: "kept",
    });
    await first.close();

    // "Reload": brand-new adapter, same database.
    const second = new IdbStorageAdapter({ dbName, indexedDB: factory });
    const logger2 = new FieldLogger({
      storage: second,
      recorder: new ScriptedRecorder(TRACK),
    });
    const trip = await logger2.loadTrip("trip-1");
    expect(trip).toBeDefined();
    expect(trip!.events[0]!.comment).toBe("kept");
  });
});
