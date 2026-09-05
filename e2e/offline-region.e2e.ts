// SPDX-License-Identifier: Apache-2.0
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

import { consoleFor, watchConsole } from "./fixtures/browser.js";
import type { SettledRender } from "./fixtures/rendered.js";
import { mapOf, pngSize, settleRender } from "./fixtures/rendered.js";

/**
 * A downloaded region renders with the archive host cut off — and a deleted one does not (T6.1).
 *
 * **The claim, and the thing that is not evidence for it.** T6.1 says a map can draw from bytes
 * held locally. *Zero network requests does not say that*: a service worker, a warm HTTP cache,
 * or a `blob:` url minted earlier all produce zero requests while proving nothing about the
 * store. So the claim splits, and this file is one half of it. The other half — byte identity
 * between what `put()` holds and what the protocol handler returns — is asserted in the unit
 * lane against `createMemoryMapAssetStore`, because it cannot be observed here without reaching
 * into MapLibre's internals.
 *
 * **Neither half alone is the claim.** What this file adds is that a real MapLibre, over a real
 * IndexedDB, through the protocol a consumer actually wires up, paints something it demonstrably
 * cannot paint when the region is gone.
 */

/**
 * Pinned here rather than inherited from the device profile, as in `lab.e2e.ts`: every capture
 * below is compared against another one, and a viewport or device-scale difference produces
 * pixel change that reads as geometry.
 */
test.use({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });

const DEMO = "http://127.0.0.1:5175";
const ARCHIVES = "http://127.0.0.1:5176";

const TERRAIN = `${ARCHIVES}/terrain.pmtiles`;
const CONTOURS = `${ARCHIVES}/contours.pmtiles`;

/** The same source stack in every phase; only the `offline` step differs. */
const labUrl = (offline: string): string =>
  `${DEMO}/lab?offline=${offline}&terrain=${encodeURIComponent(TERRAIN)}` +
  `&contours=${encodeURIComponent(CONTOURS)}`;

/** The ids `labTileSources` declares. Asserted, not assumed: the manifest has to name both. */
const SOURCE_IDS = "fixture-terrain,fixture-contours";

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

type Archive = "terrain" | "contours";

/** Which archive a url belongs to, or `undefined` if it is not one. */
function archiveOf(url: string): Archive | undefined {
  if (url.startsWith(TERRAIN)) return "terrain";
  if (url.startsWith(CONTOURS)) return "contours";
  return undefined;
}

/**
 * What the wire saw for one archive, **split by what kind of request it was**.
 *
 * The split is the whole point. `download()` copies an archive with a plain GET; the renderer
 * reads one with `Range` requests, and never otherwise. So a range read can never be mistaken
 * for a copy — which a single total could not distinguish, and a phase that renders after
 * downloading would then let the render's reads vouch for a copy that never happened.
 */
interface ArchiveTraffic {
  /** Plain GETs — a whole-archive copy. Only `download()` makes these. */
  full: number;
  /** Range reads — the renderer reading an archive it did not copy. */
  ranges: number;
}

/**
 * The network, as this scenario controls it.
 *
 * `archivesBlocked` is a switch rather than a second `page.route`, and that is what makes the
 * sequence possible at all. The route is installed **once, before any navigation**, so the
 * counters below observe every phase on the same terms — and then flipped between phases, so
 * the state under test changes while the instrument does not.
 */
interface Network {
  /** Per archive, because one archive's traffic must never vouch for the other's. */
  readonly archives: Record<Archive, ArchiveTraffic>;
  /** HTTP requests refused for being outside the fixture's own servers. */
  readonly egress: string[];
  /** Archive requests refused because this scenario had cut the archive host off. */
  readonly archivesRefused: string[];
  archivesBlocked: boolean;
}

/** A copy of the counters as they stand, so a later phase cannot alter an earlier phase's evidence. */
const snapshot = (net: Network): Record<Archive, ArchiveTraffic> => ({
  terrain: { ...net.archives.terrain },
  contours: { ...net.archives.contours },
});

/**
 * Why the archive **host** is cut rather than everything.
 *
 * The plan says `page.route("**", abort)`. That cannot survive the step the positive control
 * needs: a *fresh render*, which means a fresh JavaScript realm, which means a navigation — and
 * a blanket abort takes the document with it, so the app never boots and the failure looks
 * exactly like the test working.
 *
 * A fresh realm is not negotiable here. The PMTiles protocol is realm-scoped and deliberately
 * offers no way to unregister (ADR-0036), and a `PMTiles` instance carries its own promise
 * cache. Re-mounting a map in the *same* realm after deleting the region would leave the first
 * render's registration standing, with a warm cache able to answer from tiles it already
 * decoded — so the control would pass while proving nothing, which is the precise failure this
 * plan exists to refuse.
 *
 * So the cut is narrowed to exactly what the claim is about: **no byte of either archive may
 * come over the network.** What remains permitted is the demo's own origin, which serves the
 * application and no map bytes at all — the claim is *map data* offline, not app-shell offline,
 * which is Phase 7's.
 *
 * **What this guard does not cover, stated rather than implied.** It is `page.route`, so it sees
 * HTTP and nothing else; a WebSocket opened by the page goes straight past it. This file
 * therefore makes no claim about socket egress. That claim belongs to `e2e/lab.e2e.ts`, which
 * guards both seams with `page.routeWebSocket` beside `page.route` and falsifies each with a
 * decoy origin sharing a textual prefix with an allowed one. Duplicating it here without the
 * falsification would be an empty list dressed up as a guarantee.
 */
async function network(page: Page): Promise<Network> {
  const net: Network = {
    archives: { terrain: { full: 0, ranges: 0 }, contours: { full: 0, ranges: 0 } },
    egress: [],
    archivesRefused: [],
    archivesBlocked: false,
  };

  await page.route("**/*", async (route) => {
    const url = route.request().url();
    if (!isAllowed(url)) {
      net.egress.push(url);
      await route.abort("blockedbyclient");
      return;
    }
    const archive = archiveOf(url);
    if (archive !== undefined && net.archivesBlocked) {
      net.archivesRefused.push(url);
      await route.abort("blockedbyclient");
      return;
    }
    if (archive !== undefined) {
      // A `Range` header is what separates the renderer reading an archive from `download()`
      // copying one. Classified here, at the wire, rather than inferred from which phase is
      // running — the phases overlap in time and the wire does not lie about the header.
      if (route.request().headers()["range"] === undefined) net.archives[archive].full += 1;
      else net.archives[archive].ranges += 1;
    }
    await route.continue();
  });

  return net;
}

/**
 * What `/lab` publishes on `#status`. A `DOMStringMap` has no required keys, so every read is
 * `string | undefined` — which is accurate: a phase that published nothing must not read as one
 * that published an empty string.
 */
type LabStatus = Record<string, string | undefined>;

/**
 * Wait for `/lab` to reach one of its two terminal states, and refuse the failed one.
 *
 * **Both markers, in one wait.** `/lab` publishes `data-failed` when the offline step or the
 * mount throws, and nothing else is published after that — so a wait on the success marker alone
 * hangs to its timeout on every genuine failure. That matters most for the trap this plan names
 * by name: cut the network *before* the download rather than after, and the download rejects,
 * `data-assembled` never arrives, and the run reads as a slow machine rather than as a scenario
 * set up backwards. One home for the rule, called from both waits below.
 */
async function reachStatus(page: Page, ready: string): Promise<LabStatus> {
  await page.waitForSelector(`#status[${ready}], #status[data-failed="true"]`, {
    timeout: 120_000,
  });
  const dataset = await page.evaluate(() => ({
    ...document.querySelector<HTMLElement>("#status")!.dataset,
  }));
  if (dataset["failed"] === "true") {
    throw new Error(`/lab failed before reaching [${ready}]: ${await page.innerText("#status")}`);
  }
  return dataset;
}

/** The status element's dataset, once the offline step has published it. */
const offlineStatus = (page: Page): Promise<LabStatus> => reachStatus(page, "data-offline");

/**
 * Navigate, and wait only as far as the offline step.
 *
 * Split out from {@link openLab} so the download's evidence can be read *before* the map mounts.
 * `/lab` publishes `data-offline` when `runLabOffline` resolves and calls `mountLab` only after
 * that, so every request the download made is already recorded here — and no range read from
 * rendering has necessarily happened yet. The header classification above makes the counts
 * unambiguous either way; this makes the ordering explicit as well as the kind.
 */
async function beginLab(page: Page, url: string): Promise<LabStatus> {
  await page.goto(url, { waitUntil: "load" });
  return reachStatus(page, "data-offline");
}

/**
 * Finish what {@link beginLab} started: wait for the mount, then for the map to stop drawing.
 *
 * The same waits `lab.e2e.ts` uses, and for the same reason: `data-assembled` is the
 * producer/controller boundary and fires before MapLibre installs a source, a canvas existing
 * says only that a WebGL context was created, and bytes arriving is not paint either.
 */
async function finishLab(page: Page): Promise<SettledRender> {
  await reachStatus(page, 'data-assembled="true"');
  await page.waitForFunction(() => document.querySelectorAll("#map canvas").length > 0, undefined, {
    timeout: 30_000,
  });
  return settleRender(mapOf(page));
}

/** Both halves, for the phases that have nothing to read in between. */
async function openLab(page: Page, url: string): Promise<SettledRender> {
  await beginLab(page, url);
  return finishLab(page);
}

test.beforeEach(({ page }) => {
  watchConsole(page);
});

test.afterEach(({ page }) => {
  expect(consoleFor(page).problems()).toEqual([]);
});

test("a downloaded region renders with the archive host cut, and a deleted one does not", async ({
  page,
}) => {
  const net = await network(page);

  // MapLibre reports a source it cannot reach, and both later phases cut the archive host on
  // purpose. Declared **before** the requests, since the watch matches against the declarations
  // standing when a line arrives — and declared rather than ignored, so a phase that produced
  // *no* such error would fail here instead of passing quietly.
  consoleFor(page).expect(
    /ERR_BLOCKED_BY_CLIENT|AJAXError|Failed to fetch|NetworkError/,
    "the last two phases cut the archive host off on purpose, and MapLibre reports the refusal",
  );

  // ── Phase 1. Download, with the network up. The precondition, asserted rather than inferred.
  //
  // The abort goes on **after** this, which is the ordering the plan names — install it first
  // and the app never boots, and the scenario passes for the wrong reason. And this phase is
  // asserted on its own evidence: that the app booted, that the archives were actually fetched,
  // and that the manifest records both sources. Inferring any of it later from "the abort fired"
  // would be reading the instrument instead of the subject.
  const downloaded = await beginLab(page, labUrl("download"));
  // Read **here**, between the offline step and the mount, so the map's own range reads cannot
  // be mistaken for the copy. The header split makes that unambiguous anyway; taking the
  // snapshot at this point makes the ordering evidence too, rather than a claim about it.
  const copied = snapshot(net);

  expect(downloaded["regions"], "the store holds no region after downloading one").toBe("1");
  expect(downloaded["regionId"], "the region has no id").toBeTruthy();
  expect(
    Number(downloaded["regionBytes"] ?? "0"),
    "the manifest records no bytes, so nothing was stored",
  ).toBeGreaterThan(0);
  // Named explicitly, because the published default is "all base+overlay" and would have
  // omitted the DEM — the exact thing T6.1's criterion is about (ADR-0034).
  expect(downloaded["regionSources"], "the region does not name both fixture sources").toBe(
    SOURCE_IDS,
  );
  // **Per archive, and whole-archive GETs only.** A single total lets terrain's traffic vouch
  // for contours, and counting range reads lets the render that follows vouch for a copy that
  // never happened — which is the shape this assertion had before, and it was vacuous.
  for (const archive of ["terrain", "contours"] as const) {
    expect(
      copied[archive].full,
      `${archive}: never copied whole, so there was nothing to store`,
    ).toBeGreaterThan(0);
  }

  // The rest of this load: the map mounts and reads the archives it just copied, over the wire,
  // because nothing has installed them locally yet. Waited out rather than skipped — those reads
  // must not still be in flight when the host goes down below.
  await finishLab(page);

  // ── Phase 2. The archive host goes down. Everything below runs with it cut.
  net.archivesBlocked = true;
  const beforeOffline = snapshot(net);

  // ── Phase 3. A fresh realm, the region installed, and the map drawn from local bytes.
  const offline = await openLab(page, labUrl("use"));
  const installed = await offlineStatus(page);

  expect(installed["served"], "no archive url was served from local bytes").toBe(
    `${TERRAIN},${CONTOURS}`,
  );
  // Corroboration, **not** the oracle: it says the bytes did not come over the wire, which is
  // not the same as saying where they did come from. The rendered-state comparison below is
  // what carries the claim.
  expect(
    snapshot(net),
    "an archive reached the network while the host was supposed to be cut",
  ).toEqual(beforeOffline);

  // ── Phase 4. The region deleted, then a fresh render — a new realm, so no registration and
  //    no promise cache from phase 3 can answer for the bytes that are now gone.
  await openLab(page, labUrl("delete"));
  expect((await offlineStatus(page))["regions"], "the region survived deletion").toBe("0");

  const deleted = await openLab(page, labUrl("use"));
  expect((await offlineStatus(page))["served"], "something was still served after deletion").toBe(
    "",
  );

  // ── The control. `offline=off` with the archive host still cut: the archives are declared,
  //    unreachable, and no region has ever existed in this realm. It is the picture the map
  //    draws when the archives contribute nothing.
  const never = await openLab(page, labUrl("off"));

  // Same box in every capture, so every difference below is content rather than framing.
  for (const [name, settled] of Object.entries({ deleted, never })) {
    expect(pngSize(settled.image), `${name} frames a different box`).toEqual(
      pngSize(offline.image),
    );
  }

  // **Rendered state, both ways round.** The region put something on screen that the cut
  // network cannot supply; and once deleted, the map falls back to exactly the picture it draws
  // with no region at all. Either assertion alone is weak — the first would hold if the two
  // renders merely differed by noise, and the second would hold if nothing ever rendered.
  expect(
    offline.image.equals(deleted.image),
    "deleting the region changed nothing on screen: the map was never drawing from it",
  ).toBe(false);
  expect(
    deleted.image.equals(never.image),
    "with the region deleted the map still drew something a region-less load does not",
  ).toBe(true);

  // Recorded, not asserted — a threshold here would be a guess about this machine.
  for (const [name, settled] of Object.entries({ offline, deleted, never })) {
    console.log(
      `settled ${name}: ${String(settled.captures)} captures / ${String(settled.elapsedMs)} ms`,
    );
  }

  // No HTTP request left the fixture's own servers. Sockets are not this file's claim — see the
  // guard's note above, and `lab.e2e.ts`, which guards and falsifies both seams.
  expect(net.egress, `unexpected egress: ${net.egress.join(", ")}`).toEqual([]);
  // And the archive cut was real: the last three phases asked for archives and were refused.
  expect(
    net.archivesRefused.length,
    "the archive host was never actually asked for anything, so the cut proved nothing",
  ).toBeGreaterThan(0);
});
