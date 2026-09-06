// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  DEMO_CAMERA,
  DEMO_REGION,
  demoTerrain,
  demoTileSources,
  readDemoSources,
} from "./sources.js";

const url = (query = ""): URL => new URL(`http://demo.invalid/${query}`);

describe("readDemoSources", () => {
  it("reads both archive locations", () => {
    const read = readDemoSources(
      url("?terrain=https://a.invalid/t.pmtiles&contours=https://a.invalid/c.pmtiles"),
    );
    expect(read.terrainUrl).toBe("https://a.invalid/t.pmtiles");
    expect(read.contourUrl).toBe("https://a.invalid/c.pmtiles");
  });

  it("treats absent archives as absent, not as an error", () => {
    // The state a consumer is in before they have downloaded anything, and the state the route
    // must render in without a build step having run.
    expect(readDemoSources(url())).toEqual({ terrainUrl: undefined, contourUrl: undefined });
  });
});

describe("demoTileSources", () => {
  it("declares nothing when there are no archives", () => {
    expect(demoTileSources(readDemoSources(url()))).toEqual([]);
  });

  it("gives the DEM the hillshade role, so it contributes a drawable layer", () => {
    // `role: "terrain"` contributes no layer — the controller's `terrain` option points at the
    // source — so a DEM declared that way alone is never requested and never drawn. One source
    // drives both, and this is the half that draws.
    const [dem] = demoTileSources({ terrainUrl: "https://a.invalid/t.pmtiles" });

    expect(dem?.role).toBe("hillshade");
    expect(dem?.styleLayers, "the DEM contributes no drawable layer").toHaveLength(1);
  });

  it("marks both archives offline-licensed, since absence would refuse them", () => {
    // ADR-0033: absence refuses. These are cut locally by `npm run fixture:build`, so the flag
    // is true by construction — and if it were ever dropped, `download()` would refuse the
    // region rather than silently fetching from a source whose terms were never checked.
    const tiles = demoTileSources({
      terrainUrl: "https://a.invalid/t.pmtiles",
      contourUrl: "https://a.invalid/c.pmtiles",
    });

    expect(tiles).toHaveLength(2);
    for (const tile of tiles) expect(tile.offlineLicensed, tile.id).toBe(true);
  });

  it("carries the attribution the archives' licence requires, verbatim", () => {
    // The fixture archives are derived works of Copernicus DEM GLO-30 Public (ADR-0024). The
    // attribution is not decoration: dropping it is a licence violation, so it is asserted here
    // rather than left to a reviewer noticing it went missing.
    const tiles = demoTileSources({
      terrainUrl: "https://a.invalid/t.pmtiles",
      contourUrl: "https://a.invalid/c.pmtiles",
    });

    for (const tile of tiles) {
      expect(tile.attribution, tile.id).toContain("Copernicus DEM GLO-30 Public");
      expect(tile.attribution, tile.id).toContain("DLR e.V. and Airbus DS GmbH");
    }
  });

  it("keeps its ids distinct from the lab's, because the two stacks diverge", () => {
    // They look alike today and are scheduled to differ: the basemap increment replaces this
    // stack with a self-hosted extract while `/lab`'s stays cut for its pixel differential.
    const tiles = demoTileSources({
      terrainUrl: "https://a.invalid/t.pmtiles",
      contourUrl: "https://a.invalid/c.pmtiles",
    });

    expect(tiles.map((tile) => tile.id)).toEqual(["demo-terrain", "demo-contours"]);
  });
});

describe("demoTerrain", () => {
  it("raises terrain only when there is a DEM to raise", () => {
    // `TerrainOptions` naming a source that does not exist is a broken style, not a map without
    // terrain — the renderer rejects the stack rather than degrading.
    expect(demoTerrain({})).toBeNull();
    expect(demoTerrain({ terrainUrl: "https://a.invalid/t.pmtiles" })).toEqual({
      sourceId: "demo-terrain",
      exaggeration: 1,
    });
  });

  it("names the source the stack actually declares", () => {
    const [dem] = demoTileSources({ terrainUrl: "https://a.invalid/t.pmtiles" });
    expect(demoTerrain({ terrainUrl: "https://a.invalid/t.pmtiles" })?.sourceId).toBe(dem?.id);
  });
});

describe("the camera opens over the archives", () => {
  /**
   * The region as the **archives** declare it, loaded from the checked-in file.
   *
   * `DEMO_REGION` is a copy the browser bundle needs. Judging the camera against that same copy
   * would let the two drift together: widen the copy, the camera follows it off the coverage,
   * and the check still passes while the map renders blank. The archive declaration is the
   * authority, so the test reads it — the same rule `/lab`'s copy is held to.
   */
  const declared = JSON.parse(
    readFileSync(new URL("../../../../fixtures/vertical/region.json", import.meta.url), "utf8"),
  ) as { bounds: [number, number, number, number]; minZoom: number; maxZoom: number };
  const [west, south, east, north] = declared.bounds;

  it("uses the region the archives were cut for", () => {
    expect([DEMO_REGION.west, DEMO_REGION.south, DEMO_REGION.east, DEMO_REGION.north]).toEqual(
      declared.bounds,
    );
  });

  it("points at ground the archives cover", () => {
    // Outside the bounds there is no terrain and no contour tile, so the map opens on nothing —
    // which looks exactly like a working app that has not finished loading.
    expect(DEMO_CAMERA.center.lng).toBeGreaterThan(west);
    expect(DEMO_CAMERA.center.lng).toBeLessThan(east);
    expect(DEMO_CAMERA.center.lat).toBeGreaterThan(south);
    expect(DEMO_CAMERA.center.lat).toBeLessThan(north);
  });

  it("opens at a zoom the archives carry", () => {
    // A camera below `minZoom` or above `maxZoom` asks for tiles the archive does not hold. The
    // failure is silent: PMTiles answers "no such tile" and MapLibre draws the background.
    expect(DEMO_CAMERA.zoom).toBeGreaterThanOrEqual(declared.minZoom);
    expect(DEMO_CAMERA.zoom).toBeLessThanOrEqual(declared.maxZoom);
  });
});
