// SPDX-License-Identifier: Apache-2.0
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

import { consoleFor, watchConsole } from "./fixtures/browser.js";
import { decodePng } from "./fixtures/pixels.js";
import { settleRender } from "./fixtures/rendered.js";

/**
 * The demo app's shell (T7.1 increment 1), in a real browser.
 *
 * **What only this lane can see.** The unit lane mocks `MapCanvas`, because a real MapLibre map
 * needs a WebGL context it does not have — so "the shell hands the map a two-source stack and a
 * camera over the archives" is asserted there, and "the map read those archives and painted what
 * it read" can only be asserted here. It is the same split T6.1 used for provenance: each half is
 * observable in exactly one place, and neither is the claim alone.
 *
 * **What the first version of this file got wrong, kept here because the trap is generic.** The
 * claim was a pixel differential: render with two archives declared, render with none, assert the
 * images differ. They did — and zero tiles had been fetched either way, because declaring a
 * source also adds its licence line to the attribution control, and *that* text is what differed.
 * The map opened at MapLibre's world view (ADR-0037) and never asked for a tile. An oracle has to
 * separate "the archives reached the canvas" from "a control mentioned them", so the claim below
 * rests on range reads past each archive's header, which nothing but the archive can produce.
 *
 * **What this increment does not claim.** No recording, no event, no photo, no review, no export
 * — those are increments 2 and 3, and a shell test that implied otherwise would be the "the map
 * rendered, therefore the loop works" trap the plan names by name.
 */

test.use({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });

const DEMO = "http://127.0.0.1:5175";
const ARCHIVES = "http://127.0.0.1:5176";

const TERRAIN = `${ARCHIVES}/terrain.pmtiles`;
const CONTOURS = `${ARCHIVES}/contours.pmtiles`;

/** The app's map element. **Not** `mapOf`, which names `/lab`'s `#map` — the two routes are
 *  different pages and sharing a locator would have this file capture the wrong one, or nothing. */
const appMap = (page: Page): ReturnType<Page["locator"]> => page.locator("#app-map");

const withArchives =
  `${DEMO}/?terrain=${encodeURIComponent(TERRAIN)}` + `&contours=${encodeURIComponent(CONTOURS)}`;

type Archive = "terrain" | "contours";

/**
 * What the wire saw for one archive, **split by where in the file it was reading**.
 *
 * The split is the whole point, and it is finer than T6.1's `full`/`ranges` because the question
 * here is finer. Every PMTiles read is a `Range` request, so a range count alone is satisfied by
 * a map that opened the archive, read its header, discovered the tiles it wanted were nowhere
 * near, and asked for nothing further — which is exactly the failure this file exists to catch.
 *
 * `pmtiles.js` reads the header and root directory with `getBytes(0, 16384)`; every leaf
 * directory and every tile lives past that, at an offset the header supplied. So a range request
 * whose **first byte is not 0** is the archive being read for content, and it is unforgeable: it
 * cannot be issued without having parsed the header, and the offset in it came from the archive.
 */
interface ArchiveReads {
  /** Range reads from byte 0 — the header and root directory. Opening the file, nothing more. */
  header: number;
  /** Range reads starting past byte 0 — a leaf directory or a tile the map actually wanted. */
  beyondHeader: number;
  /** Anything that was not a range read. `download()` makes these; rendering never does. */
  plain: number;
}

/** Which archive a url belongs to, or `undefined` if it is not one. */
function archiveOf(url: string): Archive | undefined {
  if (url.startsWith(TERRAIN)) return "terrain";
  if (url.startsWith(CONTOURS)) return "contours";
  return undefined;
}

/** The first byte a `Range` header asks for, or `null` if the request was not a range read. */
function rangeStart(header: string | undefined): number | null {
  if (header === undefined) return null;
  const match = /^bytes=(\d+)-/.exec(header.trim());
  // A range header this does not recognise is *not* silently treated as a header read: an
  // unparsed one would be counted as byte 0 and would then vouch for content it never carried.
  if (match === null) throw new Error(`unrecognised Range header: ${header}`);
  return Number(match[1]);
}

/**
 * Count what each archive was asked for, per archive.
 *
 * Per archive because one archive's traffic must never vouch for the other's: terrain and
 * contours are separate files (ADR-0025), and a stack that dropped one would still show a map.
 * Installed before any navigation, so the counters see every request the page makes.
 */
async function watchArchives(page: Page): Promise<Record<Archive, ArchiveReads>> {
  const reads: Record<Archive, ArchiveReads> = {
    terrain: { header: 0, beyondHeader: 0, plain: 0 },
    contours: { header: 0, beyondHeader: 0, plain: 0 },
  };

  await page.route(`${ARCHIVES}/**`, async (route) => {
    const archive = archiveOf(route.request().url());
    if (archive !== undefined) {
      const start = rangeStart(route.request().headers()["range"]);
      if (start === null) reads[archive].plain += 1;
      else if (start === 0) reads[archive].header += 1;
      else reads[archive].beyondHeader += 1;
    }
    await route.continue();
  });

  return reads;
}

/**
 * How much of a capture is *not* the empty style's background.
 *
 * `BLANK_STYLE` paints `#eceff1` and declares no sources of its own, so every non-background
 * pixel came from something the app added. That makes this an absolute oracle rather than a
 * differential: it does not need a second render to compare against, and it cannot be satisfied
 * by a control's text changing, because text occupies a corner and terrain occupies the frame.
 *
 * The tolerance is for antialiasing and for the map's own controls, not for tiles: a pixel is
 * "background" only if all three channels are within one step of the declared colour.
 */
function nonBackgroundFraction(png: Buffer): number {
  const raster = decodePng(png);
  const [br, bg, bb] = [0xec, 0xef, 0xf1];
  let painted = 0;
  for (let i = 0; i < raster.width * raster.height; i += 1) {
    const at = i * 4;
    const near =
      Math.abs((raster.data[at] ?? 0) - br) <= 1 &&
      Math.abs((raster.data[at + 1] ?? 0) - bg) <= 1 &&
      Math.abs((raster.data[at + 2] ?? 0) - bb) <= 1;
    if (!near) painted += 1;
  }
  return painted / (raster.width * raster.height);
}

/** Wait until the map has put a canvas in the page. */
async function waitForCanvas(page: Page): Promise<void> {
  await page.waitForFunction(() => document.querySelectorAll("#app-map canvas").length > 0, null, {
    timeout: 30_000,
  });
}

test.beforeEach(({ page }) => {
  watchConsole(page);
});

test.afterEach(({ page }) => {
  expect(consoleFor(page).problems()).toEqual([]);
});

test("the app mounts and opens both stores", async ({ page }) => {
  await page.goto(DEMO, { waitUntil: "load" });

  const status = page.locator("#shell-status");
  // `ready` is published only after a real read of each store resolves — constructing the
  // adapters proves nothing, since both open lazily and a database that cannot be opened looks
  // identical until something reads it.
  await expect(status).toHaveAttribute("data-status", "ready");
  await expect(page.locator("h1.app-title")).toBeVisible();

  // The app's settings, absorbed from T6.2's own route rather than left on a page of their own.
  await expect(page.locator("#persistence")).toHaveCount(1);
  await expect(page.locator("#install-guidance")).toHaveCount(1);
});

test("the canvas fills the box the page gave it", async ({ page }) => {
  // **"A canvas exists" is satisfied by a canvas of any size**, including MapLibre's 400x300
  // fallback for a container it measured as zero-wide — which is what a map inside a container
  // that had not been laid out yet produces. It renders: correctly framed, correctly attributed,
  // and clipped to a box narrower than the one on screen, with grey either side.
  await page.goto(withArchives, { waitUntil: "load" });
  await waitForCanvas(page);
  await settleRender(appMap(page));

  const box = await page.evaluate(() => {
    const container = document.querySelector<HTMLElement>("#app-map");
    const canvas = document.querySelector<HTMLCanvasElement>("#app-map canvas");
    if (container === null || canvas === null) throw new Error("no map to measure");
    // `clientWidth` on the container excludes its border, which is what the canvas fills;
    // `getBoundingClientRect` on the canvas is its CSS size, not its backing-store size, which
    // is the device-scaled one and is a different question.
    return {
      container: container.clientWidth,
      containerHeight: container.clientHeight,
      canvas: canvas.getBoundingClientRect().width,
      canvasHeight: canvas.getBoundingClientRect().height,
    };
  });

  expect(box.container, "the map container itself has no width").toBeGreaterThan(0);
  // A pixel of tolerance for subpixel layout; nothing near the ~270px gap the fallback leaves.
  expect(
    Math.abs(box.canvas - box.container),
    `canvas ${String(box.canvas)}px in a container ${String(box.container)}px wide`,
  ).toBeLessThanOrEqual(1);
  expect(Math.abs(box.canvasHeight - box.containerHeight)).toBeLessThanOrEqual(1);
});

test("the map reads both archives past their headers, and paints what it read", async ({
  page,
}) => {
  const reads = await watchArchives(page);

  await page.goto(withArchives, { waitUntil: "load" });
  await expect(page.locator("#shell-status")).toHaveAttribute("data-status", "ready");
  await expect(page.locator("#shell-status")).toHaveAttribute("data-sources", "2");
  await waitForCanvas(page);

  // **The claim.** A read past byte 0 cannot be issued without having parsed the archive's
  // header, and the offset in it came from that archive — so neither the attribution control nor
  // any other part of the page can produce one. Per archive, because a stack that silently
  // dropped the contours would still draw a map.
  await expect
    .poll(() => reads.terrain.beyondHeader, {
      timeout: 30_000,
      message: "the terrain archive was opened and then never read: the camera is over no tiles",
    })
    .toBeGreaterThan(0);
  await expect
    .poll(() => reads.contours.beyondHeader, {
      timeout: 30_000,
      message: "the contour archive was opened and then never read",
    })
    .toBeGreaterThan(0);

  // Reading is not drawing. `BLANK_STYLE` declares no sources of its own and paints one flat
  // colour, so what covers the frame here came from the archives — the map's own controls
  // occupy a corner and could never account for it.
  const withStack = await settleRender(appMap(page));
  expect(
    nonBackgroundFraction(withStack.image),
    "the archives were read but the frame is still the empty style's background",
  ).toBeGreaterThan(0.5);

  // The negative half, so the threshold above is not just a number that happened to pass: with
  // no archives declared, the same page at the same camera paints the background and its
  // controls, and nothing else.
  await page.goto(DEMO, { waitUntil: "load" });
  await expect(page.locator("#shell-status")).toHaveAttribute("data-sources", "0");
  await waitForCanvas(page);
  const bare = await settleRender(appMap(page));
  expect(
    nonBackgroundFraction(bare.image),
    "an empty stack painted the frame: the oracle cannot tell tiles from furniture",
  ).toBeLessThan(0.1);
});

test("the app never reaches the fixture route", async ({ page }) => {
  // `/lab` is T4.6's fixture and carries T6.1's merged offline evidence through five scenarios.
  // The app is a different thing on the same origin, and the plan's ruling is that it coexists
  // untouched — asserted rather than promised, since a shared `#app` mount is exactly how it
  // would go wrong.
  await page.goto(`${DEMO}/lab`, { waitUntil: "load" });
  await page.waitForSelector('#status[data-assembled="true"], #status[data-failed="true"]', {
    timeout: 120_000,
  });

  await expect(page.locator("#shell-status")).toHaveCount(0);
  await expect(page.locator("h1.app-title")).toHaveCount(0);
  await expect(page.locator("#persistence")).toHaveCount(0);
});
