// SPDX-License-Identifier: Apache-2.0
import type { BrowserContext, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

import { consoleFor, watchConsole } from "./fixtures/browser.js";
import { DEMO_WATER_FILL, countColour } from "./fixtures/pixels.js";
import { settleRender } from "./fixtures/rendered.js";

/**
 * The application shell's own offline claim (T7.1 increment 5c): **with the app's origin
 * unreachable, a fresh document boots the real application out of the service worker — and the
 * map archives are not the worker's to own.**
 *
 * **Served from the production build, on its own origin.** The other demo scenarios run against
 * the dev server on 5175, whose module graph is a different set of files under a different set of
 * urls and has no `sw.js` at all. A worker precaching that graph would prove nothing about what
 * ships, so this lane builds the bundle, generates the worker from the emitted tree, and serves
 * that tree with `vite preview` on 5177.
 *
 * **Why the network is cut with routing rather than by stopping a server.** Playwright documents
 * two properties that together make the boundary unambiguous: enabling routing disables the
 * browser's ordinary HTTP cache, and a request the service worker answers never becomes a network
 * request at all. So a document that loads while the app origin is aborted cannot have come from
 * the http cache, cannot have come from the server, and can only have come from Cache Storage.
 * `context.route` rather than `page.route` deliberately: the worker's own `fetch` falls outside a
 * page route, so an asset the worker failed to precache would quietly reach the live server and
 * the omission would go unseen.
 *
 * **Both halves, again.** "The page loaded" is not the claim — an `index.html` with no bundle
 * loads perfectly. The claim is that the *application* came up, so the assertions are the app's
 * own readiness marker (React ran) and the basemap's water colour on the canvas (the MapLibre
 * worker chunk ran, and the stored archives reached it).
 */

test.use({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });

/** The production bundle, built and served by this lane's fourth web server. */
const APP = "http://127.0.0.1:5177";
const ARCHIVES = "http://127.0.0.1:5176";
const ARCHIVE_FILES = ["terrain.pmtiles", "contours.pmtiles", "basemap.pmtiles"] as const;

const url = () =>
  `${APP}/?terrain=${encodeURIComponent(`${ARCHIVES}/terrain.pmtiles`)}` +
  `&contours=${encodeURIComponent(`${ARCHIVES}/contours.pmtiles`)}` +
  `&basemap=${encodeURIComponent(`${ARCHIVES}/basemap.pmtiles`)}`;

/**
 * Cut an origin off, and remember what asked for it.
 *
 * Aborted rather than failed with a 5xx: a served error is still a served response, and the app
 * shell would be free to bootstrap from one.
 */
async function cut(context: BrowserContext, origin: string, refused: string[]): Promise<void> {
  await context.route(
    (target) => target.origin === origin,
    async (route) => {
      refused.push(route.request().url());
      await route.abort("blockedbyclient");
    },
  );
}

/**
 * Establish, from inside the page, that an origin really is unreachable.
 *
 * **The premise the whole scenario rests on, asserted rather than assumed.** When everything
 * works there are *no* requests to either origin — the shell comes from the worker and the
 * archives from the store — so a route that had been removed would leave no trace, and every
 * offline assertion below would be satisfied by a network that was never cut. This probe asks
 * for a path nothing precaches and nothing stores: aborted it rejects, and served (a plain 404
 * from either server) it resolves. The difference between those two is exactly the premise.
 *
 * **`no-cors`, and that is what makes the probe honest.** The path asked for does not exist, and
 * the archive server answers an unknown path with a bare `404` before it reaches the branch that
 * sets `Access-Control-Allow-Origin` (`e2e/fixtures/serve-lab-archives.mjs`) — its *successful*
 * responses do carry that header, which is how the map reads archives cross-origin at all. So a
 * default `cors` fetch rejects on the CORS check for a live host and on the abort for a cut one,
 * and cannot tell them apart: the probe returned "unreachable" for a server that was replying, and
 * the mutation that removes this route survived it. Under `no-cors` a reply is an opaque response,
 * which resolves whatever its status or headers; only a refused request rejects. Found by running
 * that mutation: it was caught by an unrelated console assertion, which is not the same as being
 * caught.
 */
async function unreachable(page: Page, origin: string): Promise<boolean> {
  return page.evaluate(
    async (target) =>
      fetch(`${target}/__unreachable-probe`, { mode: "no-cors", cache: "no-store" }).then(
        () => false,
        () => true,
      ),
    origin,
  );
}

/** Every request url held in every Cache Storage cache this origin has. */
const cacheStorageUrls = (page: Page): Promise<string[]> =>
  page.evaluate(async () => {
    const urls: string[] = [];
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const request of await cache.keys()) urls.push(request.url);
    }
    return urls;
  });

const appMap = (page: Page) => page.locator("#app-map");

const waterPixels = async (page: Page): Promise<number> => {
  await settleRender(appMap(page));
  return countColour(await appMap(page).locator("canvas").screenshot(), DEMO_WATER_FILL);
};

/** Load the app and wait for the shell to finish installing whatever is stored. */
async function open(page: Page): Promise<void> {
  await page.goto(url());
  await expect(page.locator("#shell-status")).toHaveAttribute("data-status", "ready");
}

/** Wait until this document is being served by the worker, rather than merely having one. */
async function controlled(page: Page): Promise<void> {
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
}

test("the built shell boots with its own origin cut, and the worker owns no archives", async ({
  context,
  page,
}) => {
  const console_ = watchConsole(page);
  // Both origins are aborted on purpose below, and the probes that establish that are themselves
  // blocked loads. Declared rather than filtered, so a run in which *nothing* was blocked fails
  // here instead of passing quietly.
  console_.expect(
    /ERR_BLOCKED_BY_CLIENT|Failed to fetch|AJAXError|NetworkError|Failed to load resource/,
    "both origins are cut on purpose in the second half of this scenario",
  );

  // ── Phase 1. Online: the production bundle loads, the worker takes control, the region is
  // downloaded into the asset store.
  await open(page);
  await controlled(page);

  await expect(page.locator("#offline-status")).toHaveAttribute("data-regions", "0");
  await page.locator("#offline-download").click();
  await expect(page.locator("#offline-status")).toHaveAttribute("data-regions", "1", {
    timeout: 30_000,
  });
  await expect(page.locator("#offline-status")).toHaveAttribute(
    "data-stored",
    "demo-basemap,demo-contours,demo-terrain",
  );

  // ── Phase 2. Both origins go down, and the premise is checked before anything is asserted on it.
  const refused: string[] = [];
  await cut(context, APP, refused);
  await cut(context, ARCHIVES, refused);

  expect(await unreachable(page, APP), "the app origin was still answering").toBe(true);
  expect(await unreachable(page, ARCHIVES), "the archive origin was still answering").toBe(true);

  // A fresh document, not a re-render: the PMTiles protocol is realm-scoped and its instances
  // cache (ADR-0036), so re-mounting in this realm would draw from tiles already decoded.
  await open(page);
  await controlled(page);

  // **The application, not a document.** `#shell-status` reaching `ready` is React having run
  // from the precached bundle; the water colour is MapLibre's worker chunk having run too, and
  // the stored archives having reached it. An `index.html` served alone satisfies neither.
  expect(
    await waterPixels(page),
    "the basemap drew nothing with both origins cut — the shell or the store did not deliver",
  ).toBeGreaterThan(100);

  // ── The ownership boundary, asserted **after the map has been used**.
  //
  // Immediately after installation this list is whatever the worker precached, and a worker that
  // caches archives at *runtime* has not run its fetch path yet — so the mutation survives. Read
  // here, the map has drawn a full frame from three archives.
  const cached = await cacheStorageUrls(page);

  // The positive half: an empty Cache Storage would satisfy every exclusion below for the wrong
  // reason. (It could not have got this far — but the oracle should not depend on that.)
  expect(cached.filter((target) => target.endsWith(".js")).length).toBeGreaterThan(0);
  for (const archive of ARCHIVE_FILES) {
    expect(
      cached.filter((target) => target.includes(archive)),
      `${archive} is in Cache Storage — the worker has taken ownership of a map archive`,
    ).toStrictEqual([]);
  }
  expect(
    cached.filter((target) => target.startsWith(ARCHIVES)),
    "the worker cached something from the archive origin",
  ).toStrictEqual([]);

  // The refusals recorded are the app's and the archives' — never the shell's own assets, which
  // is what "the worker served them" means in terms of what reached the network.
  expect(refused.filter((target) => target.includes("/assets/"))).toStrictEqual([]);

  expect(consoleFor(page).problems()).toEqual([]);
});

test("the worker answers the application's root and leaves /lab to the network", async ({
  context,
  page,
}) => {
  /**
   * **The scope boundary, as a pair.** `/lab` is T4.6's fixture and the subject of five merged
   * scenarios; a worker that answered its navigations would change what those measure. A test
   * that only asserted `/lab` fails offline would also pass with the worker never installed at
   * all, so the two halves are asserted against one another: with the app origin cut, `/` comes
   * up out of the precache and `/lab` does not come up at all.
   *
   * This is also where a removed route would show: without the abort, `/lab` would simply load.
   */
  const console_ = watchConsole(page);
  console_.expect(
    /ERR_BLOCKED_BY_CLIENT|Failed to fetch|Failed to load resource/,
    "the app origin is cut for the second half of this scenario",
  );

  await open(page);
  await controlled(page);

  const refused: string[] = [];
  await cut(context, APP, refused);
  expect(await unreachable(page, APP), "the app origin was still answering").toBe(true);

  await open(page);

  await expect(
    page.goto(`${APP}/lab`),
    "/lab loaded with its origin cut, so the worker is answering for it",
  ).rejects.toThrow();
  expect(refused.some((target) => target.endsWith("/lab"))).toBe(true);
});
