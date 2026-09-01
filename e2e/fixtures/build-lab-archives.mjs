// SPDX-License-Identifier: Apache-2.0

/**
 * Cuts the synthetic archive pair the browser scenario renders (T4.6).
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

import { writeArchive } from "../../scripts/fixture/archive.mjs";
import { contourTiles, levelsFor, traceContours } from "../../scripts/fixture/contour.mjs";
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
 * Build both archives.
 *
 * @param {{ bounds: number[], minZoom: number, maxZoom: number, contourIntervalM: number }} region
 * @returns {Promise<{ dir: string, terrainPath: string, contourPath: string, terrainTiles: number, contourTiles: number }>}
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

  // A manifest beside them, so the scenario reads paths rather than recomputing a temp name.
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ terrainPath, contourPath }, null, 2));
  return {
    dir,
    terrainPath,
    contourPath,
    terrainTiles: rasterTiles.length,
    contourTiles: vectorTiles.length,
  };
}
