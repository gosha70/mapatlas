// SPDX-License-Identifier: Apache-2.0

/**
 * Cuts the synthetic archives the browser scenarios render (T4.6; basemap added by T7.1 4b).
 *
 * **Three files, two consumers.** The terrain/contour pair is `/lab`'s and is unchanged — its
 * route, stack and scenarios still see exactly those two. The basemap is the *root route's*, for
 * the online test that the demo declares and draws a third source; `/lab` neither declares nor
 * reads it. These files are lab-named because they predate the demo having archives of its own.
 *
 * **The real pipeline, minus the network.** Every stage downstream of the source is the one the
 * production build uses — `stitchSurface`'s output shape, `renderTerrariumTile`, `encodePng`,
 * `traceContours`, `contourTiles`, `writeArchive`. Only the elevation is synthetic, so the
 * browser reads archives a conforming writer produced rather than a stub shaped to be readable.
 *
 * It writes to a temporary directory and returns the paths. Nothing is tracked: `CLAUDE.md`
 * forbids map tiles in the repository, and browser CI must reach no network.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import geojsonvt from "geojson-vt";
import vtpbf from "vt-pbf";

import { writeArchive } from "../../scripts/fixture/archive.mjs";
import {
  BUFFER,
  EXTENT,
  contourTiles,
  levelsFor,
  traceContours,
} from "../../scripts/fixture/contour.mjs";
import { TILE_SIZE, productionEnvelope, tilesInRange } from "../../scripts/fixture/mercator.mjs";
import { encodePng } from "../../scripts/fixture/png.mjs";
import { renderTerrariumTile } from "../../scripts/fixture/resample.mjs";
import { SOURCE_SAMPLE_SPACING_DEG } from "../../scripts/fixture/source.mjs";

/**
 * A synthetic elevation surface over the production envelope.
 *
 * A dome rather than a plane: a plane's contours are parallel straight lines, which render
 * identically whether or not the tiler placed them correctly, while a dome's are closed rings at
 * radii the level determines. The terrain is alpine-plausible so the hillshade has relief to
 * shade — a flat DEM shades to a uniform grey and would look like a working hillshade layer.
 */
function syntheticSurface(envelope) {
  const scale = SOURCE_SAMPLE_SPACING_DEG;
  const [west, south, east, north] = envelope;
  const width = Math.round((east - west) / scale);
  const height = Math.round((north - south) / scale);
  const elevationsM = new Float32Array(width * height);
  const peak = 4800;
  const centreLon = (west + east) / 2;
  const centreLat = (south + north) / 2;
  const falloff = 3.5e5;
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      const lon = west + col * scale;
      const lat = north - row * scale;
      const r2 = (lon - centreLon) ** 2 + (lat - centreLat) ** 2;
      elevationsM[row * width + col] = peak - falloff * r2;
    }
  }
  return { width, height, west, north, pixelScaleDeg: scale, elevationsM };
}

/**
 * Build the archives: `/lab`'s terrain and contour pair, and the root route's basemap.
 *
 * @param {{ bounds: number[], minZoom: number, maxZoom: number, contourIntervalM: number }} region
 * @returns {Promise<{
 *   dir: string,
 *   terrainPath: string, contourPath: string, basemapPath: string,
 *   terrainTiles: number, contourTiles: number, basemapTiles: number,
 * }>}
 */
export async function buildLabArchives(region) {
  const dir = mkdtempSync(join(tmpdir(), "mapatlas-lab-"));
  const envelope = productionEnvelope(
    region.bounds,
    region.minZoom,
    region.maxZoom,
    SOURCE_SAMPLE_SPACING_DEG,
  );
  const surface = syntheticSurface(envelope);
  const addresses = [...tilesInRange(region.bounds, region.minZoom, region.maxZoom)];

  const rasterTiles = addresses.map(({ z, x, y }) => ({
    z,
    x,
    y,
    bytes: encodePng(TILE_SIZE, TILE_SIZE, renderTerrariumTile(surface, z, x, y)),
  }));

  let lowest = Infinity;
  let highest = -Infinity;
  for (const value of surface.elevationsM) {
    if (value < lowest) lowest = value;
    if (value > highest) highest = value;
  }
  const vectorTiles = contourTiles(
    traceContours(surface, levelsFor(lowest, highest, region.contourIntervalM)),
    addresses,
  );
  if (vectorTiles.length === 0) {
    throw new Error("the synthetic surface produced no contour tiles, so the layer would be empty");
  }

  const metadata = {
    name: "lab-fixture",
    bounds: region.bounds,
    minzoom: region.minZoom,
    maxzoom: region.maxZoom,
  };
  const terrainPath = join(dir, "terrain.pmtiles");
  const contourPath = join(dir, "contours.pmtiles");
  await writeArchive(terrainPath, rasterTiles, metadata, { tileType: "png", compression: "none" });
  await writeArchive(contourPath, vectorTiles, metadata, { tileType: "mvt", compression: "gzip" });

  const { path: basemapPath, tiles: basemapTiles } = await buildBasemapArchive(region, dir);

  // A manifest beside them, so the scenario reads paths rather than recomputing a temp name.
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({ terrainPath, contourPath, basemapPath }, null, 2),
  );
  return {
    dir,
    terrainPath,
    contourPath,
    basemapPath,
    terrainTiles: rasterTiles.length,
    contourTiles: vectorTiles.length,
    basemapTiles,
  };
}

/**
 * Cut the basemap on its own, into a directory the caller names.
 *
 * **Exported because a second lane needs this archive and not the other two.** The
 * getting-started example declares one vector source, and its browser lane serves an archive at
 * the path the example points at — the source the lane cut for itself, in place of the map data
 * the reader is told to bring. Building the terrain and contour pair for it would cost a DEM
 * render and a contour trace that nothing in that lane reads.
 *
 * @param {{ bounds: number[], minZoom: number, maxZoom: number }} region
 * @param {string} dir where to write `basemap.pmtiles`
 * @returns {Promise<{ path: string, tiles: number }>}
 */
export async function buildBasemapArchive(region, dir) {
  const addresses = [...tilesInRange(region.bounds, region.minZoom, region.maxZoom)];
  const path = join(dir, "basemap.pmtiles");
  const tiles = syntheticBasemapTiles(region, addresses);
  await writeArchive(
    path,
    tiles,
    {
      name: "synthetic-basemap",
      bounds: region.bounds,
      minzoom: region.minZoom,
      maxzoom: region.maxZoom,
    },
    { tileType: "mvt", compression: "none" },
  );
  return { path, tiles: tiles.length };
}

/**
 * A synthetic basemap, cut with the same tooling the contour layer uses.
 *
 * **Not the real extract, and deliberately so.** `build/fixture/basemap.pmtiles` is cut from a
 * 137 GB pinned upstream over the network; a browser lane that needed it could not run in CI.
 * What the lane has to prove is that the *demo* declares the source, that MapLibre parses the
 * archive and asks for its tiles, and that something is drawn from them — none of which depends
 * on the tiles being Protomaps'.
 *
 * **The layer names are the contract.** They are the ones `sources.ts` writes `source-layer`
 * against, so a demo that renamed a layer would draw nothing here. Geometry is trivial: a filled
 * rectangle over the region for `earth` and `landuse`, a smaller one for `water`, and a diagonal
 * for `roads` — enough that each declared layer has something to render, which is what
 * distinguishes "the source was declared" from "the source drew".
 */
function syntheticBasemapTiles(region, addresses) {
  const [west, south, east, north] = region.bounds;
  const inset = (f) => [
    west + (east - west) * f,
    south + (north - south) * f,
    east - (east - west) * f,
    north - (north - south) * f,
  ];
  const box = (bounds) => {
    const [w, s, e, n] = bounds;
    return {
      type: "Feature",
      properties: { kind: "synthetic" },
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [w, s],
            [e, s],
            [e, n],
            [w, n],
            [w, s],
          ],
        ],
      },
    };
  };
  const layers = {
    earth: [box(region.bounds)],
    landuse: [box(inset(0.1))],
    water: [box(inset(0.3))],
    roads: [
      {
        type: "Feature",
        properties: { kind: "synthetic" },
        geometry: {
          type: "LineString",
          coordinates: [
            [west, south],
            [east, north],
          ],
        },
      },
    ],
  };

  const wanted = [...addresses];
  const maxZoom = Math.max(...wanted.map((a) => a.z));
  const indexes = Object.fromEntries(
    Object.entries(layers).map(([name, features]) => [
      name,
      geojsonvt(
        { type: "FeatureCollection", features },
        { extent: EXTENT, buffer: BUFFER, tolerance: 3, maxZoom, indexMaxZoom: maxZoom },
      ),
    ]),
  );

  const tiles = [];
  for (const { z, x, y } of wanted) {
    const cut = {};
    for (const [name, index] of Object.entries(indexes)) {
      const tile = index.getTile(z, x, y);
      if (tile !== null && tile.features.length > 0) cut[name] = tile;
    }
    if (Object.keys(cut).length === 0) continue;
    tiles.push({ z, x, y, bytes: new Uint8Array(vtpbf.fromGeojsonVt(cut, { version: 2 })) });
  }
  if (tiles.length === 0) {
    throw new Error("the synthetic basemap produced no tiles, so the layers would be empty");
  }
  return tiles;
}
