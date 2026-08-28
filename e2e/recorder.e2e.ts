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
    recorder.onPoint((point) => {
      seen.push(point.lat);
      // Tells the test the browser has actually delivered a fix, so it can move the device
      // rather than guessing how long that takes.
      window.mapatlas.signals["firstPoint"] = true;
    });
    await recorder.start();

    await new Promise<void>((resolve) => {
      const check = (): void => {
        if (seen.length >= 2) resolve();
        else setTimeout(check, 20);
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

  // Move only once the first fix has genuinely arrived. A fixed delay lets a slow runner
  // move first, so both callbacks report the new location and the page waits forever for a
  // second distinct point.
  await page.waitForFunction(() => window.mapatlas.signals["firstPoint"] === true);
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

  await page.evaluate(async () => {
    const recorder = window.mapatlas.createWebTrackRecorder();
    const seen: string[] = [];
    window.mapatlas.result = seen;
    recorder.onError((error) => {
      seen.push(error.kind);
      window.mapatlas.signals["error"] = true;
    });
    await recorder.start();
  });

  // Wait for the browser to refuse, rather than for a duration that might not be enough.
  await page.waitForFunction(() => window.mapatlas.signals["error"] === true);

  const kinds = await page.evaluate(() => window.mapatlas.result as string[]);
  expect(kinds).toContain("permission-denied");
});

test("recovers an interrupted recording across a real page reload", async ({ page }) => {
  await page.goto("/");

  // A name the second document can find. The point of this test is that recovery works
  // through storage rather than through anything the first page left in memory.
  const databaseName = `e2e-crash-${String(Date.now())}`;

  await page.evaluate(async (name) => {
    const inner = window.mapatlas.createIdbStorageAdapter({ databaseName: name });
    // Signal the write itself. Polling IndexedDB from waitForFunction opens a fresh
    // connection every frame, which competes with the very write it is waiting for.
    const store = {
      ...inner,
      saveTrack: async (track: Parameters<typeof inner.saveTrack>[0]) => {
        await inner.saveTrack(track);
        window.mapatlas.signals["saved"] = true;
      },
    };

    const recorder = window.mapatlas.createWebTrackRecorder({
      store,
      autosaveMs: 50,
      sampling: { minDistanceM: 1 },
    });
    await recorder.start();
  }, databaseName);

  // Wait for a snapshot to be genuinely on disk, not for an interval to have plausibly fired.
  await page.waitForFunction(() => window.mapatlas.signals["saved"] === true);

  // The tab dies. No stop(), no close(), no handover — the recorder, its autosave timer and
  // its adapter all go with the document, which is what a crash actually does and what
  // recovering through the same live objects never proved.
  await page.reload();

  const recovered = await page.evaluate(async (name) => {
    const store = window.mapatlas.createIdbStorageAdapter({ databaseName: name });
    const snapshot = await window.mapatlas.recoverInterruptedTrack(store);
    return {
      found: snapshot !== undefined,
      status: snapshot?.status ?? null,
      origin: snapshot?.origin ?? null,
      points: snapshot?.points.length ?? 0,
      // Derived data is deliberately absent from a snapshot.
      hasStats: snapshot?.stats !== undefined,
      hasSimplified: snapshot?.simplifiedSegments !== undefined,
    };
  }, databaseName);

  expect(recovered.found).toBe(true);
  expect(recovered.status).toBe("recording");
  expect(recovered.origin).toBe("recorded");
  expect(recovered.points).toBeGreaterThan(0);
  expect(recovered.hasStats).toBe(false);
  expect(recovered.hasSimplified).toBe(false);
});

test("continues a recovered recording under its original id, in a new document", async ({
  page,
}) => {
  await page.goto("/");
  const databaseName = `e2e-resume-${String(Date.now())}`;

  await page.evaluate(async (name) => {
    const inner = window.mapatlas.createIdbStorageAdapter({ databaseName: name });
    const store = {
      ...inner,
      saveTrack: async (track: Parameters<typeof inner.saveTrack>[0]) => {
        await inner.saveTrack(track);
        window.mapatlas.signals["saved"] = true;
      },
    };

    const recorder = window.mapatlas.createWebTrackRecorder({
      store,
      autosaveMs: 50,
      sampling: { minDistanceM: 1 },
    });
    await recorder.start();
  }, databaseName);

  await page.waitForFunction(() => window.mapatlas.signals["saved"] === true);

  await page.reload();

  const result = await page.evaluate(async (name) => {
    const store = window.mapatlas.createIdbStorageAdapter({ databaseName: name });
    const snapshot = await window.mapatlas.recoverInterruptedTrack(store);
    if (snapshot === undefined) return { resumed: false };

    const recorder = window.mapatlas.createWebTrackRecorder({
      store,
      resumeFrom: snapshot,
      sampling: { minDistanceM: 1 },
    });
    await recorder.start();
    const track = await recorder.stop();

    return {
      resumed: true,
      sameId: track.id === snapshot.id,
      sameStart: track.startedAt === snapshot.startedAt,
      // The crash interval is an unobserved gap: resumption always opens a new segment.
      segments: track.segments.length,
      stored: (await store.listTrackSummaries()).length,
      status: track.status,
    };
  }, databaseName);

  expect(result.resumed).toBe(true);
  expect(result.sameId).toBe(true);
  expect(result.sameStart).toBe(true);
  expect(result.status).toBe("finalized");
  // One record, overwritten — not a second trip.
  expect(result.stored).toBe(1);
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
