// SPDX-License-Identifier: Apache-2.0
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

import { consoleFor, watchConsole } from "./fixtures/browser.js";
import type { SettledRender } from "./fixtures/rendered.js";
import { mapOf, pngSize, settleRender } from "./fixtures/rendered.js";

/**
 * `/lab`'s harness: archives served by range, the worker loaded, and no egress (T4.6).
 *
 * This file establishes the *infrastructure* the render evidence will stand on. It deliberately
 * asserts nothing about pixels: a scenario that checked rendering before proving the archives
 * were fetched and the worker was loaded could not say which of the three had failed.
 *
 * **Every test runs under the shared console watch.** The first version did not, and that was
 * the sharpest failure here: the invalid-PMTiles-bounds error which prompted the writer fix was
 * printed on every run and noticed by a person reading the log, while all three tests stayed
 * green. A harness that needs a human to read its output is not a harness.
 */

/**
 * Pinned here rather than inherited from the device profile.
 *
 * Every capture in this file is compared against another one, and a difference in viewport or
 * device scale produces pixel change that reads as geometry. Stating them makes the comparison's
 * precondition part of the spec instead of a property of whichever profile the config selects.
 */
test.use({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });

const DEMO = "http://127.0.0.1:5175";
const ARCHIVES = "http://127.0.0.1:5176";

const LAB_URL =
  `${DEMO}/lab?terrain=${encodeURIComponent(`${ARCHIVES}/terrain.pmtiles`)}` +
  `&contours=${encodeURIComponent(`${ARCHIVES}/contours.pmtiles`)}`;

/**
 * The same route with one source left out, and with none at all — the controls.
 *
 * `/lab` renders the track over a blank style when it is given no archives, so each of these
 * differs from {@link LAB_URL} in exactly one thing: which source exists. A comparison against
 * only the bare page cannot say *which* archive painted, since either one alone accounts for a
 * difference.
 *
 * **What this does not prove.** Declaring the DEM also enables terrain, and terrain changes the
 * scene whether or not a single hillshade pixel is drawn — so these controls establish that each
 * source reaches the renderer and changes the image, not that the hillshade *layer* drew.
 * `render-differential.e2e.ts` closes that by holding the source and the terrain fixed and
 * removing only the layer.
 */
const BARE_LAB_URL = `${DEMO}/lab`;
const TERRAIN_ONLY_URL = `${DEMO}/lab?terrain=${encodeURIComponent(`${ARCHIVES}/terrain.pmtiles`)}`;
const CONTOURS_ONLY_URL = `${DEMO}/lab?contours=${encodeURIComponent(`${ARCHIVES}/contours.pmtiles`)}`;

/**
 * Exactly the origins the fixture may talk to.
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

function isAllowed(url: string): boolean {
  try {
    return ALLOWED_ORIGINS.has(new URL(url).origin);
  } catch {
    return false;
  }
}

/**
 * The same origins, spelled as WebSocket ones.
 *
 * **`page.route` does not see a WebSocket at all.** It intercepts HTTP; a socket opened by the
 * page goes straight out, so a guard built only on `page.route` records nothing about it and the
 * "no egress" claim would hold with an external socket wide open — and this page already opens
 * one, for Vite's HMR channel, which is why "no sockets appeared" was never going to be true.
 * `page.routeWebSocket` is the matching seam and is installed beside it.
 */
const ALLOWED_SOCKET_ORIGINS = new Set(
  [...ALLOWED_ORIGINS].map((origin) => origin.replace(/^http/, "ws")),
);

function isAllowedSocket(url: string): boolean {
  try {
    return ALLOWED_SOCKET_ORIGINS.has(new URL(url).origin);
  } catch {
    return false;
  }
}

/** Range reads and responses, **per archive**: one archive cannot vouch for the other. */
interface ArchiveEvidence {
  ranges: number;
  statuses: number[];
}

interface Observed {
  egress: string[];
  /** Sockets the guard refused. Kept apart from `egress`: they come through a different seam. */
  socketEgress: string[];
  /** Sockets the guard let through, so the permissive branch is observable rather than assumed. */
  socketsForwarded: string[];
  worker: { url: string; status: number } | undefined;
  archives: Record<"terrain" | "contours", ArchiveEvidence>;
}

/** Which archive a URL belongs to, or `undefined` if it is not one. */
function archiveOf(url: string): "terrain" | "contours" | undefined {
  if (url.startsWith(`${ARCHIVES}/terrain.pmtiles`)) return "terrain";
  if (url.startsWith(`${ARCHIVES}/contours.pmtiles`)) return "contours";
  return undefined;
}

/**
 * Install the egress policy, recording what the page asks for.
 *
 * Requests outside the allow-list are **failed**, not merely counted: a scenario that tolerated
 * them would prove the tiles were cached, where this proves they were never wanted.
 *
 * Separate from navigation because a test may open the route more than once — the archive
 * control loads `/lab` twice — and installing a second set of routes on the same page would
 * double-count every request the first set already saw.
 */
async function guard(page: Page): Promise<Observed> {
  const observed: Observed = {
    egress: [],
    socketEgress: [],
    socketsForwarded: [],
    worker: undefined,
    archives: { terrain: { ranges: 0, statuses: [] }, contours: { ranges: 0, statuses: [] } },
  };

  // Installed before the HTTP route so nothing about ordering is left to chance, and before
  // navigation because Vite's client opens its socket during load.
  await page.routeWebSocket("**/*", (ws) => {
    if (isAllowedSocket(ws.url())) {
      // Forwarded to the real server. Messages pass both ways on their own once connected, so
      // HMR keeps working and this guard changes nothing the page can observe.
      observed.socketsForwarded.push(ws.url());
      ws.connectToServer();
      return;
    }
    observed.socketEgress.push(ws.url());
    // Never connected, so the bytes do not leave: a route that closed *after* connecting would
    // have already made the connection the test claims was never made.
    ws.close({ code: 1008, reason: "outside the fixture's own servers" });
  });

  await page.route("**/*", async (route) => {
    const url = route.request().url();
    if (isAllowed(url)) {
      const archive = archiveOf(url);
      if (archive !== undefined && route.request().headers()["range"] !== undefined) {
        observed.archives[archive].ranges += 1;
      }
      await route.continue();
      return;
    }
    observed.egress.push(url);
    await route.abort("blockedbyclient");
  });

  page.on("response", (response) => {
    const url = response.url();
    if (url.includes("maplibre-gl-worker")) {
      observed.worker = { url, status: response.status() };
    }
    const archive = archiveOf(url);
    if (archive !== undefined) observed.archives[archive].statuses.push(response.status());
  });

  return observed;
}

/**
 * Open `/lab` and wait until it has stopped drawing.
 *
 * The three waits are three different claims, and the weakest of them used to be the only one.
 * `data-assembled` is the producer/controller boundary: the recording finished and the
 * controller was told what to draw, which happens *before* MapLibre installs a source. A canvas
 * existing says a WebGL context was created. Neither is paint, and neither is a completed
 * request — bytes arriving is not pixels either. {@link settleRender} is the third, and the
 * captures it settles on are what the assertions are then made against.
 */
async function openLab(page: Page, url: string): Promise<SettledRender> {
  await page.goto(url, { waitUntil: "load" });
  await page.waitForSelector('#status[data-assembled="true"]', { timeout: 120_000 });
  await page.waitForFunction(() => document.querySelectorAll("#map canvas").length > 0, undefined, {
    timeout: 30_000,
  });
  return settleRender(mapOf(page));
}

/** Guard, open and settle — what most tests here want. */
async function loadLab(page: Page): Promise<{ observed: Observed; settled: SettledRender }> {
  const observed = await guard(page);
  const settled = await openLab(page, LAB_URL);
  return { observed, settled };
}

test.beforeEach(({ page }) => {
  // Installed before navigation so nothing printed during load escapes it.
  watchConsole(page);
});

test.afterEach(({ page }) => {
  // **The assertion the first version was missing.** Any console error or page error the test
  // did not declare fails it — which is what would have caught the invalid-bounds error
  // automatically instead of leaving it to whoever read the log.
  expect(consoleFor(page).problems()).toEqual([]);
});

test("the map settles, and what settled is the archives on screen", async ({ page }) => {
  // **Rendered-state evidence, and the two halves have to be taken together.**
  //
  // Settling alone proves nothing: a canvas that never painted settles on its first two
  // captures, sooner than one that worked. And `data-assembled` is not the signal either — it
  // fires at the producer/controller boundary, before MapLibre installs a source. So the claim
  // is relational: the page with archives settles on a *different* image from the same page
  // without them, with viewport, device scale, style and track held identical between the two.
  // What is left over is what the DEM and contour sources put on screen.
  await guard(page);

  const both = await openLab(page, LAB_URL);
  const neither = await openLab(page, BARE_LAB_URL);
  const terrainOnly = await openLab(page, TERRAIN_ONLY_URL);
  const contoursOnly = await openLab(page, CONTOURS_ONLY_URL);

  // Same box in every capture, so every difference below is content and not framing. A viewport
  // or device-scale difference would otherwise satisfy all of them for free.
  for (const [name, settled] of Object.entries({ neither, terrainOnly, contoursOnly })) {
    expect(pngSize(settled.image), `${name} frames a different box`).toEqual(pngSize(both.image));
  }

  // Each source, on its own evidence. Compared against the stack **missing that one source**
  // rather than against the bare page: a difference from bare says only that *something*
  // painted, and the other source is enough to produce it.
  expect(
    both.image.equals(contoursOnly.image),
    "the DEM reached nothing on screen: declaring it changed no pixel",
  ).toBe(false);
  expect(both.image.equals(terrainOnly.image), "the contours changed nothing on screen").toBe(
    false,
  );
  expect(
    both.image.equals(neither.image),
    "neither archive reached the screen: the map settled without rendering them",
  ).toBe(false);

  // Recorded, not asserted — how long each took to stop changing, so a later run has something
  // to be compared against. A threshold here would be a guess about this machine.
  for (const [name, settled] of Object.entries({ both, neither, terrainOnly, contoursOnly })) {
    console.log(
      `settled ${name}: ${String(settled.captures)} captures / ${String(settled.elapsedMs)} ms`,
    );
  }
});

test("the worker asset is served, not fallen back on", async ({ page }) => {
  // **Its own assertion, because the pixel evidence cannot make it.** A missing worker 404s
  // silently and leaves the map painting far less rather than not at all — measured at 276
  // stroke pixels against 3,699 — and every capture in a differential runs under the same worker
  // configuration, so a broken one degrades them alike and the differences survive.
  const { observed } = await loadLab(page);

  expect(observed.worker, "no maplibre worker asset was requested at all").toBeDefined();
  expect(observed.worker?.status).toBe(200);
});

test("both fixture archives are read, each by range request", async ({ page }) => {
  // PMTiles is a range-read format, so ranges distinguish reading an archive from downloading
  // one. Asserted **per archive**: a single count lets terrain's reads vouch for contours, so a
  // source that disappeared entirely would leave this green.
  const { observed } = await loadLab(page);

  for (const [name, evidence] of Object.entries(observed.archives)) {
    expect(evidence.ranges, `${name}: no range request`).toBeGreaterThan(0);
    expect(evidence.statuses.length, `${name}: no response`).toBeGreaterThan(0);
    for (const status of evidence.statuses) expect([200, 206], name).toContain(status);
    expect(evidence.statuses, `${name}: no partial content`).toContain(206);
  }
});

test("nothing outside the fixture's own servers is requested", async ({ page }) => {
  // Zero egress, and failing rather than counting: a tolerated request proves the response was
  // cached, not that it was unnecessary. This is what T4.6's "renders with no network egress
  // permitted" means — browser persistence and reload survival are T6.1's.
  const { observed } = await loadLab(page);

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
  for (const url of observed.socketsForwarded) expect(isAllowedSocket(url), url).toBe(true);

  // **An empty list is only as good as what would fill it.** The assertion above holds just as
  // well when the guard admits everything, so the guard is handed the case it used to get wrong:
  // a port that shares a textual prefix with an allowed one — spelled as `${DEMO}0` so the
  // prefix relation is visible rather than asserted in a comment. Under the prefix matching this
  // replaced, `:51750` was permitted and forwarded, and nothing was ever recorded — so the decoy
  // stays absent from `egress` and this fails. Under origin comparison it is blocked.
  //
  // Declared **before** the request, since the watch matches against the declarations standing
  // when a line arrives. Exactly one: the block is the decoy's, so a second blocked request —
  // real egress, blocked as it should be — fails here rather than hiding behind this one.
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
  // The console message arrives on its own channel, so the evaluate returning does not mean it
  // has landed. Without this the declaration could still be unmatched when `afterEach` judges it.
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
