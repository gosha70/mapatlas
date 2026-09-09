// SPDX-License-Identifier: Apache-2.0

/**
 * Driving the demo's two ways of making a trip.
 *
 * **One home, because two scenarios now make the same pair.** `app-loop.e2e.ts` proves each flow
 * on its own and `app-equivalence.e2e.ts` compares one against the other; if each kept its own
 * copy of "record a trip" they could drift into recording *different* trips, and the comparison
 * would then be measuring the drift. Every helper here is the interaction a person performs —
 * real clicks, the real file chooser — never a handler called directly.
 */

import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

import { fixturePng } from "./browser.js";

export const DEMO = "http://127.0.0.1:5175";
export const ARCHIVES = "http://127.0.0.1:5176";

export const withArchives =
  `${DEMO}/?terrain=${encodeURIComponent(`${ARCHIVES}/terrain.pmtiles`)}` +
  `&contours=${encodeURIComponent(`${ARCHIVES}/contours.pmtiles`)}`;

/** Inside the region the archives cover, so a fix lands on ground the map can draw. */
export const HOME = { latitude: 45.84, longitude: 6.865, accuracy: 5 };

export const PHOTO = {
  name: "field-shot.jpg",
  mimeType: "image/jpeg",
  // A real, decodable PNG. A signature followed by arbitrary bytes round-trips through storage
  // perfectly and renders as a zero-sized broken image — a fixture defect wearing an app defect's
  // clothes.
  buffer: fixturePng(),
};

/** Open the demo over its archives and wait for the shell to finish opening its stores. */
export async function openDemo(page: Page): Promise<void> {
  await page.goto(withArchives);
  await expect(page.locator("#shell-status")).toHaveAttribute("data-status", "ready");
}

/** Record two distinct fixes. The default policy keeps a fix only after 10 m, so the moves are
 *  far larger than that: a track that kept one point is not a trip. */
export async function recordTwoFixes(page: Page): Promise<void> {
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
export async function pinOnMap(page: Page, mapSelector = "#app-map"): Promise<void> {
  const box = await page.locator(`${mapSelector} canvas`).boundingBox();
  if (box === null) throw new Error(`${mapSelector} drew no canvas to tap`);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

/**
 * Compose an event through the composer: a photo through the real picker, and a comment.
 *
 * The photo goes in through the capture affordance, never `setInputFiles` on the element:
 * writing the input's files directly would pass even if the button were wired to nothing.
 */
export async function composeEvent(page: Page, comment: string): Promise<void> {
  const chooser = page.waitForEvent("filechooser");
  await page.locator(".mapatlas-composer-photo").click();
  await (await chooser).setFiles(PHOTO);
  // The preview proves the bytes decoded, not merely that a file was selected.
  await expect(page.locator(".mapatlas-composer-preview")).toBeVisible();
  await page.locator(".mapatlas-composer-comment").fill(comment);
  await page.locator(".mapatlas-composer-save").click();
}

/** The review's own reported distance, in km, read out of the stats panel. */
export async function distanceKm(page: Page): Promise<number> {
  const stats = page.locator(".mapatlas-trip-stats");
  await expect(stats).toBeVisible();
  const text = (await stats.textContent()) ?? "";
  const found = /Distance\s*([\d.]+)\s*km/.exec(text);
  if (found?.[1] === undefined) throw new Error(`no distance in the stats panel: ${text}`);
  return Number(found[1]);
}

/**
 * Draw a three-vertex trip with real clicks on the authoring canvas.
 *
 * **Drawing only.** Timing is one click the caller makes, because a scenario has to be able to
 * observe the untimed state between the two — which is the whole of the engine's refusal.
 */
export async function drawThreeVertices(page: Page): Promise<void> {
  const box = await page.locator("#authoring-map canvas").boundingBox();
  if (box === null) throw new Error("the authoring map drew no canvas to draw on");
  const vertices: readonly (readonly [number, number])[] = [
    [-80, -40],
    [0, 0],
    [80, 40],
  ];
  for (const [dx, dy] of vertices) {
    await page.mouse.click(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy);
  }
  await expect(page.locator("#authoring-status")).toHaveAttribute("data-points", "3");
}
