// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from "vitest";
import { createMemoryStorageAdapter } from "@mapatlas/core";
import type { TrackPoint, TrackRecorderError } from "@mapatlas/core";
import { createWebTrackRecorder } from "./index";

/** A scriptable geolocation source: emit positions / errors on demand. */
class FakeGeolocation {
  private nextId = 0;
  private watchers = new Map<
    number,
    {
      success: (p: GeolocationPosition) => void;
      error?: (e: GeolocationPositionError) => void;
    }
  >();

  watchPosition(
    success: (p: GeolocationPosition) => void,
    error?: (e: GeolocationPositionError) => void,
  ): number {
    const id = ++this.nextId;
    this.watchers.set(id, { success, error: error ?? undefined });
    return id;
  }
  clearWatch(id: number): void {
    this.watchers.delete(id);
  }
  getCurrentPosition(): void {
    /* unused */
  }
  get watchCount(): number {
    return this.watchers.size;
  }
  emit(lat: number, lng: number, t: number, accuracyM: number): void {
    const pos = {
      coords: {
        latitude: lat,
        longitude: lng,
        accuracy: accuracyM,
        altitude: null,
        altitudeAccuracy: null,
        heading: null,
        speed: null,
      },
      timestamp: t,
    } as unknown as GeolocationPosition;
    for (const w of this.watchers.values()) w.success(pos);
  }
  emitError(code: number, message = "err"): void {
    const err = { code, message } as unknown as GeolocationPositionError;
    for (const w of this.watchers.values()) w.error?.(err);
  }
}

/** A wake-lock source that records acquire/release. */
function fakeWakeLock() {
  const state = { held: false, acquires: 0, releases: 0 };
  const source = {
    request() {
      state.acquires++;
      state.held = true;
      return Promise.resolve({
        release: () => {
          state.releases++;
          state.held = false;
          return Promise.resolve();
        },
      });
    },
  };
  return { source, state };
}

describe("createWebTrackRecorder", () => {
  let geo: FakeGeolocation;
  let wake: ReturnType<typeof fakeWakeLock>;

  beforeEach(() => {
    geo = new FakeGeolocation();
    wake = fakeWakeLock();
  });

  const make = (store?: Parameters<typeof createWebTrackRecorder>[0]) =>
    createWebTrackRecorder(store, {
      geolocation: geo as unknown as Geolocation,
      wakeLock: wake.source,
    });

  it("acquires a Wake Lock and enters recording on start", async () => {
    const rec = make();
    expect(rec.status).toBe("paused");
    await rec.start();
    expect(rec.status).toBe("recording");
    expect(wake.state.held).toBe(true);
    expect(geo.watchCount).toBe(1);
  });

  it("emits only accuracy-passing points, honouring distance/interval sampling", async () => {
    const rec = make();
    const kept: TrackPoint[] = [];
    rec.onPoint((p) => kept.push(p));
    await rec.start();

    geo.emit(47.6, -122.33, 0, 5); // first — kept
    geo.emit(47.6, -122.33, 500, 80); // low-accuracy — dropped
    geo.emit(47.60001, -122.33001, 1000, 5); // too close (~1.4m) — dropped
    geo.emit(47.601, -122.33, 2000, 5); // ~111m away — kept (distance)

    expect(kept.map((p) => p.accuracyM)).toEqual([5, 5]);
    expect(kept.map((p) => Math.round(p.lat * 1000))).toEqual([47600, 47601]);
  });

  it("stop() returns a finalized Track with simplified geometry and distance", async () => {
    const rec = make();
    await rec.start();
    geo.emit(47.6, -122.33, 0, 5);
    geo.emit(47.601, -122.33, 2000, 5);

    const track = await rec.stop();
    expect(rec.status).toBe("finalized");
    expect(track.status).toBe("finalized");
    expect(track.endedAt).toBeGreaterThanOrEqual(track.startedAt);
    expect(track.simplified).toBeDefined();
    expect(track.distanceM).toBeGreaterThan(100);
    expect(track.points).toHaveLength(2);
    expect(wake.state.held).toBe(false);
  });

  it("releases the Wake Lock on pause and re-acquires on resume", async () => {
    const rec = make();
    await rec.start();
    expect(wake.state.acquires).toBe(1);

    rec.pause();
    expect(rec.status).toBe("paused");
    expect(wake.state.held).toBe(false);
    expect(geo.watchCount).toBe(0);

    // Points arriving while paused are ignored.
    const kept: TrackPoint[] = [];
    rec.onPoint((p) => kept.push(p));
    geo.emit(47.6, -122.33, 0, 5);
    expect(kept).toHaveLength(0);

    rec.resume();
    expect(rec.status).toBe("recording");
    expect(wake.state.held).toBe(true);
    expect(wake.state.acquires).toBe(2);
    expect(geo.watchCount).toBe(1);
  });

  it("maps geolocation error codes to stable error kinds", async () => {
    const rec = make();
    const errors: TrackRecorderError[] = [];
    rec.onError((e) => errors.push(e));
    await rec.start();

    geo.emitError(1);
    geo.emitError(2);
    geo.emitError(3);
    expect(errors.map((e) => e.kind)).toEqual([
      "permission-denied",
      "position-unavailable",
      "timeout",
    ]);
  });

  it("reports 'unsupported' when no geolocation is available", async () => {
    const rec = createWebTrackRecorder(undefined, { geolocation: undefined });
    const errors: TrackRecorderError[] = [];
    rec.onError((e) => errors.push(e));
    await rec.start();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.kind).toBe("unsupported");
    expect(rec.status).toBe("paused");
  });

  it("persists the finalized track when a store is provided", async () => {
    const store = createMemoryStorageAdapter();
    const rec = make(store);
    await rec.start();
    geo.emit(47.6, -122.33, 0, 5);
    const track = await rec.stop();
    expect(await store.getTrack(track.id)).toEqual(track);
  });
});
