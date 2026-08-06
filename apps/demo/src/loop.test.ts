// SPDX-License-Identifier: Apache-2.0
// @vitest-environment node
import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import {
  EventLog,
  geoJSONToTrack,
  trackToGeoJSON,
  type MapEvent,
  type Track,
} from "@mapatlas/core";
import { createIdbStorageAdapter } from "@mapatlas/storage-idb";
import { createWebTrackRecorder } from "@mapatlas/recorder-web";
import {
  createPMTilesOfflineRegionStore,
  tilesForRegion,
  type TileByteSource,
} from "@mapatlas/offline-pmtiles";
import { createIdbTileCache } from "./idb-tile-cache";

/** A scriptable geolocation source (no live hardware). */
function fakeGeo() {
  const cbs: Array<(p: GeolocationPosition) => void> = [];
  const geo = {
    watchPosition(success: (p: GeolocationPosition) => void) {
      cbs.push(success);
      return 1;
    },
    clearWatch() {},
    getCurrentPosition() {},
  };
  const emit = (lat: number, lng: number, t: number) => {
    const pos = {
      coords: {
        latitude: lat,
        longitude: lng,
        accuracy: 5,
        altitude: null,
        altitudeAccuracy: null,
        heading: null,
        speed: null,
      },
      timestamp: t,
    } as unknown as GeolocationPosition;
    for (const cb of cbs) cb(pos);
  };
  return { geo: geo as unknown as Geolocation, emit };
}

const PHOTO = new Blob([new Uint8Array([9, 8, 7, 6])], { type: "image/jpeg" });

describe("demo field-logger loop (T7.1)", () => {
  it("records → pins an event with a photo → exports valid GeoJSON, offline and surviving reload", async () => {
    const dbName = "demo-loop";
    const store = createIdbStorageAdapter(dbName);

    // 1. Record a track (recorder persists it on stop).
    const { geo, emit } = fakeGeo();
    const recorder = createWebTrackRecorder(store, {
      geolocation: geo,
      wakeLock: null,
    });
    await recorder.start();
    emit(47.6, -122.33, 0);
    emit(47.61, -122.34, 2000);
    emit(47.62, -122.35, 4000);
    const track: Track = await recorder.stop();
    expect(track.status).toBe("finalized");
    expect(track.distanceM).toBeGreaterThan(0);

    // 2. Pin an event with a captured photo (photo bytes persisted by blobKey).
    const blobKey = await store.putBlob(PHOTO);
    const log = new EventLog(store, track.id);
    const event: MapEvent = await log.create({
      trackId: track.id,
      position: { lat: 47.61, lng: -122.34 },
      occurredAt: 2000,
      comment: "something worth noting",
      media: [{ id: "m1", mime: "image/jpeg", blobKey }],
      tags: ["note"],
    });

    // 3. Export valid GeoJSON that round-trips.
    const fc = trackToGeoJSON(track, [event]);
    expect(fc.type).toBe("FeatureCollection");
    expect(Array.isArray(fc.features)).toBe(true);
    expect(fc.features.every((f) => f.type === "Feature")).toBe(true);
    expect(fc.features.some((f) => f.geometry?.type === "LineString")).toBe(
      true,
    );
    expect(fc.features.some((f) => f.geometry?.type === "Point")).toBe(true);
    // Serialises as valid JSON (i.e. a real .geojson export).
    expect(() => JSON.parse(JSON.stringify(fc))).not.toThrow();
    const round = geoJSONToTrack(JSON.parse(JSON.stringify(fc)));
    expect(round.track.points).toHaveLength(track.points.length);
    expect(round.events[0]?.comment).toBe("something worth noting");
    expect(round.events[0]?.media[0]?.blobKey).toBe(blobKey);

    // 4. Survives reload: a fresh adapter over the same database sees everything.
    const reopened = createIdbStorageAdapter(dbName);
    const tracks = await reopened.listTracks();
    expect(tracks.map((t) => t.id)).toContain(track.id);
    const events = await reopened.listEvents(track.id);
    expect(events.map((e) => e.id)).toContain(event.id);
    const photo = await reopened.getBlob(blobKey);
    expect(photo).toBeDefined();
    expect(await photo!.arrayBuffer()).toEqual(await PHOTO.arrayBuffer());
  });

  it("downloads an offline region that renders with the network disabled and survives reload", async () => {
    const cacheName = "demo-loop-tiles";
    const state = { online: true };
    const source: TileByteSource = {
      getTile(z, x, y) {
        if (!state.online) throw new Error("network disabled");
        return Promise.resolve(
          new TextEncoder().encode(`t${z}/${x}/${y}`).buffer,
        );
      },
    };
    const region = {
      name: "Area",
      bbox: [-122.34, 47.6, -122.33, 47.61] as [number, number, number, number],
      minZoom: 13,
      maxZoom: 13,
    };

    const offline = createPMTilesOfflineRegionStore({
      source,
      cache: createIdbTileCache(cacheName),
    });
    const saved = await offline.download(region);
    expect(saved.sizeBytes).toBeGreaterThan(0);

    // Cut the network entirely.
    state.online = false;

    // Reload: a fresh store over the same tile cache still serves the region.
    const reopened = createPMTilesOfflineRegionStore({
      source,
      cache: createIdbTileCache(cacheName),
    });
    const listed = await reopened.list();
    expect(listed.map((r) => r.id)).toContain(saved.id);

    const tiles = tilesForRegion(region.bbox, region.minZoom, region.maxZoom);
    for (const t of tiles) {
      const bytes = await reopened.readTile(saved.id, t.z, t.x, t.y);
      expect(bytes).toBeDefined();
    }
  });
});
