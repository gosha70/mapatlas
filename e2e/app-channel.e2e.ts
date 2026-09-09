// SPDX-License-Identifier: Apache-2.0
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

import { readFile } from "node:fs/promises";

import { geoJSONToTrack } from "@mapatlas/core";

import { consoleFor, watchConsole } from "./fixtures/browser.js";
import { HOME, openDemo, recordTwoFixes } from "./fixtures/demo-flow.js";

/**
 * The recorded channel, charted in review (T7.1c increment 2).
 *
 * **What only this lane can see.** `channel.test.ts` owns the source: that it samples repeatedly,
 * deterministically, in order and not constantly. `app-loop.e2e.ts` owns the wiring: that the
 * descriptor and at least one sample reach storage. Neither says anything about a chart, which
 * needs a real `TripReview` over a real track — and the chart is the acceptance criterion's own
 * word.
 */

test.use({
  viewport: { width: 1280, height: 720 },
  deviceScaleFactor: 1,
  permissions: ["geolocation"],
  geolocation: HOME,
});

const CHART = '.mapatlas-trip-chart[data-channel="cadence"]';

/** The polyline geometry the chart drew, per segment. */
const chartLines = (page: Page): Promise<string[]> =>
  page
    .locator(`${CHART} .mapatlas-trip-chart-line`)
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("points") ?? ""));

test("a recorded trip charts its channel in review", async ({ page }) => {
  watchConsole(page);
  await openDemo(page);

  await recordTwoFixes(page);
  await page.locator("#record-stop").click();
  await expect(page.locator("#app-review")).toBeVisible();

  // **The figure, keyed by the descriptor the consumer declared.** Not "a chart appeared": the
  // review renders one figure per chartable channel, and this one has to be the demo's.
  await expect(
    page.locator(CHART),
    "the review drew no chart for the declared channel",
  ).toHaveCount(1);

  // **And geometry inside it.** `chartable()` keeps only descriptors something sampled and the
  // component drops empty polylines, so a figure with no line is what a declared-but-unsampled
  // channel would look like if it got this far — the difference ADR-0029 says is invisible
  // otherwise.
  const lines = await chartLines(page);
  expect(lines.length, "the chart has no line in it").toBeGreaterThan(0);
  for (const points of lines) {
    expect(points, "a chart line was drawn with no points").not.toBe("");
  }

  // The caption is the consumer's words, rendered verbatim (ADR-0009): the engine never derives a
  // label or a unit, so seeing them here is seeing the descriptor reach the surface.
  await expect(page.locator(`${CHART} figcaption`)).toContainText("Cadence");
  await expect(page.locator(`${CHART} svg`)).toHaveAttribute("aria-label", /Cadence over time/);

  expect(consoleFor(page).problems()).toStrictEqual([]);
});

/**
 * A track that declares the channel and carries no sample for it, written directly to the store.
 *
 * **Deliberate, which is the whole point of the control.** The state could be reached by breaking
 * the sensor — but then the fixture and the defect are the same thing, and the test would be
 * asserting that a broken source draws nothing rather than that a *descriptor* is not evidence.
 * Written through `createDemoStorage()`, the same factory `app.tsx` calls, so it is the app's own
 * store and the app's own list that surface it.
 *
 * Two points and one segment: enough for `TripReview` to render a track, so an absent chart cannot
 * be an absent review.
 */
const UNSAMPLED_TRACK = `
import { createDemoStorage } from "/src/app/storage.js";

const storage = createDemoStorage();
await storage.trips.saveTrack({
  id: "declared-not-sampled",
  startedAt: 1_000,
  endedAt: 3_000,
  status: "finalized",
  origin: "recorded",
  channels: [{ key: "cadence", label: "Cadence", unit: "rpm", precision: 0 }],
  points: [
    { lat: 45.84, lng: 6.865, t: 1_000 },
    { lat: 45.842, lng: 6.867, t: 3_000 },
  ],
  segments: [{ startIndex: 0, endIndex: 1 }],
});
window.__unsampledWritten = true;
`;

test("a channel declared with no samples draws no chart, and is not mistaken for one", async ({
  page,
}) => {
  /**
   * **The control that makes the chart above mean something.**
   *
   * ADR-0029 settles that the chartable set comes from the **descriptors** rather than from the
   * keys found in the data, and records the consequence: a declared-but-empty channel is
   * indistinguishable from an undeclared one. So `data-channel` being present in the DOM is not
   * evidence that anything was sampled — which is exactly what the previous test would be
   * asserting if a figure appeared for a track with a descriptor and no values.
   */
  watchConsole(page);
  await openDemo(page);

  await page.addScriptTag({ type: "module", content: UNSAMPLED_TRACK });
  await page.waitForFunction(() => "__unsampledWritten" in window);

  // A fresh document, so the list is read from the store rather than from anything this one holds.
  await openDemo(page);

  const row = page.locator('.trip-open[data-track-id="declared-not-sampled"]');
  await expect(row, "the synthetic trip never reached the list").toHaveCount(1);
  await row.click();

  // The review is there — so an absent chart below is an absent *chart*, not an absent trip.
  await expect(page.locator("#app-review")).toBeVisible();
  await expect(page.locator(".mapatlas-trip-stats")).toBeVisible();

  await expect(
    page.locator(CHART),
    "a channel with no samples was charted, so a chart proves only that a descriptor exists",
  ).toHaveCount(0);

  expect(consoleFor(page).problems()).toStrictEqual([]);
});

/** Delete one trip by id through the app's own store. */
const deleteTrip = (id: string): string => `
import { createDemoStorage } from "/src/app/storage.js";
const storage = createDemoStorage();
await storage.trips.deleteTrack(${JSON.stringify(id)});
window.__tripDeleted = true;
`;

/**
 * Ask the store for a track by id, in a fresh document.
 *
 * **Absence through the seam, not through the list.** An empty list is also what a list that
 * failed to load looks like; `getTrack` answering `undefined` is the store itself saying the track
 * is gone, and it is the same call the app makes to open a row.
 */
const lookUpTrip = (id: string): string => `
import { createDemoStorage } from "/src/app/storage.js";
const storage = createDemoStorage();
const summaries = await storage.trips.listTrackSummaries();
window.__lookedUp = {
  hydrated: (await storage.trips.getTrack(${JSON.stringify(id)})) !== undefined,
  listed: summaries.some((summary) => summary.id === ${JSON.stringify(id)}),
};
`;

/** Write an imported track into the app's store, as a consumer's import button would. */
const importTrack = (track: unknown): string => `
import { createDemoStorage } from "/src/app/storage.js";
const storage = createDemoStorage();
await storage.trips.saveTrack(${JSON.stringify(track)});
window.__trackImported = true;
`;

test("the chart survives an export and a re-import, unchanged", async ({ page }) => {
  /**
   * **The acceptance criterion's second clause, and it is relational** (T7.1c increment 3):
   * *"re-importing reproduces the chart"*. A test asserting that an imported track "has a chart" is
   * satisfied by any chart, and one asserting a hand-written expectation passes while the
   * *pre-export* chart drifts away from it. So the oracle is the rendered `points` attribute of
   * every polyline, before and after — an identity between two renders rather than a resemblance
   * to a constant.
   *
   * **Provenance: the original is deleted before the import, with a reload on each side.**
   * `portability.ts:390` carries `properties.id` through, so an imported track keeps the id it was
   * exported under — it does not acquire a new identity, and it is *not* relabelled `"imported"`,
   * since the importer preserves the document's `origin`. After an overwrite, "the chart came from
   * the imported document" and "the chart came from the original" would be the same row and
   * indistinguishable.
   *
   * So the sequence is: delete → **reload** → prove through `getTrack` that the id is gone →
   * import into that fresh document → **reload again** → let the app rebuild its list from
   * IndexedDB. Two boundaries, because one is not enough: the first removes the reviewing document
   * that drew the original chart, and the second removes the importing document, so the final
   * render is the app hydrating a stored track and nothing else.
   *
   * **The demo exports a bare `FeatureCollection`**, not the `TrackExport` envelope — a decision
   * recorded in `export.ts`, since a media manifest whose blobs are not in the file would resolve
   * to nothing. `geoJSONToTrack` reads `exported.geojson`, so the file is wrapped here exactly as a
   * consumer importing that file would have to wrap it.
   */
  watchConsole(page);
  await openDemo(page);

  /**
   * **Eventless deliberately.** `deleteTrack` also removes the track's events and any blob only
   * they referenced, and the GeoJSON export carries media *references* rather than bytes — so a
   * trip with a photo would turn this into an accidental media-import test, failing or passing for
   * reasons that have nothing to do with channels.
   */
  await recordTwoFixes(page);
  await page.locator("#record-stop").click();
  await expect(page.locator("#app-review")).toBeVisible();
  await expect(page.locator(CHART)).toHaveCount(1);

  const originalId = (await page.locator(".trip-open").first().getAttribute("data-track-id")) ?? "";
  expect(originalId, "the recorded trip is not in the list to be identified").not.toBe("");

  const before = await chartLines(page);
  expect(before.length, "there was no chart to round-trip").toBeGreaterThan(0);
  for (const points of before) expect(points, "a chart line was drawn with no points").not.toBe("");

  const saving = page.waitForEvent("download");
  await page.locator("#export-geojson").click();
  const saved = await (await saving).path();
  if (saved === null) throw new Error("the browser saved no file");
  const exported = JSON.parse(await readFile(saved, "utf8")) as unknown;

  // ── The original goes, and its absence is established through the store rather than inferred.
  await page.addScriptTag({ type: "module", content: deleteTrip(originalId) });
  await page.waitForFunction(() => "__tripDeleted" in window);

  // **First reload boundary.** A fresh document, so nothing below can be answered by React state
  // the deleting document was still holding.
  await openDemo(page);
  await page.addScriptTag({ type: "module", content: lookUpTrip(originalId) });
  await page.waitForFunction(() => "__lookedUp" in window);
  const gone = await page.evaluate(
    () => (window as unknown as { __lookedUp: { hydrated: boolean; listed: boolean } }).__lookedUp,
  );
  // **The discriminator**: there is no hydrated original available to render, said by the store
  // itself rather than inferred from a screen.
  expect(
    gone.hydrated,
    "the store still hydrates the original track, so a later chart could come from it",
  ).toBe(false);
  expect(gone.listed, "a summary still names the original track").toBe(false);
  // Secondary, and app-surface: what the person would see.
  await expect(page.locator("#trip-list"), "a trip survived the delete").toHaveAttribute(
    "data-count",
    "0",
  );
  await expect(page.locator(CHART), "a chart survived with nothing stored").toHaveCount(0);

  // ── Re-imported through the published importer, and written through the app's own store.
  const back = geoJSONToTrack({ geojson: exported as never, media: [] });
  // The importer preserves what the document carried — `portability.ts:390` takes `properties.id`,
  // and `origin` comes back as it was exported. Neither is asserted as changed: the id being the
  // same is precisely why the delete above had to happen first.
  expect(back.track.id, "the importer did not preserve the exported id").toBe(originalId);
  await page.addScriptTag({ type: "module", content: importTrack(back.track) });
  await page.waitForFunction(() => "__trackImported" in window);

  // **Second reload boundary.** The importing document goes too, so the list and the review below
  // are built by the app out of IndexedDB rather than out of anything the import script left.
  await openDemo(page);
  const row = page.locator(".trip-open");
  await expect(row, "the imported trip never reached the list").toHaveCount(1);
  await row.click();
  await expect(page.locator("#app-review")).toBeVisible();

  // ── The identity. Same geometry, per segment, in order.
  await expect(page.locator(CHART), "the imported trip charts no channel").toHaveCount(1);
  /**
   * **Sensitive to the values, not merely to the arrays being present — with one sample or many.**
   *
   * The falsifier this is written against changes the *first* finite cadence sample and nothing
   * else: same id, same timestamps, same geometry, same segments, same descriptor, channel arrays
   * still there. It parses, stores and charts, and dies here.
   *
   * That works at any sample count because the scale is **fixed by the descriptor**:
   * `trip-review.ts:395` takes `descriptor.min ?? observed` and `descriptor.max ?? observed`, and
   * `DEMO_CHANNEL` declares 40–110. So one sample's value maps to one y, and changing it moves the
   * point. Inferring the scale from observed values would make a single sample's y constant and a
   * lone-sample mutation invisible — which matters because increment 1 established that sample
   * density is scheduler-dependent, and a legal loaded run can store exactly one. Demonstrated on
   * such a run: `[null, 100]` against an exported `[null, 66]`.
   */
  expect(
    await chartLines(page),
    "the chart drawn from the imported document is not the chart that was exported",
  ).toStrictEqual(before);

  expect(consoleFor(page).problems()).toStrictEqual([]);
});
