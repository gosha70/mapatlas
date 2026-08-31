// SPDX-License-Identifier: Apache-2.0

/**
 * Contour generation for the fixture's vector layer (T4.6, ADR-0024 criterion 4).
 *
 * The engine only *styles* contours — `styleLayers` is an opaque passthrough (ADR-0011) — so the
 * geometry is generated here: trace isolines over the decoded elevation surface, tile them, and
 * emit MVT.
 *
 * **This is a separate archive from the terrain, and structurally must be** (ADR-0025). PMTiles
 * v3 carries one archive-level tile type and one archive-level compression, so PNG rasters and
 * MVT vectors cannot share a conforming archive at all.
 *
 * **`d3-contour`'s grid space is offset by half a cell from the sample lattice**, and that is the
 * one thing in this file that will silently ruin the output. A crossing that belongs at sample
 * index 1.5 comes back as 2.0 — measured, not read off documentation. Ignoring it shifts every
 * contour half a sample north-west: a perfectly plausible layer, slightly and uniformly wrong,
 * which no amount of looking at a map would reveal.
 *
 * Rings become **LineStrings**, one per ring. `d3-contour` returns filled MultiPolygons — regions
 * at or above a level — and a contour layer is a set of lines. Keeping the polygons would make
 * the fill look meaningful and would leave a consumer styling a `fill` layer it should not have.
 * The ring coordinates are unchanged either way, so the closed-loop property the toolchain was
 * evaluated against is preserved.
 */

import { contours as d3Contours } from "d3-contour";
import geojsonvt from "geojson-vt";
import vtpbf from "vt-pbf";

/**
 * How far `d3-contour`'s coordinates sit from the sample lattice, in samples.
 *
 * Measured on a 5×5 grid of `value = 10·x` at threshold 15: the crossing belongs between samples
 * 1 and 2, at index 1.5, and `d3-contour` reports it at 2.0.
 */
export const D3_GRID_OFFSET_SAMPLES = 0.5;

/** The layer name contours are written under, shared by the tiler and any consumer's style. */
export const CONTOUR_LAYER = "contours";

/** MVT coordinate resolution per tile, and the render buffer beyond its edge, in those units. */
export const EXTENT = 4096;
export const BUFFER = 64;

export class ContourError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "ContourError";
  }
}

/**
 * Trace isolines over an elevation grid.
 *
 * @param {import("./resample.mjs").ElevationGrid} grid
 * @param {number[]} levels Elevations to trace, in metres.
 * @returns {{ type: "FeatureCollection", features: object[] }} lon/lat LineStrings.
 */
export function traceContours(grid, levels) {
  if (!Array.isArray(levels) || levels.length === 0) {
    throw new ContourError("at least one contour level is required");
  }
  for (const level of levels) {
    if (!Number.isFinite(level)) {
      throw new ContourError(`contour levels must be finite metres, got ${String(level)}`);
    }
  }

  const traced = d3Contours()
    .size([grid.width, grid.height])
    .thresholds([...levels].sort((a, b) => a - b))(grid.elevationsM);

  const toLonLat = ([x, y]) => [
    grid.west + (x - D3_GRID_OFFSET_SAMPLES) * grid.pixelScaleDeg,
    grid.north - (y - D3_GRID_OFFSET_SAMPLES) * grid.pixelScaleDeg,
  ];

  const features = [];
  for (const band of traced) {
    for (const polygon of band.coordinates) {
      for (const ring of polygon) {
        for (const run of interiorRuns(ring, grid.width, grid.height)) {
          features.push({
            type: "Feature",
            // The elevation is the feature's identity. Anything downstream that needs to know
            // which contour a line is must read this rather than measure the geometry —
            // measuring is how the earlier probe produced five false failures in a row.
            properties: { elevation: band.value },
            geometry: { type: "LineString", coordinates: run.map(toLonLat) },
          });
        }
      }
    }
  }
  return { type: "FeatureCollection", features };
}

/**
 * The levels a range spans at a given interval, on multiples of the interval.
 *
 * Anchored to multiples rather than to the terrain's own minimum, so the same interval produces
 * the same elevations whatever region it is applied to — a 2,600 m line is a 2,600 m line
 * everywhere, and two adjacent fixtures do not disagree about where their contours are.
 *
 * @param {number} lowestM
 * @param {number} highestM
 * @param {number} intervalM
 * @returns {number[]}
 */
export function levelsFor(lowestM, highestM, intervalM) {
  if (!(intervalM > 0) || !Number.isFinite(intervalM)) {
    throw new ContourError(
      `contour interval must be a positive number of metres, got ${String(intervalM)}`,
    );
  }
  // Inverted bounds are a caller mistake; a range too narrow to contain a multiple is a fact
  // about the terrain. The first throws, the second returns nothing — this answers *which levels
  // a range contains*, and "none" is a real answer to that. Whether a fixture with no contours is
  // acceptable is the build's judgement, and making it here would put a policy inside a query.
  if (highestM < lowestM) {
    throw new ContourError(`contour range is inverted: ${String(lowestM)}..${String(highestM)} m`);
  }
  const levels = [];
  for (
    let level = Math.ceil(lowestM / intervalM) * intervalM;
    level < highestM;
    level += intervalM
  ) {
    levels.push(level);
  }
  return levels;
}

/**
 * Tile a contour collection into MVT.
 *
 * @param {{ type: string, features: object[] }} collection
 * @param {Iterable<{ z: number, x: number, y: number }>} addresses
 * @returns {Array<{ z: number, x: number, y: number, bytes: Uint8Array }>}
 *   Only addresses that carry at least one feature; an empty tile is **not** written, so it
 *   reads back as absent rather than as a tile carrying nothing.
 */
export function contourTiles(collection, addresses) {
  // Materialised once. `tilesInRange` is a generator, and this needs the addresses twice — for
  // the index's maximum zoom and then to cut each tile. Iterating a generator a second time
  // yields nothing, so the whole layer would come back empty with no error anywhere.
  const wanted = [...addresses];
  if (wanted.length === 0) throw new ContourError("no tile addresses to cut");
  const maxZoom = Math.max(...wanted.map((a) => a.z));
  const index = geojsonvt(collection, {
    extent: EXTENT,
    buffer: BUFFER,
    // The evaluated defaults. `tolerance` is Douglas–Peucker in tile units; the toolchain was
    // measured at 3 and both recorded bars passed there, so it is pinned rather than tuned.
    tolerance: 3,
    maxZoom,
    indexMaxZoom: maxZoom,
  });

  const tiles = [];
  for (const { z, x, y } of wanted) {
    const tile = index.getTile(z, x, y);
    if (tile === null || tile.features.length === 0) continue;
    tiles.push({
      z,
      x,
      y,
      bytes: new Uint8Array(vtpbf.fromGeojsonVt({ [CONTOUR_LAYER]: tile }, { version: 2 })),
    });
  }
  return tiles;
}

/** How close to the raster's outer edge counts as being on it, in d3 grid units. */
const EDGE_EPSILON = 1e-9;

/**
 * Split a filled-contour ring into the runs that are actually isolines.
 *
 * **`d3-contour` returns regions, not lines.** It treats everything outside the raster as below
 * every threshold, so a region reaching the edge is closed along the edge — and those vertices
 * are placed *on* the boundary rather than at an interpolated crossing. They are an artefact of
 * where the data stops, at whatever elevation the terrain happens to be there.
 *
 * The rule is therefore **per vertex, not per segment**. An earlier version dropped only segments
 * with both ends on the *same* edge, which left the diagonals that cut each raster corner —
 * `(39.5, 0) → (40, 0.5)` has its ends on two different edges and survived. The affine-plane
 * oracle put those vertices 7.6 m off the plane, the full range of the fixture, which is how the
 * distinction was found rather than reasoned about.
 *
 * A ring lying wholly inside the raster touches no boundary and comes back as one closed run,
 * which is what preserves the small-loop property the toolchain was evaluated for. A line that
 * does reach the edge loses its final vertex, which is correct: that is where the data ends, not
 * where the terrain reaches that elevation.
 *
 * @param {Array<[number, number]>} ring
 * @param {number} width
 * @param {number} height
 * @returns {Array<Array<[number, number]>>}
 */
function interiorRuns(ring, width, height) {
  const onEdge = ([x, y]) =>
    Math.abs(x) < EDGE_EPSILON ||
    Math.abs(x - width) < EDGE_EPSILON ||
    Math.abs(y) < EDGE_EPSILON ||
    Math.abs(y - height) < EDGE_EPSILON;

  const closed = ring.length > 1 && ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1];
  const points = closed ? ring.slice(0, -1) : ring;
  if (points.length < 2) return [];
  if (!points.some(onEdge)) return [ring];

  // Walked as a cycle from the first boundary vertex, so a run spanning the ring's own start is
  // not split in two by where the array happens to begin.
  const from = points.findIndex(onEdge);
  const runs = [];
  let current = [];
  for (let i = 1; i <= points.length; i += 1) {
    const point = points[(from + i) % points.length];
    if (onEdge(point)) {
      if (current.length >= 2) runs.push(current);
      current = [];
      continue;
    }
    current.push(point);
  }
  if (current.length >= 2) runs.push(current);
  return runs;
}
