// SPDX-License-Identifier: Apache-2.0
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

import { DEFAULT_DATABASE_NAME, STORE } from "@mapatlas/storage-idb";

import { consoleFor, fixturePng, watchConsole } from "./fixtures/browser.js";
import { countColour } from "./fixtures/pixels.js";
import { settleRender } from "./fixtures/rendered.js";

/**
 * The packed engine in a **Next 14 App Router project on React 18**, in a real browser (ADR-0043).
 *
 * `@mapatlas/react` declares `react: ">=18"` and every other lane runs React 19 under Vite. This
 * runs the complete foreground loop where the first real consumer lives — webpack, server
 * rendering then hydration, React 18 — built by `scripts/serve-next-consumer.mjs` from tarballs
 * packed from this checkout, whose commit it records.
 *
 * **Each step on its own evidence**, the quick start's rule: a review that appears proves little,
 * so the pause is proved by a position recorded nowhere, recovery by one track id surviving a
 * reload, the photo by bytes that decode in the review, and the build by a console with nothing
 * in it — which in a production React 18 bundle is also where a hydration mismatch would surface.
 */

const CONSUMER = "http://127.0.0.1:5179";

/** The water fill only the fixture's own basemap layer paints (see `trip-loop.tsx`). */
const WATER_FILL: readonly [number, number, number] = [0x0f, 0x8a, 0x7a];

const HOME = { latitude: 45.84, longitude: 6.865, accuracy: 5 };

/** Far enough apart that the default 10 m sampling keeps every one of them. */
const BEFORE_PAUSE = [
  { latitude: 45.842, longitude: 6.867, accuracy: 5 },
  { latitude: 45.845, longitude: 6.87, accuracy: 5 },
];
/**
 * Where the device goes while recording is paused. The first is the discriminating one: it is
 * well over 10 m from the last kept fix, so a recorder that kept watching during the pause would
 * keep it. The second is where the device is when recording resumes, so it may be kept as the
 * new segment's first point — which is correct, and is why only the first is asserted absent.
 */
const WHILE_PAUSED = [
  { latitude: 45.848, longitude: 6.873, accuracy: 5 },
  { latitude: 45.85, longitude: 6.876, accuracy: 5 },
];
const AFTER_RESUME = [
  { latitude: 45.853, longitude: 6.879, accuracy: 5 },
  { latitude: 45.856, longitude: 6.882, accuracy: 5 },
];
const AFTER_RECOVERY = [
  { latitude: 45.859, longitude: 6.885, accuracy: 5 },
  { latitude: 45.862, longitude: 6.888, accuracy: 5 },
];

const PHOTO = { name: "field-shot.png", mimeType: "image/png", buffer: fixturePng() };

test.use({
  viewport: { width: 1280, height: 720 },
  deviceScaleFactor: 1,
  permissions: ["geolocation"],
  geolocation: HOME,
});

async function moveThrough(page: Page, fixes: readonly (typeof HOME)[]): Promise<void> {
  for (const fix of fixes) {
    await page.context().setGeolocation(fix);
    await page.waitForTimeout(250);
  }
}

interface StoredTrack {
  readonly id: string;
  readonly status: string;
  readonly segments: number;
  readonly points: readonly { lat: number; lng: number }[];
}
interface StoredEvent {
  readonly id: string;
  readonly trackId?: string | undefined;
  readonly blobKeys: readonly string[];
}

/** The consumer's own IndexedDB, read directly; store names come from the package. */
function readStored(page: Page): Promise<{ tracks: StoredTrack[]; events: StoredEvent[] }> {
  return page.evaluate(
    async ({ database, stores }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(database);
        request.onsuccess = () => {
          resolve(request.result);
        };
        request.onerror = () => {
          reject(new Error(`could not open ${database}`));
        };
      });
      const all = <T>(store: string): Promise<T[]> =>
        new Promise((resolve, reject) => {
          const request = db.transaction(store, "readonly").objectStore(store).getAll();
          request.onsuccess = () => {
            resolve(request.result as T[]);
          };
          request.onerror = () => {
            reject(new Error(`could not read ${store}`));
          };
        });
      const tracks = await all<{
        id: string;
        status: string;
        segments: unknown[];
        points: { lat: number; lng: number }[];
      }>(stores.tracks);
      const events = await all<{ id: string; trackId?: string; media: { blobKey?: string }[] }>(
        stores.events,
      );
      db.close();
      return {
        tracks: tracks.map((t) => ({
          id: t.id,
          status: t.status,
          segments: t.segments.length,
          points: t.points.map((p) => ({ lat: p.lat, lng: p.lng })),
        })),
        events: events.map((e) => ({
          id: e.id,
          trackId: e.trackId,
          blobKeys: e.media.map((m) => m.blobKey).filter((k): k is string => k !== undefined),
        })),
      };
    },
    { database: DEFAULT_DATABASE_NAME, stores: STORE },
  );
}

const near = (p: { lat: number; lng: number }, fix: typeof HOME): boolean =>
  Math.abs(p.lat - fix.latitude) < 1e-6 && Math.abs(p.lng - fix.longitude) < 1e-6;

test("the map draws its basemap under Next's bundler", async ({ page }) => {
  const console_ = watchConsole(page);
  await page.goto(CONSUMER);
  const map = page.locator("#map");
  await settleRender(map);
  // Tile geometry, not a mounted canvas: MapLibre's worker has to load under webpack for this.
  expect(countColour(await map.locator("canvas").screenshot(), WATER_FILL)).toBeGreaterThan(0);
  expect(console_.problems()).toStrictEqual([]);
});

test("a Server Component that imports MapCanvas directly prerenders and hydrates", async ({
  page,
}) => {
  const console_ = watchConsole(page);
  await page.goto(`${CONSUMER}/rsc`);
  await expect(page.locator("h1")).toHaveText("Imported from a Server Component");
  await expect(page.locator("#map canvas")).toBeVisible();
  expect(console_.problems()).toStrictEqual([]);
});

test("record, pause, resume, pin a photo, reload, recover, stop and review", async ({ page }) => {
  // Two waits on the recorder's 10 s autosave are the long pole.
  test.setTimeout(120_000);
  watchConsole(page);
  await page.goto(CONSUMER);
  const status = page.locator("#status");

  // ── record, then pause ────────────────────────────────────────────────────────────────
  await page.locator("#start").click();
  await expect(status).toHaveAttribute("data-status", "recording");
  await moveThrough(page, BEFORE_PAUSE);
  await page.locator("#pause").click();
  await expect(status).toHaveAttribute("data-status", "paused");
  await moveThrough(page, WHILE_PAUSED);

  // ── resume, then pin an event with a photo ────────────────────────────────────────────
  await page.locator("#resume").click();
  await expect(status).toHaveAttribute("data-status", "recording");
  await moveThrough(page, AFTER_RESUME);

  const box = await page.locator("#map canvas").boundingBox();
  if (box === null) throw new Error("the consumer's map drew no canvas to tap");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const chooser = page.waitForEvent("filechooser");
  await page.locator(".mapatlas-composer-photo").click();
  await (await chooser).setFiles(PHOTO);
  await expect(page.locator(".mapatlas-composer-preview")).toBeVisible();
  await page.locator(".mapatlas-composer-comment").fill("before the reload");
  await page.locator(".mapatlas-composer-save").click();
  await expect(status).toHaveAttribute("data-unbound", "1");

  // ── wait for an autosave that holds the last fix, then lose the page ──────────────────
  // Polled from IndexedDB rather than slept: the reload must happen after a real autosave, and
  // the snapshot must already contain the fixes recorded after the resume.
  const last = AFTER_RESUME[AFTER_RESUME.length - 1]!;
  await expect
    .poll(
      async () => {
        const { tracks } = await readStored(page);
        return tracks.some((t) => t.status !== "finalized" && t.points.some((p) => near(p, last)));
      },
      { timeout: 40_000, intervals: [1_000] },
    )
    .toBe(true);
  const before = (await readStored(page)).tracks.find((t) => t.status !== "finalized");
  if (before === undefined) throw new Error("no unfinished track was autosaved");
  expect(before.segments).toBe(2);

  await page.reload();

  // ── the reloaded page offers the unfinished trip, and resumes it ──────────────────────
  const recovered = page.locator("#recovered");
  await expect(recovered).toBeVisible();
  await expect(recovered).toHaveAttribute("data-track-id", before.id);
  // The pinned event survived the reload too, still unbound.
  await expect(status).toHaveAttribute("data-unbound", "1");
  await page.locator("#resume-recovered").click();
  await expect(status).toHaveAttribute("data-status", "recording");
  await expect(recovered).toHaveCount(0);
  await moveThrough(page, AFTER_RECOVERY);

  // ── stop and review ──────────────────────────────────────────────────────────────────
  await page.locator("#stop").click();
  const review = page.locator("#review");
  await expect(review).toBeVisible();
  // One trip across the reload: the review is of the track that was recovered.
  await expect(review).toHaveAttribute("data-track-id", before.id);
  // Pause opened the second segment; resuming after the crash always opens a third.
  await expect(review).toHaveAttribute("data-segments", "3");
  await expect(review).toHaveAttribute("data-events", "1");

  // The photo decodes in the review — resolved through the store from the blob written before
  // the reload, not merely an <img> element with a broken source.
  const image = review.locator("img").first();
  await expect(image).toBeVisible();
  expect(
    await image.evaluate((element) => (element as HTMLImageElement).naturalWidth),
  ).toBeGreaterThan(0);

  // ── and the consumer's own storage agrees ────────────────────────────────────────────
  const stored = await readStored(page);
  expect(stored.tracks).toHaveLength(1);
  const track = stored.tracks[0]!;
  expect(track.id).toBe(before.id);
  expect(track.status).toBe("finalized");
  expect(track.segments).toBe(3);
  for (const fix of [...BEFORE_PAUSE, ...AFTER_RESUME, ...AFTER_RECOVERY]) {
    expect(
      track.points.some((p) => near(p, fix)),
      `kept ${JSON.stringify(fix)}`,
    ).toBe(true);
  }
  // The position visited only while paused was recorded nowhere.
  expect(track.points.some((p) => near(p, WHILE_PAUSED[0]!))).toBe(false);
  expect(stored.events).toHaveLength(1);
  expect(stored.events[0]?.trackId).toBe(track.id);
  expect(stored.events[0]?.blobKeys).toHaveLength(1);

  expect(consoleFor(page).problems()).toStrictEqual([]);
});
