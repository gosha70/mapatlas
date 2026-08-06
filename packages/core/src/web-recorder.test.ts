// SPDX-License-Identifier: Apache-2.0

/**
 * T3.1 acceptance: with a mocked geolocation the web recorder emits only
 * accuracy-passing points, `stop()` returns a finalized Track, and the Wake
 * Lock is acquired on start and released on stop/pause.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TrackPoint } from "./types.js";
import { InMemoryStorageAdapter } from "./fake-storage.js";
import { createWebTrackRecorder } from "./web-recorder.js";

/** A controllable `navigator.geolocation` fake. */
function makeGeoMock() {
  let success: ((p: GeolocationPosition) => void) | undefined;
  let failure: ((e: GeolocationPositionError) => void) | undefined;
  const cleared: number[] = [];
  const geolocation = {
    watchPosition: vi.fn(
      (
        ok: (p: GeolocationPosition) => void,
        err?: (e: GeolocationPositionError) => void,
      ) => {
        success = ok;
        failure = err;
        return 42;
      },
    ),
    clearWatch: vi.fn((id: number) => cleared.push(id)),
    getCurrentPosition: vi.fn(),
  };
  const emit = (
    over: Partial<GeolocationCoordinates> & { t?: number },
  ): void => {
    const coords = {
      latitude: 0,
      longitude: 0,
      accuracy: 5,
      altitude: null,
      altitudeAccuracy: null,
      heading: null,
      speed: null,
      ...over,
    } as GeolocationCoordinates;
    success?.({
      coords,
      timestamp: over.t ?? Date.now(),
    } as GeolocationPosition);
  };
  const fail = (code: number, message = "err"): void => {
    failure?.({
      code,
      message,
      PERMISSION_DENIED: 1,
      POSITION_UNAVAILABLE: 2,
      TIMEOUT: 3,
    } as GeolocationPositionError);
  };
  return { geolocation, emit, fail, cleared };
}

function makeWakeLockMock() {
  const release = vi.fn(() => Promise.resolve());
  const sentinel = { released: false, release } as unknown as WakeLockSentinel;
  const request = vi.fn(() => Promise.resolve(sentinel));
  return { wakeLock: { request }, request, release };
}

function install(
  geo: ReturnType<typeof makeGeoMock>,
  wl?: { request: unknown },
) {
  vi.stubGlobal("navigator", {
    geolocation: geo.geolocation,
    ...(wl ? { wakeLock: wl } : {}),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("createWebTrackRecorder", () => {
  it("emits only accuracy-passing points", async () => {
    const geo = makeGeoMock();
    install(geo);
    const rec = createWebTrackRecorder();
    const seen: TrackPoint[] = [];
    rec.onPoint((p) => seen.push(p));

    await rec.start({ minDistanceM: 0, maxIntervalMs: 0, maxAccuracyM: 50 });
    geo.emit({ latitude: 1, longitude: 1, accuracy: 5, t: 1000 }); // keep
    geo.emit({ latitude: 2, longitude: 2, accuracy: 500, t: 2000 }); // drop (accuracy)
    geo.emit({ latitude: 3, longitude: 3, accuracy: 10, t: 3000 }); // keep

    expect(seen).toHaveLength(2);
    expect(seen.map((p) => p.lat)).toEqual([1, 3]);
    expect(rec.status).toBe("recording");
  });

  it("stop() returns a finalized Track with simplified + distanceM", async () => {
    const geo = makeGeoMock();
    install(geo);
    const rec = createWebTrackRecorder();
    await rec.start({ minDistanceM: 0, maxIntervalMs: 0, maxAccuracyM: 50 });
    geo.emit({ latitude: 10, longitude: 10, accuracy: 5, t: 1000 });
    geo.emit({ latitude: 10.01, longitude: 10.01, accuracy: 5, t: 2000 });

    const track = await rec.stop();
    expect(track.status).toBe("finalized");
    expect(track.id).toBeTruthy();
    expect(track.endedAt).toBeGreaterThanOrEqual(track.startedAt);
    expect(track.simplified).toBeDefined();
    expect(track.distanceM).toBeGreaterThan(0);
    expect(rec.status).toBe("finalized");
  });

  it("persists the finalized Track when a store is provided", async () => {
    const geo = makeGeoMock();
    install(geo);
    const store = new InMemoryStorageAdapter();
    const rec = createWebTrackRecorder(store);
    await rec.start({ minDistanceM: 0, maxIntervalMs: 0 });
    geo.emit({ latitude: 1, longitude: 1, accuracy: 5, t: 1000 });
    const track = await rec.stop();
    expect(await store.getTrack(track.id)).toEqual(track);
  });

  it("acquires the Wake Lock on start and releases it on stop", async () => {
    const geo = makeGeoMock();
    const wl = makeWakeLockMock();
    install(geo, wl.wakeLock);
    const rec = createWebTrackRecorder();

    await rec.start();
    expect(wl.request).toHaveBeenCalledWith("screen");
    expect(wl.release).not.toHaveBeenCalled();

    await rec.stop();
    expect(wl.release).toHaveBeenCalledTimes(1);
  });

  it("releases the Wake Lock on pause and re-acquires on resume", async () => {
    const geo = makeGeoMock();
    const wl = makeWakeLockMock();
    install(geo, wl.wakeLock);
    const rec = createWebTrackRecorder();

    await rec.start();
    rec.pause();
    await Promise.resolve();
    expect(rec.status).toBe("paused");
    expect(wl.release).toHaveBeenCalledTimes(1);
    expect(geo.cleared).toContain(42);

    rec.resume();
    await Promise.resolve();
    expect(rec.status).toBe("recording");
    expect(wl.request).toHaveBeenCalledTimes(2);
  });

  it("maps geolocation errors onto the recorder taxonomy", async () => {
    const geo = makeGeoMock();
    install(geo);
    const rec = createWebTrackRecorder();
    const errs: string[] = [];
    rec.onError((e) => errs.push(e.kind));
    await rec.start();

    geo.fail(1);
    geo.fail(2);
    geo.fail(3);
    expect(errs).toEqual([
      "permission-denied",
      "position-unavailable",
      "timeout",
    ]);
  });

  it("emits an 'unsupported' error when geolocation is missing", async () => {
    vi.stubGlobal("navigator", {});
    const rec = createWebTrackRecorder();
    const errs: string[] = [];
    rec.onError((e) => errs.push(e.kind));
    await rec.start();
    expect(errs).toEqual(["unsupported"]);
  });
});
