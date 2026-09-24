// SPDX-License-Identifier: Apache-2.0
import type { Page, Worker } from "@playwright/test";
import { expect, test } from "@playwright/test";

import { consoleFor, watchConsole } from "./fixtures/browser.js";
import type { Raster } from "./fixtures/pixels.js";
import { changedMask, countColour, countMask, decodePng } from "./fixtures/pixels.js";
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
 * **What this file does not claim.** No recording, no event, no photo, no review, no export — all
 * of those are `app-loop.e2e.ts`'s, export included, since increment 3 is merged. A shell test
 * implying otherwise would be the "the map rendered, therefore the loop works" trap the plan
 * names by name. The split is deliberate: this file must still fail for a shell reason alone, so that a
 * broken loop and a broken shell are two different red tests rather than one.
 */

test.use({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });

const DEMO = "http://127.0.0.1:5175";
const ARCHIVES = "http://127.0.0.1:5176";

const TERRAIN = `${ARCHIVES}/terrain.pmtiles`;
const CONTOURS = `${ARCHIVES}/contours.pmtiles`;
const BASEMAP = `${ARCHIVES}/basemap.pmtiles`;

/** The app's map element. **Not** `mapOf`, which names `/lab`'s `#map` — the two routes are
 *  different pages and sharing a locator would have this file capture the wrong one, or nothing. */
const appMap = (page: Page): ReturnType<Page["locator"]> => page.locator("#app-map");

const withArchives =
  `${DEMO}/?terrain=${encodeURIComponent(TERRAIN)}` + `&contours=${encodeURIComponent(CONTOURS)}`;

type Archive = "terrain" | "contours" | "basemap";

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
  if (url.startsWith(BASEMAP)) return "basemap";
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
    basemap: { header: 0, beyondHeader: 0, plain: 0 },
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

/**
 * The demo's own water fill, `#b3cde0` — `sources.ts` paints the basemap's `water` layer with it.
 *
 * **Named rather than diffed.** The first version of this assertion compared two renders and
 * required them to differ at all, which every mutation survived: two page loads differ anyway,
 * so `> 0` was satisfied by antialiasing noise and vouched for nothing. Renaming all four
 * `source-layer`s so the basemap drew *nothing* still passed it.
 *
 * A named colour is attributable. Nothing else on this map paints it — terrain is a greyscale
 * hillshade and the contour lines are brown — so its presence is the basemap's `water` layer
 * having found geometry under the name the demo asked for, and its absence is that layer drawing
 * nothing.
 */
const WATER_FILL: readonly [number, number, number] = [0xb3, 0xcd, 0xe0];

test("the root route draws the basemap from its own archive", async ({ page }) => {
  /**
   * **Online, and not increment 5's offline provenance.** What this establishes is narrower and
   * comes first: that the *demo* declares the third source, that MapLibre parses that archive and
   * asks for its tiles, and that the layer named below draws a basemap-specific contribution.
   * Whether those bytes can come from the store with the host cut is increment 5's, on the demo's
   * own download path.
   *
   * The oracle is the same unforgeable one the shell test uses — a range read whose first byte is
   * not 0 cannot be issued without having parsed the archive's header, and the offset in it came
   * from the archive. Counted **per archive**, so terrain's traffic cannot vouch for the
   * basemap's: a stack that silently dropped the basemap would still show a map.
   */
  const reads = await watchArchives(page);
  watchConsole(page);

  await page.goto(
    `${DEMO}/?terrain=${encodeURIComponent(TERRAIN)}` +
      `&contours=${encodeURIComponent(CONTOURS)}` +
      `&basemap=${encodeURIComponent(BASEMAP)}`,
  );
  await expect(page.locator("#shell-status")).toHaveAttribute("data-status", "ready");
  // Three sources declared, not two — the count the shell reports is the app's own statement of
  // what it handed the renderer.
  await expect(page.locator("#shell-status")).toHaveAttribute("data-sources", "3");

  await settleRender(appMap(page));

  expect(
    reads.basemap.beyondHeader,
    "the basemap archive was opened but never read for content — the map asked for no tile of it",
  ).toBeGreaterThan(0);
  // The other two still work: a change that made the basemap draw by breaking the stack would
  // otherwise pass here.
  expect(reads.terrain.beyondHeader, "terrain stopped being read").toBeGreaterThan(0);
  expect(reads.contours.beyondHeader, "contours stopped being read").toBeGreaterThan(0);

  /**
   * **And one named layer drew.** The range reads above prove the archive was parsed and its
   * tiles fetched; they do *not* prove the demo's `source-layer` names matched anything inside
   * it. A layer pointing at a name the archive lacks causes every one of those reads and comes
   * back with nothing — the v3/v4 failure wearing its rendered face.
   *
   * **Scope, stated so it is not read as more.** This probes the `water` layer alone, which is
   * the agreed basemap-specific contribution — not per-layer attribution for all four. Renaming
   * `earth` or `landuse` to another name the extract genuinely declares would pass here; the
   * schema test in `sources.test.ts` is what covers a name the extract does not have.
   *
   * The canvas alone, not the frame: MapLibre's attribution control is a sibling of the canvas,
   * so cropping to the canvas keeps a difference in *text* from vouching for a difference in
   * *map* — the trap this lane has already been caught by once.
   */
  const drawn = await appMap(page).locator("canvas").screenshot();

  // The control: the same page without the basemap. It is what makes the count above
  // attributable rather than a number — if this one were also blue, the colour would be coming
  // from somewhere else and the assertion would be measuring the wrong thing.
  await page.goto(
    `${DEMO}/?terrain=${encodeURIComponent(TERRAIN)}&contours=${encodeURIComponent(CONTOURS)}`,
  );
  await expect(page.locator("#shell-status")).toHaveAttribute("data-sources", "2");
  await settleRender(appMap(page));
  const without = await appMap(page).locator("canvas").screenshot();

  expect(
    countColour(drawn, WATER_FILL),
    "the basemap's water layer painted nothing — its source-layer matched no geometry",
  ).toBeGreaterThan(100);
  expect(
    countColour(without, WATER_FILL),
    "the water colour appears without the basemap, so it attributes nothing",
  ).toBe(0);

  expect(consoleFor(page).problems()).toEqual([]);
});

/**
 * The three claims below were `/lab`'s (T4.6, `lab.e2e.ts`) and are re-made here against the
 * shipped app under T8.3's mapping: per-source attribution of what is on screen, the worker
 * asset, and zero egress. Each was written while the original still ran, and the per-source and
 * egress claims were shown red beside their originals under the same mutations — the only moment
 * the two can be compared. The worker claim is the exception: its original was **not**
 * falsifiable as written (see that test), so the replacement was falsified on its own.
 */

/** The same route with one source left out, and with none at all — the controls. */
const withTerrainOnly = `${DEMO}/?terrain=${encodeURIComponent(TERRAIN)}`;
const withContoursOnly = `${DEMO}/?contours=${encodeURIComponent(CONTOURS)}`;

/**
 * Exactly the origins the app may talk to.
 *
 * **Origins, compared exactly — not URL prefixes.** `http://127.0.0.1:51750` starts with the
 * permitted `http://127.0.0.1:5175`, so prefix matching admitted an entirely different origin
 * while the test claimed a strict guard.
 */
const ALLOWED_ORIGINS = new Set([
  new URL(DEMO).origin,
  new URL(ARCHIVES).origin,
  "http://localhost:5175",
  "http://localhost:5176",
]);

/** The same origins, spelled as WebSocket ones — `page.route` never sees a socket. */
const ALLOWED_SOCKET_ORIGINS = new Set(
  [...ALLOWED_ORIGINS].map((origin) => origin.replace(/^http/, "ws")),
);

function originIn(allowed: ReadonlySet<string>, url: string): boolean {
  try {
    return allowed.has(new URL(url).origin);
  } catch {
    return false;
  }
}

interface Observed {
  /** HTTP requests the guard refused. */
  egress: string[];
  /** Sockets the guard refused. Kept apart from `egress`: they come through a different seam. */
  socketEgress: string[];
  /** Sockets the guard let through, so the permissive branch is observable rather than assumed. */
  socketsForwarded: string[];
}

/**
 * Install the egress policy, recording what the page asks for.
 *
 * Requests outside the allow-list are **failed**, not merely counted: a scenario that tolerated
 * them would prove the tiles were cached, where this proves they were never wanted. The dev
 * server registers no service worker (`main.ts`, production only), so a page route sees every
 * request this page makes, MapLibre's worker included.
 */
async function guardEgress(page: Page): Promise<Observed> {
  const observed: Observed = {
    egress: [],
    socketEgress: [],
    socketsForwarded: [],
  };

  // Installed before the HTTP route so nothing about ordering is left to chance, and before
  // navigation because Vite's client opens its socket during load.
  await page.routeWebSocket("**/*", (ws) => {
    if (originIn(ALLOWED_SOCKET_ORIGINS, ws.url())) {
      // Forwarded to the real server, so HMR keeps working and the page observes nothing.
      observed.socketsForwarded.push(ws.url());
      ws.connectToServer();
      return;
    }
    observed.socketEgress.push(ws.url());
    // Never connected, so the bytes do not leave.
    ws.close({ code: 1008, reason: "outside the app's own servers" });
  });

  await page.route("**/*", async (route) => {
    const url = route.request().url();
    if (originIn(ALLOWED_ORIGINS, url)) {
      await route.continue();
      return;
    }
    observed.egress.push(url);
    await route.abort("blockedbyclient");
  });

  return observed;
}

/**
 * Open the app with a stack and wait until the map has stopped drawing; hand back the canvas.
 *
 * **The canvas, not the frame.** Declaring a source also adds its licence line to the
 * attribution control, which is a sibling of the canvas — so a frame capture differs between
 * stacks whether or not a tile was drawn, the trap this file records above. Cropping to the
 * canvas keeps a difference in *text* from vouching for a difference in *map*.
 */
async function openCanvas(page: Page, url: string, sources: number): Promise<Buffer> {
  await page.goto(url, { waitUntil: "load" });
  await expect(page.locator("#shell-status")).toHaveAttribute("data-status", "ready");
  await expect(page.locator("#shell-status")).toHaveAttribute("data-sources", String(sources));
  await waitForCanvas(page);
  await settleRender(appMap(page));
  return appMap(page).locator("canvas").screenshot();
}

/**
 * How much of the canvas a source must change to count as having painted.
 *
 * **A threshold, not inequality.** Two loads of the same page are not byte-identical: measured at
 * 0.003% of the canvas (seven pixels) between two loads of the full stack, and 0.000% for
 * contours alone. Inequality would be satisfied by that noise — the same-stack control in the
 * test below is what measures it on every run. The signals are two orders of magnitude above
 * this: the DEM changes
 * 99.1% of the canvas against the contours-only stack, the contours 10.2% against the
 * terrain-only one.
 *
 * **And the premise is asserted, not remembered.** The test captures the full stack twice and
 * requires that pair to stay *under* this threshold before the signals are read against it: if
 * rendering noise ever grew past 1%, a dropped source could still satisfy the comparisons and
 * this oracle would false-green — so the run that would do that fails here instead.
 */
const MIN_SOURCE_FRACTION = 0.01;

test("each archive changes what the map paints, on its own evidence", async ({ page }) => {
  // **Relational, and the two halves have to be taken together.** Reading past the header (the
  // test above) proves an archive was asked for content; this proves each one *changed the
  // canvas*, compared against the stack **missing that one source** rather than against the
  // bare page — a difference from bare says only that *something* painted, and the other source
  // is enough to produce it. The camera is the app's own fixed one (ADR-0037), so it is the same
  // in every capture and every difference below is content, not framing.
  const both = decodePng(await openCanvas(page, withArchives, 2));
  const bothAgain = decodePng(await openCanvas(page, withArchives, 2));
  const neither = decodePng(await openCanvas(page, DEMO, 0));
  const terrainOnly = decodePng(await openCanvas(page, withTerrainOnly, 1));
  const contoursOnly = decodePng(await openCanvas(page, withContoursOnly, 1));

  for (const [name, image] of Object.entries({ bothAgain, neither, terrainOnly, contoursOnly })) {
    expect([image.width, image.height], `${name} frames a different box`).toEqual([
      both.width,
      both.height,
    ]);
  }

  const changedFraction = (a: Raster, b: Raster): number =>
    countMask(changedMask(a, b)) / (a.width * a.height);

  // The noise bound, load-bearing: the same stack twice must sit well inside the threshold the
  // signals are then held to. Every assertion below is only as good as this one.
  expect(
    changedFraction(both, bothAgain),
    "two loads of the same stack differ by more than the threshold, so the oracle cannot tell a source from noise",
  ).toBeLessThan(MIN_SOURCE_FRACTION);

  expect(
    changedFraction(both, contoursOnly),
    "the DEM reached nothing on the canvas: declaring it changed no pixel",
  ).toBeGreaterThan(MIN_SOURCE_FRACTION);
  expect(
    changedFraction(both, terrainOnly),
    "the contours changed nothing on the canvas",
  ).toBeGreaterThan(MIN_SOURCE_FRACTION);
  expect(
    changedFraction(both, neither),
    "neither archive reached the canvas: the map settled without rendering them",
  ).toBeGreaterThan(MIN_SOURCE_FRACTION);
});

test("the worker asset is served, and the worker that runs is MapLibre's", async ({ page }) => {
  // **Its own assertion, because the pixel evidence cannot make it.** A broken worker leaves the
  // map painting far less rather than not at all, and every capture in a differential runs under
  // the same worker configuration, so a broken one degrades them alike and the differences
  // survive. The URL is the app's to get right (`main.ts`, `setWorkerUrl`) — the one thing the
  // maplibre README says a consumer must configure.
  //
  // **The worker itself, not a URL that mentions it.** `/lab`'s version of this claim matched any
  // response whose URL contained `maplibre-gl-worker` and asked for a 200 — which Vite's
  // `?worker&url` export module satisfies on its own, and Vite's dev server answers 200 for a
  // worker path that does not exist. Measured: pointing the URL at a missing file left that
  // oracle green. So the observable here is the `Worker` the page created, its script's own
  // response, and MapLibre's worker-side API being present inside it.
  const workers: Worker[] = [];
  page.on("worker", (worker) => workers.push(worker));
  const statuses = new Map<string, number>();
  page.on("response", (response) => statuses.set(response.url(), response.status()));

  await openCanvas(page, withArchives, 2);

  const worker = workers.find((candidate) => candidate.url().includes("maplibre-gl-worker"));
  expect(worker, "no maplibre worker was created at all").toBeDefined();
  expect(statuses.get(worker!.url()), "the worker's script was not served with 200").toBe(200);
  // `registerWorkerSource` is MapLibre's worker-side entry point for custom sources; an empty
  // or wrong script has no such global, and a worker that failed to load cannot be evaluated.
  // A worker whose script failed to load terminates, and evaluating in it throws; that outcome
  // is the claim being false, and it is named rather than left as a closed-target error.
  const api = await worker!
    .evaluate(() => typeof (self as { registerWorkerSource?: unknown }).registerWorkerSource)
    .catch(() => "unreachable: the worker terminated");
  expect(api, "the worker that runs is not MapLibre's").toBe("function");
});

test("nothing outside the app's own servers is requested", async ({ page }) => {
  // Zero egress, and failing rather than counting: a tolerated request proves the response was
  // cached, not that it was unnecessary. This is `SECURITY.md`'s guarantee — no network egress
  // the consumer did not configure — against the shipped composition, with its stores open and
  // its full stack drawn.
  const observed = await guardEgress(page);
  await openCanvas(page, withArchives, 2);

  expect(observed.egress, `unexpected egress: ${observed.egress.join(", ")}`).toEqual([]);
  expect(
    observed.socketEgress,
    `unexpected socket egress: ${observed.socketEgress.join(", ")}`,
  ).toEqual([]);
  // **And the permissive branch, exercised.** An empty refusal list is also what a route that
  // never ran produces, so the page's own socket — Vite's HMR channel — must be seen going
  // through: it proves the seam is installed and that an allowed origin is forwarded rather
  // than silently mocked, which is the half the decoy below cannot show.
  expect(observed.socketsForwarded.length, "no socket was forwarded at all").toBeGreaterThan(0);
  for (const url of observed.socketsForwarded) {
    expect(originIn(ALLOWED_SOCKET_ORIGINS, url), url).toBe(true);
  }

  // **An empty list is only as good as what would fill it.** The assertion above holds just as
  // well when the guard admits everything, so the guard is handed a port that shares a textual
  // prefix with an allowed one — spelled as `${DEMO}0` so the prefix relation is visible.
  // Declared before the request, and exactly one: the block is the decoy's, so a second blocked
  // request — real egress — fails here rather than hiding behind this one.
  consoleFor(page).expect(
    /ERR_BLOCKED_BY_CLIENT/,
    "the decoy request below is aborted on purpose, and the browser reports the abort",
    1,
  );

  const decoy = `${DEMO}0/tile.png`;
  await page.evaluate(async (url) => {
    // Rejection *is* the expected outcome; the assertion is about what the guard recorded.
    await fetch(url).catch(() => undefined);
  }, decoy);
  await expect.poll(() => consoleFor(page).settled()).toBe(true);

  expect(observed.egress, "a prefix-sharing origin was not treated as egress").toEqual([decoy]);

  // The same falsification for the socket seam, which the HTTP decoy cannot reach: a guard
  // installed only on `page.route` leaves this one unrecorded and unblocked.
  const socketDecoy = `ws://127.0.0.1:${new URL(DEMO).port}0/hmr`;
  await page.evaluate((url) => {
    // Opening is enough; whether it then errors or closes is the browser's business.
    new WebSocket(url);
  }, socketDecoy);
  await expect
    .poll(() => observed.socketEgress, { message: "a prefix-sharing socket origin was forwarded" })
    .toEqual([socketDecoy]);
});
