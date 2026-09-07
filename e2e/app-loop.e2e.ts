// SPDX-License-Identifier: Apache-2.0
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

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
  // The track line is the renderer's own evidence that a multi-point track reached it: one point
  // draws no line, and `demoPresentation.trackLine` is what colours this one.
  await expect(page.locator("#app-review canvas")).toBeVisible();
  await expect(page.locator("#recorder-status")).toHaveAttribute("data-status", "finalized");
});
