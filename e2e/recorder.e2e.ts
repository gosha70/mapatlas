// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";

/**
 * The recorder against a real browser.
 *
 * Every behavioural rule is already covered deterministically through the injected
 * environment. What only a browser can show is that the default wiring reaches the actual
 * platform: a real `navigator.geolocation` watch delivering real `GeolocationPosition`
 * objects, a real Screen Wake Lock request, and a real IndexedDB round trip. None of that
 * is exercised by a fake, and all of it is what breaks silently on a platform change.
 */

test.use({
  permissions: ["geolocation"],
  geolocation: { latitude: 59.33, longitude: 18.06, accuracy: 5 },
});

test("records from the real geolocation API", async ({ page, context }) => {
  await page.goto("/");

  const started = page.evaluate(async () => {
    const recorder = window.mapatlas.createWebTrackRecorder({ sampling: { minDistanceM: 1 } });
    const seen: number[] = [];
    recorder.onPoint((point) => seen.push(point.lat));
    await recorder.start();

    // Resolve once the browser has delivered two real fixes.
    await new Promise<void>((resolve) => {
      const check = (): void => {
        if (seen.length >= 2) resolve();
        else setTimeout(check, 50);
      };
      check();
    });

    const track = await recorder.stop();
    return {
      points: track.points.length,
      status: track.status,
      origin: track.origin,
      distanceM: track.stats?.distanceM ?? 0,
      firstLat: track.points[0]?.lat ?? 0,
      hasTimestamps: track.points.every((point) => Number.isFinite(point.t)),
    };
  });

  // Move the device: a second real fix, from the platform rather than from the test's hand.
  await page.waitForTimeout(200);
  await context.setGeolocation({ latitude: 59.34, longitude: 18.07, accuracy: 5 });

  const result = await started;

  expect(result.points).toBeGreaterThanOrEqual(2);
  expect(result.status).toBe("finalized");
  expect(result.origin).toBe("recorded");
  expect(result.hasTimestamps).toBe(true);
  expect(result.firstLat).toBeCloseTo(59.33, 2);
  expect(result.distanceM).toBeGreaterThan(0);
});

test("surfaces a denied geolocation permission as a recorder error", async ({ page, context }) => {
  await context.clearPermissions();
  await page.goto("/");

  const kinds = await page.evaluate(async () => {
    const recorder = window.mapatlas.createWebTrackRecorder();
    const seen: string[] = [];
    recorder.onError((error) => seen.push(error.kind));
    await recorder.start();

    await new Promise((resolve) => setTimeout(resolve, 1500));
    return seen;
  });

  expect(kinds).toContain("permission-denied");
});

test("autosaves to real IndexedDB and recovers what a crash would have left", async ({ page }) => {
  await page.goto("/");

  const recovered = await page.evaluate(async () => {
    const store = window.mapatlas.createIdbStorageAdapter({
      databaseName: `e2e-${String(Date.now())}`,
    });
    const recorder = window.mapatlas.createWebTrackRecorder({
      store,
      autosaveMs: 50,
      sampling: { minDistanceM: 1 },
    });

    await recorder.start();
    await new Promise((resolve) => setTimeout(resolve, 400));
    // No stop(): the tab "dies" here, exactly as a crash would leave it.

    const snapshot = await window.mapatlas.recoverInterruptedTrack(store);
    return {
      found: snapshot !== undefined,
      status: snapshot?.status ?? null,
      // Derived data is deliberately absent from a snapshot.
      hasStats: snapshot?.stats !== undefined,
      hasSimplified: snapshot?.simplifiedSegments !== undefined,
    };
  });

  expect(recovered.found).toBe(true);
  expect(recovered.status).toBe("recording");
  expect(recovered.hasStats).toBe(false);
  expect(recovered.hasSimplified).toBe(false);
});

test("uses the real Screen Wake Lock API, and copes when it refuses", async ({ page }) => {
  await page.goto("/");

  const observed = await page.evaluate(async () => {
    // Watch the real API rather than asserting on our own abstraction over it.
    const wakeLock = (navigator as Navigator & { wakeLock?: { request: unknown } }).wakeLock;
    if (wakeLock === undefined) return { supported: false, requested: 0, granted: 0, released: 0 };

    let requested = 0;
    let granted = 0;
    let released = 0;
    const original = wakeLock.request as (type: string) => Promise<{ release(): Promise<void> }>;
    (wakeLock as { request: unknown }).request = async (type: string) => {
      requested += 1;
      const sentinel = await original.call(wakeLock, type);
      granted += 1;
      const originalRelease = sentinel.release.bind(sentinel);
      sentinel.release = async () => {
        released += 1;
        await originalRelease();
      };
      return sentinel;
    };

    const recorder = window.mapatlas.createWebTrackRecorder();
    await recorder.start();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const track = await recorder.stop();
    await new Promise((resolve) => setTimeout(resolve, 100));

    return { supported: true, requested, granted, released, finalized: track.status };
  });

  test.skip(!observed.supported, "no Screen Wake Lock in this browser");

  // The request is always attempted through the real API.
  expect(observed.requested).toBe(1);

  // Headless Chromium refuses it — the document is never visible — and that is exactly the
  // case a recording must survive. Whichever way it goes, a granted lock is released and
  // the recording finishes either way.
  expect(observed.released).toBe(observed.granted);
  expect(observed.finalized).toBe("finalized");
});
