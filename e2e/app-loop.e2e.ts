// SPDX-License-Identifier: Apache-2.0
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

import { readFile } from "node:fs/promises";

import { geoJSONToTrack } from "@mapatlas/core";

import { consoleFor, watchConsole } from "./fixtures/browser.js";
import {
  HOME,
  PHOTO,
  composeEvent,
  distanceKm,
  drawThreeVertices,
  openDemo,
  pinOnMap,
  recordTwoFixes,
} from "./fixtures/demo-flow.js";

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
  geolocation: HOME,
});

test("a recorded trip carries an event with a photo, and the review renders it", async ({
  page,
}) => {
  watchConsole(page);
  await openDemo(page);

  await recordTwoFixes(page);
  await pinOnMap(page);
  await expect(page.locator("#app-composer")).toBeVisible();
  await composeEvent(page, "a note");
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
  await openDemo(page);

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
  await openDemo(page);

  await recordTwoFixes(page);
  await pinOnMap(page);
  await composeEvent(page, "a note");
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

/**
 * The declared channel and its samples, read out of the app's own store.
 *
 * A second probe rather than a widening of the first: that one answers "did the trip, its event
 * and its photo survive a reload", and this one answers "was a channel recorded at all". Sharing
 * one would make each scenario wait on the other's reads.
 */
const CHANNEL_PROBE = `
import { createDemoStorage } from "/src/app/storage.js";

const storage = createDemoStorage();
const [summary] = await storage.trips.listTrackSummaries();
const track = summary === undefined ? undefined : await storage.trips.getTrack(summary.id);
window.__demoChannel = {
  descriptors: (track?.channels ?? []).map((d) => d.key),
  sampled: (track?.points ?? []).filter((p) => p.channels?.cadence !== undefined).length,
  values: (track?.points ?? []).map((p) => p.channels?.cadence),
  points: track?.points.length ?? 0,
};
`;

interface Channels {
  readonly descriptors: string[];
  readonly sampled: number;
  readonly values: (number | undefined)[];
  readonly points: number;
}

async function readChannels(page: Page): Promise<Channels> {
  await page.addScriptTag({ type: "module", content: CHANNEL_PROBE });
  await page.waitForFunction(() => "__demoChannel" in window);
  return page.evaluate(() => (window as unknown as { __demoChannel: Channels }).__demoChannel);
}

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
  await openDemo(page);

  // **The probe reports absence before it reports presence.** Otherwise a probe that answered with
  // a fixed shape, or that read some other origin's data, would satisfy every assertion below and
  // the reload would be doing none of the work.
  const empty = await readPersisted(page);
  expect(empty.tracks).toStrictEqual([]);
  expect(empty.events).toStrictEqual([]);

  await recordTwoFixes(page);
  await pinOnMap(page);
  await composeEvent(page, "a note");
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
  // that survived unbound would be unreachable from the trip for ever — the reason is in that
  // file's header, which is the only place it is recorded.
  expect(after.events).toHaveLength(1);
  expect(after.events[0]?.trackId).toBe(after.tracks[0]?.id);
  expect(after.events[0]?.blobKeys).toHaveLength(1);

  // And the `blobKey` still resolves — to the bytes the picker was handed, not merely to
  // something. A key that resolved to an empty or different blob is a photo that did not survive.
  expect(after.blobs[0]).toStrictEqual([...PHOTO.buffer]);

  expect(consoleFor(page).problems()).toStrictEqual([]);
});

test("a trip recorded here is listed by a later document, and reopens as itself", async ({
  page,
}) => {
  /**
   * **The listing claim, which only this lane can make** (T7.1b increment 1).
   *
   * `trips.test.tsx` renders rows from summaries it was handed, and `loop.test.tsx` proves the
   * rows come from the binding rather than from what this document recorded. Neither can show
   * that a trip *stored by the app* reaches a list drawn by a **new document** — that needs a
   * real reload, and it is the assertion a list built from React state passes right up until the
   * page is refreshed.
   *
   * The reopened trip is identified by its **distance**, read from the review's own stats panel
   * and compared with the distance the same trip reported before the reload. A row appearing is
   * satisfied by any row; a review appearing is satisfied by any review — `TripReview` renders
   * happily for an empty track, which this file has been caught by once already.
   */
  watchConsole(page);
  await openDemo(page);

  // Nothing stored yet, and the list says so rather than saying nothing.
  await expect(page.locator("#trip-list")).toHaveAttribute("data-count", "0");
  await expect(page.locator("#trip-list-empty")).toBeVisible();

  await recordTwoFixes(page);
  await page.locator("#record-stop").click();
  await expect(page.locator("#app-review")).toBeVisible();

  const recordedKm = await distanceKm(page);
  expect(
    recordedKm,
    "the recording kept no distance, so nothing below is attributable",
  ).toBeGreaterThan(0);
  // Listed as soon as it exists — the refresh after finalize, not only on the next load.
  await expect(page.locator("#trip-list")).toHaveAttribute("data-count", "1");

  // A genuinely new document: React state, the recorder and the event log are all gone, and only
  // what reached the store can answer.
  await page.reload();
  await expect(page.locator("#shell-status")).toHaveAttribute("data-status", "ready");

  await expect(page.locator("#trip-list")).toHaveAttribute("data-count", "1");
  const row = page.locator(".trip-open").first();
  await expect(row).toHaveAttribute("data-origin", "recorded");
  await expect(row).toHaveAttribute("data-points", /[2-9]|\d{2,}/);

  await row.click();

  await expect(page.locator("#app-review")).toBeVisible();
  await expect(row).toHaveAttribute("data-open", "true");
  expect(await distanceKm(page), "the reopened trip is not the one that was recorded").toBeCloseTo(
    recordedKm,
    2,
  );

  expect(consoleFor(page).problems()).toStrictEqual([]);
});

test("a hand-drawn trip is saved with its pinned event, and reopens carrying it", async ({
  page,
}) => {
  /**
   * **Draw → set times → pin → save, end to end** (T7.1b increment 2).
   *
   * `authoring.test.tsx` proves the wiring against doubled bindings: a reported vertex reaches the
   * draft, timing gates the save, the event is written unbound and then bound. It cannot prove
   * that a **click on a real MapLibre canvas** produces a vertex at all — draw mode is the
   * renderer's, bound to the map's own `click` — nor that what was saved is still there for a
   * later document to open.
   *
   * So the observable is the **reopened** trip: saved, found again in the list after a reload, and
   * carrying the event in both the review and the exported file. An event that was written but
   * never bound survives in the store and appears in neither — which is the difference between
   * "lost" and "orphaned" that the two mutations keep apart.
   */
  watchConsole(page);
  await openDemo(page);

  await page.locator("#author-start").click();
  await expect(page.locator("#authoring-status")).toHaveAttribute("data-points", "0");

  // Three real clicks on the canvas. Draw mode is wired to MapLibre's own `click`, so this is the
  // interaction a person performs, not a handler called directly.
  await drawThreeVertices(page);

  // Untimed until the step that times them, and unsavable until then — the engine's refusal,
  // surfaced before the button.
  await expect(page.locator("#authoring-status")).toHaveAttribute("data-untimed", "3");
  await expect(page.locator("#authoring-status")).toHaveAttribute("data-savable", "false");
  await page.locator("#author-times").click();
  await expect(page.locator("#authoring-status")).toHaveAttribute("data-untimed", "0");
  await expect(page.locator("#authoring-status")).toHaveAttribute("data-savable", "true");

  // Pin, through the composer, with a photo — the same path the recorded loop takes.
  await page.locator("#author-pin").click();
  await pinOnMap(page, "#authoring-map");
  await expect(page.locator("#authoring-composer")).toBeVisible();
  await composeEvent(page, "drawn by hand");
  await expect(page.locator("#authoring-status")).toHaveAttribute("data-events", "1");

  await page.locator("#author-save").click();
  await expect(page.locator("#app-review")).toBeVisible();

  // A fresh document: the draft, the pending ids and every binding are gone, and only what
  // reached the store can answer.
  await page.reload();
  await expect(page.locator("#shell-status")).toHaveAttribute("data-status", "ready");

  const row = page.locator('.trip-open[data-origin="authored"]');
  await expect(row, "the authored trip is not in the list a new document drew").toHaveCount(1);
  await expect(row).toHaveAttribute("data-points", "3");
  await row.click();

  // **Carrying the event.** The photo in the review is resolved from the `blobKey` through the
  // store, so a visible image means the whole chain held — and it is absent for an event that
  // was written but never bound to this track.
  const review = page.locator("#app-review");
  await expect(review).toBeVisible();
  await expect(review.locator("img").first()).toBeVisible();

  // And in the export, which is the other half of "reviews identically to a recorded one".
  const saving = page.waitForEvent("download");
  await page.locator("#export-geojson").click();
  const saved = await (await saving).path();
  if (saved === null) throw new Error("the browser saved no file");
  const doc = JSON.parse(await readFile(saved, "utf8")) as {
    features: { properties?: Record<string, unknown> }[];
  };
  const events = doc.features.filter((feature) => feature.properties?.["kind"] === "event");
  expect(events, "the exported authored trip carries no event").toHaveLength(1);
  expect(events[0]?.properties?.["comment"]).toBe("drawn by hand");
  // Bound, and bound to *this* trip: an event carrying another trip's id would export from a
  // review of that trip instead, and this assertion is what tells the two apart.
  const track = doc.features.find((feature) => feature.properties?.["kind"] === "track");
  expect(events[0]?.properties?.["trackId"]).toBe(track?.properties?.["id"]);
  expect(track?.properties?.["origin"], "the saved trip was not marked as authored").toBe(
    "authored",
  );

  expect(consoleFor(page).problems()).toStrictEqual([]);
});

test("a recorded trip carries the declared channel, sampled and persisted", async ({ page }) => {
  /**
   * **The channel reached the points, and survived to the store** (T7.1c increment 1).
   *
   * `channel.test.ts` proves the fake instrument's own two properties — deterministic, and a
   * function of nothing else in the document. It cannot show that `useTrackRecorder` accepted the
   * source, started it, merged its samples onto the fixes the policy kept, or that any of it
   * reached IndexedDB: that is a real recorder over a real store, and only this lane has one.
   *
   * **A descriptor is not a sample** (ADR-0029). `chartable()` starts from the descriptors and
   * keeps only those something sampled, so a track that declared the channel and recorded nothing
   * is indistinguishable from one that never declared it — which is why both halves are asserted
   * here, on the stored track rather than on anything rendered.
   */
  watchConsole(page);
  await openDemo(page);

  await recordTwoFixes(page);

  await page.locator("#record-stop").click();
  await expect(page.locator("#app-review")).toBeVisible();

  // A fresh document: the recorder and its source are gone, so only what reached the store answers.
  await page.reload();
  await expect(page.locator("#shell-status")).toHaveAttribute("data-status", "ready");

  const stored = await readPersisted(page);
  expect(stored.tracks, "no trip was stored to look at").toHaveLength(1);

  const channels = await readChannels(page);

  // The descriptor the consumer declared, carried onto the finalized track.
  expect(channels.descriptors, "the declared channel is not on the stored track").toStrictEqual([
    "cadence",
  ]);

  // And samples behind it. Without this the assertion above is satisfied by a source that never
  // started — the exact case ADR-0029 says renders nothing while looking correct.
  expect(
    channels.points,
    "a one-point track cannot show whether every point carries it",
  ).toBeGreaterThan(1);

  /**
   * **At least one kept point carries the key — and that is deliberately all this lane claims.**
   *
   * The pairing that matters is with the descriptor above. `chartable()` starts from the
   * descriptors and keeps only those something sampled (ADR-0029), so a track that declared the
   * channel and recorded nothing renders no chart while looking correct — the descriptor alone is
   * not evidence, and this is the half that makes it one.
   *
   * **Why not "every point", or even "more than one".** Both were tried and both are
   * scheduler-dependent rather than contractual. `channels` is optional (ADR-0009);
   * `createPollingSensorSource.start()` schedules an interval and does not read at zero;
   * `mergeSensorSamples` takes only samples at or before the point; and `recorder.ts:544` *drains*
   * the pending samples at each kept point, so a point carries a value exactly when one arrived in
   * its window. Measured: `unsampled ⊆ {0}` passed in isolation and failed twice in a loaded
   * full-lane run with `[0, 1]`; widening the fixes did not fix it; and at a 25 ms cadence a
   * loaded run kept only **two** geolocation fixes at all, so even the number of points is a
   * function of machine load. A healthy run producing `[null, 78]` is legal, and an assertion that
   * failed on it would make CI scheduling part of the product contract.
   *
   * That the fake source keeps sampling rather than emitting once is a property of the source, and
   * it is owned where it is deterministic: `channel.test.ts` drives the sequence directly.
   */
  expect(
    channels.sampled,
    "the channel was declared but nothing was ever sampled onto a point",
  ).toBeGreaterThan(0);

  // The values are the sequence the demo's source produces, not something the recorder invented:
  // every sampled value is one this channel can emit.
  const emitted = new Set([60, 66, 72, 78, 84, 90, 96]);
  for (const value of channels.values) {
    if (value !== undefined) {
      expect(emitted, `a value the demo's channel never emits: ${String(value)}`).toContain(value);
    }
  }

  expect(consoleFor(page).problems()).toStrictEqual([]);
});
