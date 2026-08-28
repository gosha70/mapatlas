// SPDX-License-Identifier: Apache-2.0
import type { TrackPoint } from "@mapatlas/core";
import { afterEach, describe, expect, it } from "vitest";

import { createBrowserEnvironment } from "./environment.js";
import { createWebTrackRecorder } from "./recorder.js";

/**
 * The public factory on the real browser wiring.
 *
 * Everything about the recorder's behaviour is covered deterministically through the
 * injected environment; this exists solely to prove the default wiring is connected —
 * `navigator.geolocation.watchPosition`, `clearWatch`, `navigator.wakeLock.request` — which
 * an injected environment can never demonstrate. It is the one thing that would still be
 * broken if every other test passed.
 */

interface FakeGeolocation {
  watchPosition: (
    success: (position: unknown) => void,
    failure: (error: unknown) => void,
    options?: unknown,
  ) => number;
  clearWatch: (id: number) => void;
}

const originalNavigator = globalThis.navigator;

function installNavigator(value: unknown): void {
  Object.defineProperty(globalThis, "navigator", {
    value,
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  installNavigator(originalNavigator);
});

describe("createWebTrackRecorder wires itself to the browser", () => {
  it("registers a watch, records what it delivers, and clears it on stop", async () => {
    let watchers: ((position: unknown) => void)[] = [];
    const cleared: number[] = [];
    let optionsSeen: Record<string, unknown> | undefined;
    let wakeLockReleased = false;

    const geolocation: FakeGeolocation = {
      watchPosition: (success, _failure, options) => {
        watchers.push(success);
        optionsSeen = options as Record<string, unknown>;
        return watchers.length;
      },
      clearWatch: (id) => {
        cleared.push(id);
      },
    };

    installNavigator({
      geolocation,
      wakeLock: {
        request: () =>
          Promise.resolve({
            release: () => {
              wakeLockReleased = true;
              return Promise.resolve();
            },
          }),
      },
    });

    const recorder = createWebTrackRecorder();
    const emitted: TrackPoint[] = [];
    recorder.onPoint((point) => emitted.push(point));

    await recorder.start();
    expect(watchers).toHaveLength(1);
    // The real environment asks for GPS rather than a coarse network fix.
    expect(optionsSeen?.["enableHighAccuracy"]).toBe(true);

    const now = Date.now();
    for (const watcher of watchers) {
      watcher({ coords: { latitude: 59.33, longitude: 18.06, accuracy: 5 }, timestamp: now });
    }

    const track = await recorder.stop();

    expect(track.points).toHaveLength(1);
    expect(emitted).toHaveLength(1);
    expect(cleared).toHaveLength(1);
    await Promise.resolve();
    expect(wakeLockReleased).toBe(true);

    watchers = [];
  });

  it("records without a wake lock where the browser has none", async () => {
    installNavigator({
      geolocation: {
        watchPosition: (success: (position: unknown) => void) => {
          success({
            coords: { latitude: 59.33, longitude: 18.06, accuracy: 5 },
            timestamp: Date.now(),
          });
          return 1;
        },
        clearWatch: () => undefined,
      },
      // No `wakeLock` at all — desktop Firefox, or an insecure context.
    });

    const recorder = createWebTrackRecorder();
    await recorder.start();

    expect((await recorder.stop()).points).toHaveLength(1);
  });

  it("does not fail a recording when the wake lock request is denied", async () => {
    installNavigator({
      geolocation: {
        watchPosition: () => 1,
        clearWatch: () => undefined,
      },
      wakeLock: { request: () => Promise.reject(new Error("denied")) },
    });

    const recorder = createWebTrackRecorder();
    await expect(recorder.start()).resolves.toBeUndefined();
    await expect(recorder.stop()).resolves.toBeDefined();
  });

  it("surfaces a missing geolocation as unsupported rather than throwing", async () => {
    installNavigator({});

    const recorder = createWebTrackRecorder();
    const kinds: string[] = [];
    recorder.onError((error) => kinds.push(error.kind));

    await recorder.start();
    expect(kinds).toEqual(["unsupported"]);
  });

  it("exposes a browser environment with every member the recorder uses", () => {
    installNavigator({ geolocation: { watchPosition: () => 1, clearWatch: () => undefined } });

    const environment = createBrowserEnvironment();
    expect(typeof environment.now()).toBe("number");
    expect(typeof environment.watchPosition).toBe("function");
    expect(typeof environment.clearWatch).toBe("function");
    expect(typeof environment.requestWakeLock).toBe("function");
    expect(typeof environment.setInterval).toBe("function");
    expect(typeof environment.clearInterval).toBe("function");
  });

  it("drives real timers through the environment", async () => {
    installNavigator({});
    const environment = createBrowserEnvironment();

    let ticks = 0;
    const handle = environment.setInterval(() => {
      ticks += 1;
    }, 5);
    await new Promise((resolve) => setTimeout(resolve, 40));
    environment.clearInterval(handle);

    const settled = ticks;
    expect(settled).toBeGreaterThan(0);

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(ticks).toBe(settled);
  });
});

describe("the package barrel", () => {
  it("does not export the injected environment", async () => {
    // T3.1 and api.md keep it off the public contract; exporting it here would make its
    // shape package API to maintain forever.
    const barrel: Record<string, unknown> = await import("./index.js");
    expect(Object.keys(barrel).sort()).toEqual([
      "ChannelConflictError",
      "DEFAULT_AUTOSAVE_MS",
      "PACKAGE_NAME",
      "RecorderResumeError",
      "createWebTrackRecorder",
    ]);
  });
});
