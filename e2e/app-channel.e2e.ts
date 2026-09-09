// SPDX-License-Identifier: Apache-2.0
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

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
