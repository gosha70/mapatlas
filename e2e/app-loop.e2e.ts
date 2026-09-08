// SPDX-License-Identifier: Apache-2.0
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

import { readFile } from "node:fs/promises";

import { geoJSONToTrack } from "@mapatlas/core";

import { consoleFor, fixturePng, watchConsole } from "./fixtures/browser.js";

/**
 * The demo's record → pin → photo → review loop (T7.1 increment 2), in a real browser.
 *
 * **Why this file exists at all.** `loop.test.tsx` doubles every published binding, because a
 * real MapLibre map and a real IndexedDB log do not exist in happy-dom. That lane can prove the
 * *wiring* — which prop reaches which component carrying which value — and it does, one step at
 * a time. It cannot prove the last clause of the acceptance criterion: that the review **renders**
 * what was recorded. A doubled `TripReview` renders whatever it is told to.
 *
 * **The trap this file is written against**, named in the plan: "the demo renders, therefore the
 * loop works". A screenshot of a map with a track on it is satisfied by `/lab`, which has existed
 * since T4.6 and discharges none of T7.1. So each step below is observed by something only that
 * step can produce — a recorder state the page reports, a composer that opened where the tap
 * landed, a preview that decoded the chosen bytes, and a photo visible *in the review* after the
 * trip was finalized.
 *
 * The last scenario carries the criterion's other clause — **persists across reload**. It is here
 * rather than in a file of its own because it needs this file's whole flow: what has to survive a
 * reload is a *finalized track with an event carrying a photo*, and nothing shorter produces one.
 */

test.use({
  viewport: { width: 1280, height: 720 },
  deviceScaleFactor: 1,
  permissions: ["geolocation"],
  // Inside DEMO_REGION, so the live mark lands on ground the archives actually cover. A fix over
  // open ocean records identically and renders nothing, which is the failure mode this whole
  // increment's camera work existed to stop.
  geolocation: { latitude: 45.84, longitude: 6.865, accuracy: 5 },
});

const DEMO = "http://127.0.0.1:5175";
const ARCHIVES = "http://127.0.0.1:5176";

const withArchives =
  `${DEMO}/?terrain=${encodeURIComponent(`${ARCHIVES}/terrain.pmtiles`)}` +
  `&contours=${encodeURIComponent(`${ARCHIVES}/contours.pmtiles`)}`;

const PHOTO = {
  name: "field-shot.jpg",
  mimeType: "image/jpeg",
  // A real, decodable PNG. A signature followed by arbitrary bytes round-trips through storage
  // perfectly and renders as a zero-sized broken image — which would fail the review assertion
  // below on a fixture defect rather than on the app.
  buffer: fixturePng(),
};

/** Record two distinct fixes. The default policy keeps a fix only after 10 m, so the moves are
 *  far larger than that: a track that kept one point is not a trip. */
async function recordTwoFixes(page: Page): Promise<void> {
  await page.locator("#record-start").click();
  await expect(page.locator("#recorder-status")).toHaveAttribute("data-status", "recording");

  for (const fix of [
    { latitude: 45.842, longitude: 6.867, accuracy: 5 },
    { latitude: 45.845, longitude: 6.87, accuracy: 5 },
  ]) {
    await page.context().setGeolocation(fix);
    await page.waitForTimeout(250);
  }
}

/** Drop a pin by tapping the map, the way a person does — not by calling a handler. */
async function pinOnMap(page: Page): Promise<void> {
  const box = await page.locator("#app-map canvas").boundingBox();
  if (box === null) throw new Error("the map drew no canvas to tap");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.locator("#app-composer")).toBeVisible();
}

/** The review's own reported distance, in km, read out of the stats panel. */
async function distanceKm(page: Page): Promise<number> {
  const stats = page.locator(".mapatlas-trip-stats");
  await expect(stats).toBeVisible();
  const text = (await stats.textContent()) ?? "";
  const found = /Distance\s*([\d.]+)\s*km/.exec(text);
  if (found?.[1] === undefined) throw new Error(`no distance in the stats panel: ${text}`);
  return Number(found[1]);
}

test("a recorded trip carries an event with a photo, and the review renders it", async ({
  page,
}) => {
  watchConsole(page);
  await page.goto(withArchives);
  await expect(page.locator("#shell-status")).toHaveAttribute("data-status", "ready");

  await recordTwoFixes(page);
  await pinOnMap(page);

  // The photo goes in through the capture affordance, never `setInputFiles` on the element:
  // writing the input's files directly would pass even if the button were wired to nothing.
  const chooser = page.waitForEvent("filechooser");
  await page.locator(".mapatlas-composer-photo").click();
  await (await chooser).setFiles(PHOTO);
  // The preview proves the bytes decoded, not merely that a file was selected.
  await expect(page.locator(".mapatlas-composer-preview")).toBeVisible();

  await page.locator(".mapatlas-composer-save").click();
  await expect(page.locator("#app-composer")).toHaveCount(0);
  await expect(page.locator("#recorder-status")).toHaveAttribute("data-events", "1");

  await page.locator("#record-stop").click();

  // **The claim.** Not "a review appeared" — a review of a trip with no events renders happily.
  // The image is resolved from the `blobKey` the composer wrote, through the store the app
  // handed `TripReview` (ADR-0028), so a visible photo here means the whole chain held: capture
  // → blob → event → bind to the finalized track → look up → paint.
  const review = page.locator("#app-review");
  await expect(review).toBeVisible();
  await expect(page.locator("#app-map")).toHaveCount(0);
  await expect(review.locator("img").first()).toBeVisible();

  expect(consoleFor(page).problems()).toStrictEqual([]);
});

test("the review is of the trip that was recorded, not an empty one", async ({ page }) => {
  // Separated deliberately: the test above would pass on a track with no points, because a photo
  // in a review says nothing about whether any fix was ever kept. This is the recording half.
  await page.goto(withArchives);
  await expect(page.locator("#shell-status")).toHaveAttribute("data-status", "ready");

  await recordTwoFixes(page);
  await page.locator("#record-stop").click();

  await expect(page.locator("#app-review")).toBeVisible();
  await expect(page.locator("#recorder-status")).toHaveAttribute("data-status", "finalized");

  // **What the first version of this assertion got wrong, kept because the trap is the one the
  // plan names.** It read `#app-review canvas` as evidence of a multi-point track. `TripReview`
  // renders its map for an empty track too, so a run that recorded nothing showed that canvas and
  // passed, reporting `Distance 0.00 km` beside it. A canvas proves a component mounted, never
  // that a fix was kept.
  //
  // Distance is computed from the retained points, so it is zero for a track of nought or one
  // and cannot be produced by anything but a recording that kept both fixes.
  expect(await distanceKm(page)).toBeGreaterThan(0);
});

test("the exported file parses, and round-trips the trip that produced it", async ({ page }) => {
  // **The criterion, observed where it is real.** The unit lane proves `buildTripExport` produces
  // a document that round-trips; it cannot prove the browser was ever handed one. This drives the
  // actual control, takes the actual file the browser saved, and reads it back through the
  // published importer — the same function a consumer would use on the far side.
  await page.goto(withArchives);
  await expect(page.locator("#shell-status")).toHaveAttribute("data-status", "ready");

  await recordTwoFixes(page);
  await pinOnMap(page);
  const chooser = page.waitForEvent("filechooser");
  await page.locator(".mapatlas-composer-photo").click();
  await (await chooser).setFiles(PHOTO);
  await expect(page.locator(".mapatlas-composer-preview")).toBeVisible();
  await page.locator(".mapatlas-composer-save").click();
  await expect(page.locator("#recorder-status")).toHaveAttribute("data-events", "1");

  await page.locator("#record-stop").click();
  await expect(page.locator("#app-review")).toBeVisible();

  const saving = page.waitForEvent("download");
  await page.locator("#export-geojson").click();
  const download = await saving;

  expect(download.suggestedFilename()).toMatch(/^trip-.*\.geojson$/);
  const saved = await download.path();
  if (saved === null) throw new Error("the browser saved no file");
  const text = await readFile(saved, "utf8");

  // Parses — the first half of the observable, and the half a component test cannot make.
  const parsed: unknown = JSON.parse(text);
  expect((parsed as { type: string }).type).toBe("FeatureCollection");

  // Round-trips — the second half, through the published importer rather than a local reader.
  const back = geoJSONToTrack({ geojson: parsed as never, media: [] });

  expect(back.track.points.length, "the exported trip kept no fixes").toBeGreaterThanOrEqual(2);
  expect(back.track.origin).toBe("recorded");
  expect(back.events).toHaveLength(1);
  // The photo travels by reference: a key into the store, and no bytes in the file.
  expect(back.events[0]?.media[0]?.blobKey).toBeDefined();
  expect(text, "the photo bytes were inlined").not.toContain("base64");
});

/**
 * What the demo's own stores hold, read through the demo's own factory.
 *
 * **Not a hand-written database name.** `createDemoStorage()` is exactly what `app.tsx` calls, so
 * this reads whatever the app writes to — if the demo changed adapters or names tomorrow, this
 * probe would follow it rather than silently reading a database nobody uses any more. It opens a
 * second connection to the same databases, which IndexedDB permits and which is read-only here.
 *
 * Injected as a module rather than run through `page.evaluate`, because the specifier has to be
 * resolved by the dev server the app is served from, not by this file's compiler.
 */
const PROBE = `
import { createDemoStorage } from "/src/app/storage.js";

const storage = createDemoStorage();

const tracks = [];
for (const summary of await storage.trips.listTrackSummaries()) {
  const track = await storage.trips.getTrack(summary.id);
  tracks.push({ id: summary.id, points: track === undefined ? -1 : track.points.length });
}

const events = [];
for (const event of await storage.trips.listEvents()) {
  events.push({
    id: event.id,
    trackId: event.trackId,
    blobKeys: event.media.map((item) => item.blobKey).filter((key) => key !== undefined),
  });
}

const blobs = [];
for (const key of events.flatMap((event) => event.blobKeys)) {
  const blob = await storage.trips.getBlob(key);
  blobs.push(blob === undefined ? null : [...new Uint8Array(await blob.arrayBuffer())]);
}

window.__demoPersisted = { tracks, events, blobs };
`;

interface Persisted {
  readonly tracks: { id: string; points: number }[];
  readonly events: { id: string; trackId?: string; blobKeys: string[] }[];
  /** The bytes behind each `blobKey`, in order; `null` where the key resolved to nothing. */
  readonly blobs: (number[] | null)[];
}

async function readPersisted(page: Page): Promise<Persisted> {
  await page.addScriptTag({ type: "module", content: PROBE });
  await page.waitForFunction(() => "__demoPersisted" in window);
  return page.evaluate(() => (window as unknown as { __demoPersisted: Persisted }).__demoPersisted);
}

test("a finalized trip, its event and its photo survive a real reload", async ({ page }) => {
  /**
   * **The acceptance criterion's "persists across reload", observed on the demo's own state.**
   *
   * `e2e/recorder.e2e.ts` already carries a real reload — it recovers an interrupted recording and
   * goes on recording into it — but that is the *recorder's* autosave, over the harness route. It
   * says nothing about whether a trip this app finalized, with the event and photo hung off it, is
   * still there in a new document. Those are separate claims: one is crash recovery, the other is
   * that what the loop wrote is durable.
   *
   * **No UI is asserted, deliberately.** The demo has no trip list and no reopen affordance — that
   * surface is T7.1b's — so the claim is made against storage rather than against a screen the
   * task does not own. Reading through `createDemoStorage()` keeps it the app's storage and not a
   * database this test happens to know the name of.
   */
  watchConsole(page);
  await page.goto(withArchives);
  await expect(page.locator("#shell-status")).toHaveAttribute("data-status", "ready");

  // **The probe reports absence before it reports presence.** Otherwise a probe that answered with
  // a fixed shape, or that read some other origin's data, would satisfy every assertion below and
  // the reload would be doing none of the work.
  const empty = await readPersisted(page);
  expect(empty.tracks).toStrictEqual([]);
  expect(empty.events).toStrictEqual([]);

  await recordTwoFixes(page);
  await pinOnMap(page);
  const chooser = page.waitForEvent("filechooser");
  await page.locator(".mapatlas-composer-photo").click();
  await (await chooser).setFiles(PHOTO);
  await expect(page.locator(".mapatlas-composer-preview")).toBeVisible();
  await page.locator(".mapatlas-composer-save").click();
  await expect(page.locator("#recorder-status")).toHaveAttribute("data-events", "1");

  await page.locator("#record-stop").click();
  await expect(page.locator("#app-review")).toBeVisible();

  const before = await readPersisted(page);
  expect(before.tracks).toHaveLength(1);

  // A genuinely new document: the realm, the React tree and both database connections are gone,
  // so nothing below can be answered from anything the previous document was still holding.
  await page.reload();
  await expect(page.locator("#shell-status")).toHaveAttribute("data-status", "ready");

  const after = await readPersisted(page);

  // The finalized track, and **the same one** — not merely "a track exists", which the reloaded
  // app could have created by itself.
  expect(after.tracks.map((track) => track.id)).toStrictEqual(
    before.tracks.map((track) => track.id),
  );
  expect(
    after.tracks[0]?.points,
    "the track survived as an id with no geometry behind it",
  ).toBeGreaterThan(1);

  // Its event, still bound to it. The binding is what `loop.tsx` writes at finalize, and an event
  // that survived unbound would be unreachable from the trip for ever (ADR-0026).
  expect(after.events).toHaveLength(1);
  expect(after.events[0]?.trackId).toBe(after.tracks[0]?.id);
  expect(after.events[0]?.blobKeys).toHaveLength(1);

  // And the `blobKey` still resolves — to the bytes the picker was handed, not merely to
  // something. A key that resolved to an empty or different blob is a photo that did not survive.
  expect(after.blobs[0]).toStrictEqual([...PHOTO.buffer]);

  expect(consoleFor(page).problems()).toStrictEqual([]);
});
