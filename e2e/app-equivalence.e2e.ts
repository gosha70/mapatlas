// SPDX-License-Identifier: Apache-2.0
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

import { readFile } from "node:fs/promises";

import { consoleFor, watchConsole } from "./fixtures/browser.js";
import {
  HOME,
  composeEvent,
  distanceKm,
  drawThreeVertices,
  openDemo,
  pinOnMap,
  recordTwoFixes,
} from "./fixtures/demo-flow.js";
import { structuralDifference } from "./fixtures/structure.js";

/**
 * A hand-drawn trip is the same kind of thing as a recorded one (T7.1b increment 3).
 *
 * **The claim, and what it is not.** `PRD.md` §6 says a drawn trip is *"byte-for-byte the same
 * shape as a recorded one: same review, same stats, same export"*. Read as value equality that is
 * unsatisfiable: two independently produced trips differ in ids, coordinates, timestamps and
 * `trackId` references, all legitimately, and a test chasing it gets whittled field by field into
 * a spot-check of whatever survived. What ADR-0014 actually contracts is *"review, stats, export,
 * offline, and presentation work on an authored track with no special cases — the only difference
 * is one enum field"*. So this file makes **two separate assertions**: the two documents have the
 * same shape, and `origin` differs by value, named on both sides.
 *
 * **The pair is two independently produced trips, in one run.** Building the drawn one *from* the
 * recorded track would relabel `origin` (`packages/core/src/draft.test.ts:810`) and leave one
 * object wearing two labels, which proves nothing about authoring.
 *
 * **What is declared, and therefore not claimed.** A recorded point carries what the platform's
 * geolocation supplied and an authored point cannot carry any of it. Those fields are named in
 * `GPS_ONLY` below, **before** the comparison, and every path named there is a path this file
 * asserts nothing about — not their values, not their presence, not their type. Everything else
 * in both documents is compared.
 */

test.use({
  viewport: { width: 1280, height: 720 },
  deviceScaleFactor: 1,
  permissions: ["geolocation"],
  geolocation: HOME,
});

// Two trips, two reviews, two exports and a reload: longer than the default budget by design.
test.setTimeout(120_000);

/**
 * The fields only a GPS fix can supply, declared by name.
 *
 * `TrackPoint` publishes `accuracyM`, `altitudeM`, `altitudeAccuracyM`, `speedMps` and
 * `headingDeg`, all optional; `useTrackDraft.append` writes a bare `{lat, lng}` and the timing
 * step adds `t`. A recorder supplies whatever the platform gave it — under Playwright's injected
 * geolocation that is `accuracyM` — so this is a **structural** difference, present against
 * absent, and one that no amount of care in the demo could remove.
 *
 * **Three spellings, because the same points are held in three places.** `Track.points` is the
 * source of truth; `Track.simplifiedSegments` is the Douglas–Peucker render cache holding
 * `TrackPoint`s of its own (ADR-0018); and the exported document carries the fields under
 * `features[].properties`. The third of these was found by the comparison rather than by reading
 * the type — the first run reported `simplifiedSegments[][].accuracyM`, which is the rule being
 * *stated* instead of discovered later as a puzzling red. Nothing else is declared.
 */
const GPS_FIELDS = ["accuracyM", "altitudeM", "altitudeAccuracyM", "speedMps", "headingDeg"];
const GPS_ONLY = [
  ...GPS_FIELDS.map((field) => `points[].${field}`),
  ...GPS_FIELDS.map((field) => `simplifiedSegments[][].${field}`),
  ...GPS_FIELDS.map((field) => `features[].properties.${field}`),
];

/** The stored tracks and events, read back through the demo's own storage factory. */
const PROBE = `
import { createDemoStorage } from "/src/app/storage.js";

const storage = createDemoStorage();
const tracks = [];
for (const summary of await storage.trips.listTrackSummaries()) {
  tracks.push(await storage.trips.getTrack(summary.id));
}
const events = {};
for (const track of tracks) {
  events[track.id] = await storage.trips.listEvents(track.id);
}
window.__demoTrips = { tracks, events };
`;

interface StoredTrip {
  readonly id: string;
  readonly origin: string;
  readonly [key: string]: unknown;
}
interface Stored {
  readonly tracks: StoredTrip[];
  readonly events: Record<string, unknown[]>;
}

async function readStored(page: Page): Promise<Stored> {
  await page.addScriptTag({ type: "module", content: PROBE });
  await page.waitForFunction(() => "__demoTrips" in window);
  return page.evaluate(() => (window as unknown as { __demoTrips: Stored }).__demoTrips);
}

/** The stats panel as it is *rendered*: the label of every row, in order. */
async function statLabels(page: Page): Promise<string[]> {
  const panel = page.locator(".mapatlas-trip-stats");
  await expect(panel, "the review rendered no stats panel at all").toBeVisible();
  return panel.locator("dt").allTextContents();
}

/** Open a listed trip by provenance and read what its review renders. */
async function reviewOf(page: Page, origin: string): Promise<{ labels: string[]; km: number }> {
  const row = page.locator(`.trip-open[data-origin="${origin}"]`);
  await expect(row, `no ${origin} trip in the list`).toHaveCount(1);
  await row.click();
  await expect(page.locator("#app-review")).toBeVisible();
  return { labels: await statLabels(page), km: await distanceKm(page) };
}

/** Export the trip currently under review, and parse what the browser saved. */
async function exportOf(page: Page): Promise<unknown> {
  const saving = page.waitForEvent("download");
  await page.locator("#export-geojson").click();
  const saved = await (await saving).path();
  if (saved === null) throw new Error("the browser saved no file");
  return JSON.parse(await readFile(saved, "utf8"));
}

test("a drawn trip and a recorded one differ in provenance and in nothing structural", async ({
  page,
}) => {
  watchConsole(page);
  await openDemo(page);

  // ── One trip from the recorder, with an event and a photo.
  await recordTwoFixes(page);
  await pinOnMap(page);
  await expect(page.locator("#app-composer")).toBeVisible();
  await composeEvent(page, "seen while walking");
  await expect(page.locator("#recorder-status")).toHaveAttribute("data-events", "1");
  await page.locator("#record-stop").click();
  await expect(page.locator("#app-review")).toBeVisible();

  // ── One trip drawn by hand, with an event and a photo. Independently produced: nothing here
  // seeds the draft from the track above.
  await page.locator("#author-start").click();
  await drawThreeVertices(page);
  await page.locator("#author-times").click();
  await page.locator("#author-pin").click();
  await pinOnMap(page, "#authoring-map");
  await expect(page.locator("#authoring-composer")).toBeVisible();
  await composeEvent(page, "drawn by hand");
  await page.locator("#author-save").click();
  await expect(page.locator("#app-review")).toBeVisible();

  // A fresh document, so both trips are read back from the store on equal terms rather than one
  // of them being whatever React was still holding.
  await page.reload();
  await expect(page.locator("#shell-status")).toHaveAttribute("data-status", "ready");

  const stored = await readStored(page);
  const recorded = stored.tracks.find((track) => track.origin === "recorded");
  const authored = stored.tracks.find((track) => track.origin === "authored");

  // ── The provenance assertion, by value and on **both** sides. Asserting one and assuming the
  // other is half a test: `TrackOrigin` is `"recorded" | "authored" | "imported"`.
  expect(recorded, "no recorded trip was stored").toBeDefined();
  expect(authored, "no authored trip was stored").toBeDefined();
  expect(recorded?.origin).toBe("recorded");
  expect(authored?.origin).toBe("authored");

  // ── The structural assertion, over the review's inputs: the track…
  expect(
    structuralDifference(recorded, authored, { optional: GPS_ONLY }),
    "the two tracks are not the same shape",
  ).toStrictEqual([]);

  // …and the events hung off it, which `TripReview` is handed alongside the track.
  const recordedEvents = stored.events[recorded?.id ?? ""];
  const authoredEvents = stored.events[authored?.id ?? ""];
  expect(recordedEvents, "the recorded trip carries no event to compare").toHaveLength(1);
  expect(authoredEvents, "the authored trip carries no event to compare").toHaveLength(1);
  expect(
    structuralDifference(recordedEvents, authoredEvents, { optional: GPS_ONLY }),
    "the two events are not the same shape",
  ).toStrictEqual([]);

  // ── The stats panel, compared as rendered.
  //
  // **Said plainly: the label set alone is weak, and so is the panel's presence.** `TripReview`
  // computes `stats` with `computeStats(props.track)` and renders `StatsPanel` unconditionally —
  // `Track.stats` is never consulted — so a panel appears for any track at all, and its three
  // rows are fixed. Two label lists therefore agree whenever both reviews rendered.
  //
  // What carries the stats clause is the distance on **both** sides: that each trip went through
  // the same `computeStats` path and came out with geometry that survived. A track whose points
  // did not reach the store reviews at `0.00 km` beside an identical set of labels.
  const recordedReview = await reviewOf(page, "recorded");
  const recordedExport = await exportOf(page);
  const authoredReview = await reviewOf(page, "authored");
  const authoredExport = await exportOf(page);

  expect(authoredReview.labels).toStrictEqual(recordedReview.labels);
  expect(recordedReview.km, "the recorded trip reviewed as a zero-length track").toBeGreaterThan(0);
  expect(authoredReview.km, "the authored trip reviewed as a zero-length track").toBeGreaterThan(0);

  // ── The structural assertion, over the exported documents.
  expect(
    structuralDifference(recordedExport, authoredExport, { optional: GPS_ONLY }),
    "the two exported documents are not the same shape",
  ).toStrictEqual([]);

  expect(consoleFor(page).problems()).toStrictEqual([]);
});
