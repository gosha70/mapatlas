// SPDX-License-Identifier: Apache-2.0
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

import { consoleFor, watchConsole } from "./fixtures/browser.js";
import { countColour } from "./fixtures/pixels.js";
import { settleRender } from "./fixtures/rendered.js";

/**
 * The demo's own offline claim (T7.1 increment 5b): **the bytes the renderer draws with the
 * archive host cut off are the bytes the download stored.**
 *
 * **Why "zero archive requests" is not the oracle.** ADR-0035 keeps the archive under its own
 * url offline — the protocol resolves that url to a stored `Blob` instead of the network — so a
 * map that made no archive request looks identical to a map that never asked for a tile at all.
 * A blank canvas, a camera over open ocean, a source stack that failed to build: each produces
 * zero requests and would pass a request-counting test. The claim therefore needs **both halves**
 * at once: nothing came over the wire, *and* something specific to the basemap was drawn.
 *
 * The drawn half is a named colour rather than a difference between renders. Requiring two
 * screenshots to differ is satisfied by antialiasing noise, and an earlier version of that oracle
 * survived renaming every `source-layer` so the basemap drew nothing. The demo paints its
 * basemap's `water` layer `#b3cde0` and nothing else on this map paints it, so its presence is
 * that layer having found geometry through the production PMTiles registration.
 */

test.use({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });

const DEMO = "http://127.0.0.1:5175";
const ARCHIVES = "http://127.0.0.1:5176";
const ARCHIVE_FILES = ["terrain.pmtiles", "contours.pmtiles", "basemap.pmtiles"] as const;
type Archive = (typeof ARCHIVE_FILES)[number];

/** The demo's own water fill — `apps/demo/src/app/sources.ts` paints the basemap's `water` with it. */
const WATER_FILL: readonly [number, number, number] = [0xb3, 0xcd, 0xe0];

const url = () =>
  `${DEMO}/?terrain=${encodeURIComponent(`${ARCHIVES}/terrain.pmtiles`)}` +
  `&contours=${encodeURIComponent(`${ARCHIVES}/contours.pmtiles`)}` +
  `&basemap=${encodeURIComponent(`${ARCHIVES}/basemap.pmtiles`)}`;

const appMap = (page: Page) => page.locator("#app-map");

interface Reads {
  /** Whole-object GETs — what `download()` makes when it copies an archive. */
  full: number;
  /** Range reads from byte 0 — opening the archive. A *declared* source produces these even
   *  when no layer draws it, so they prove resolvability and not participation. */
  header: number;
  /** Range reads starting past byte 0 — a leaf directory or a tile something actually wanted.
   *  Unforgeable: the offset came from the archive's own header, so it cannot be issued without
   *  having parsed it, and nothing issues one unless a layer needs the data. */
  beyondHeader: number;
}

interface Network {
  archives: Record<Archive, Reads>;
  /** Archive requests refused while the host was cut. */
  refused: string[];
  blocked: boolean;
}

const archiveOf = (target: string): Archive | undefined =>
  ARCHIVE_FILES.find((file) => target.startsWith(`${ARCHIVES}/${file}`));

/**
 * Count what each archive was asked for, **per archive and split by kind**.
 *
 * Per archive because one archive's traffic must never vouch for another's: a download that
 * copied two of three would otherwise pass on a single total. Split by kind because a whole
 * object GET is `download()` copying, while a range read is the renderer reading over the wire —
 * and the whole point below is that after the download there are none of the latter.
 */
async function network(page: Page): Promise<Network> {
  const net: Network = {
    archives: {
      "terrain.pmtiles": { full: 0, header: 0, beyondHeader: 0 },
      "contours.pmtiles": { full: 0, header: 0, beyondHeader: 0 },
      "basemap.pmtiles": { full: 0, header: 0, beyondHeader: 0 },
    },
    refused: [],
    blocked: false,
  };

  await page.route("**/*", async (route) => {
    const target = route.request().url();
    const archive = archiveOf(target);
    if (archive === undefined) {
      // The demo's own origin serves the application and no map bytes. Cutting it would take the
      // document with it, and a fresh realm is not negotiable here.
      await route.continue();
      return;
    }
    if (net.blocked) {
      net.refused.push(target);
      await route.abort("blockedbyclient");
      return;
    }
    const range = route.request().headers()["range"];
    if (range === undefined) {
      net.archives[archive].full += 1;
    } else {
      const match = /^bytes=(\d+)-/.exec(range.trim());
      // An unrecognised Range is not quietly counted as byte 0: that would let it vouch for
      // content it never carried.
      if (match === null) throw new Error(`unrecognised Range header: ${range}`);
      if (Number(match[1]) === 0) net.archives[archive].header += 1;
      else net.archives[archive].beyondHeader += 1;
    }
    await route.continue();
  });
  return net;
}

const snapshot = (net: Network): Record<Archive, Reads> => ({
  "terrain.pmtiles": { ...net.archives["terrain.pmtiles"] },
  "contours.pmtiles": { ...net.archives["contours.pmtiles"] },
  "basemap.pmtiles": { ...net.archives["basemap.pmtiles"] },
});

/** Load the demo and wait for the shell to finish installing whatever is stored. */
async function open(page: Page): Promise<void> {
  await page.goto(url());
  await expect(page.locator("#shell-status")).toHaveAttribute("data-status", "ready");
}

const waterPixels = async (page: Page): Promise<number> => {
  await settleRender(appMap(page));
  return countColour(await appMap(page).locator("canvas").screenshot(), WATER_FILL);
};

test("a downloaded region draws with the archive host cut, and a deleted one does not", async ({
  page,
}) => {
  const net = await network(page);
  const console_ = watchConsole(page);
  // The last phases cut the host on purpose and MapLibre reports the refusal. Declared rather
  // than ignored, so a phase producing *no* such error fails here instead of passing quietly.
  console_.expect(
    /ERR_BLOCKED_BY_CLIENT|AJAXError|Failed to fetch|NetworkError/,
    "the archive host is cut on purpose in the later phases",
  );

  // ── Phase 1. Download, with the network up. Asserted on its own evidence.
  await open(page);
  await expect(page.locator("#offline-status")).toHaveAttribute("data-regions", "0");

  await page.locator("#offline-download").click();
  await expect(page.locator("#offline-status")).toHaveAttribute("data-regions", "1", {
    timeout: 30_000,
  });
  const copied = snapshot(net);

  // **Whole-copy precondition, per archive.** A region naming three sources whose manifest lists
  // three ids proves nothing about bytes: `installOfflineArchives` never reads the blobs, so a
  // download that copied two of three lists identically. The wire is what distinguishes them.
  for (const archive of ARCHIVE_FILES) {
    expect(
      copied[archive].full,
      `${archive}: never copied whole, so nothing was stored`,
    ).toBeGreaterThan(0);
  }
  await expect(page.locator("#offline-status")).toHaveAttribute(
    "data-stored",
    "demo-basemap,demo-contours,demo-terrain",
  );

  // ── Phase 2. The archive host goes down, and the document is replaced.
  //
  // A fresh realm is not optional: the PMTiles protocol is realm-scoped and offers no way to
  // unregister (ADR-0036), and a `PMTiles` instance carries its own promise cache. Re-mounting in
  // the same realm would leave the first render's registration standing with a warm cache, so the
  // map would draw from tiles it had already decoded and the test would prove nothing.
  net.blocked = true;
  await open(page);

  const offlineWater = await waterPixels(page);

  // **Both halves, and neither alone.** Nothing came over the wire *and* the basemap's own layer
  // painted — a map that failed to build its stack would satisfy the first and not the second.
  /**
   * **Per archive, all three.** The demo draws three independent contributions — the basemap's
   * fills, the DEM's hillshade and the contour lines — and ADR-0034 exists because the DEM is the
   * one a defaulted region silently omits. Checking only the basemap would let a terrain or
   * contour archive fall back to the network, or stop participating entirely, with everything
   * green.
   */
  for (const archive of ARCHIVE_FILES) {
    expect(
      net.refused.filter((target) => archiveOf(target) === archive).length,
      `${archive} was requested over the network, so it was not served from the store`,
    ).toBe(0);
  }
  expect(
    offlineWater,
    "with the host cut, the basemap's water layer painted nothing — the stored bytes did not reach the renderer",
  ).toBeGreaterThan(100);

  // ── Phase 3. Delete, then a fresh document with the host still cut.
  net.blocked = false;
  await open(page);
  await page.locator("#offline-delete").click();
  await expect(page.locator("#offline-status")).toHaveAttribute("data-regions", "0");
  await expect(page.locator("#offline-deleted")).toBeVisible();

  net.blocked = true;
  await open(page);

  expect(
    await waterPixels(page),
    "the basemap still painted after its region was deleted, so the render was not coming from the store",
  ).toBe(0);

  expect(consoleFor(page).problems()).toEqual([]);
});

test("every declared archive contributes, and none is reached when one is stored", async ({
  page,
}) => {
  /**
   * **The control that makes phase 2's per-archive silence mean anything.**
   *
   * Phase 2 asserts zero network reads per archive once a region is stored. On its own that is
   * satisfied by an archive nothing ever wanted — a source declared but drawn by no layer makes
   * no reads in either phase, and the assertion passes for exactly the wrong reason. ADR-0034
   * names this failure for the DEM specifically, whose `hillshade` role a defaulted region omits.
   *
   * So participation is established **with the host up**, where it can be: a range read starting
   * past byte 0 is a leaf directory or a tile something asked for, and it cannot be issued
   * without having parsed the archive's own header. A read *from* byte 0 is only the archive
   * being opened, which a declared-but-undrawn source also produces — which is why the count
   * below is `beyondHeader` and not "was requested".
   */
  const net = await network(page);
  watchConsole(page);

  await open(page);
  await settleRender(appMap(page));

  await expect(page.locator("#offline-status")).toHaveAttribute("data-regions", "0");
  for (const archive of ARCHIVE_FILES) {
    expect(
      net.archives[archive].beyondHeader,
      `${archive} was opened but never read for content — nothing on this map draws from it`,
    ).toBeGreaterThan(0);
  }

  // And with the host cut and still nothing stored, the basemap's own contribution is absent —
  // the negative half, so "water appears offline" in phase 2 is attributable to the download.
  consoleFor(page).expect(
    /ERR_BLOCKED_BY_CLIENT|AJAXError|Failed to fetch|NetworkError/,
    "the archive host is cut for the second half of this scenario",
  );
  net.blocked = true;
  await open(page);

  expect(
    await waterPixels(page),
    "the basemap painted without ever having been downloaded or reachable",
  ).toBe(0);
});
