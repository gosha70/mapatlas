// SPDX-License-Identifier: Apache-2.0

/**
 * Web-Mercator addressing for the fixture pyramid (T4.6).
 *
 * Standard slippy-map XYZ, on **pixel centres**: for tile `(z, x, y)`, pixel `(col, row)` is the
 * global pixel centre `(x·256 + col + 0.5, y·256 + row + 0.5)`, inverse-projected to lon/lat and
 * sampled from the geographic source. The half-integer is not a rounding detail — a pixel covers
 * an area and its value belongs at its middle, so dropping it shifts every tile by half a pixel
 * in both axes, which renders as a plausible surface offset from where it belongs.
 *
 * **This module resamples nothing and knows no elevation.** It answers where a pixel is and which
 * source extent a set of tiles needs; interpolation is `resample.mjs`'s.
 *
 * The half-open rule from `requiredTiles` and `cropWindow` continues here: a region's east and
 * south bounds landing exactly on a tile edge do not acquire the neighbouring tile. Three places
 * now share that convention, and they have to agree — they decide, respectively, which source
 * cells are fetched, which samples are read from them, and which output tiles exist.
 */

import { parseBounds } from "./region.mjs";

/** Pixels per tile edge. */
export const TILE_SIZE = 256;

/**
 * How close to an integer tile index counts as landing exactly on the edge.
 *
 * In tile units, so it is independent of zoom. At z12 one tile spans 0.0879°, so this is about
 * 0.01 mm on the ground: some three orders of magnitude above the rounding error of a double at
 * index magnitude 4096, and nine below one tile.
 */
export const TILE_EPSILON = 1e-9;

export class MercatorError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "MercatorError";
  }
}

/** Longitude to fractional tile x. */
export function lonToTileX(lon, zoom) {
  return ((lon + 180) / 360) * 2 ** zoom;
}

/** Latitude to fractional tile y. */
export function latToTileY(lat, zoom) {
  const phi = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2) * 2 ** zoom;
}

/** Fractional tile x to longitude. */
export function tileXToLon(x, zoom) {
  return (x / 2 ** zoom) * 360 - 180;
}

/** Fractional tile y to latitude. */
export function tileYToLat(y, zoom) {
  return (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** zoom))) * 180) / Math.PI;
}

/**
 * The tiles a region covers at one zoom, half-open at the east and south edges.
 *
 * @param {[west: number, south: number, east: number, north: number]} bounds
 * @param {number} zoom
 * @returns {{ minX: number, maxX: number, minY: number, maxY: number }} inclusive indices
 */
export function tileRange(bounds, zoom) {
  if (!Number.isInteger(zoom) || zoom < 0 || zoom > 24) {
    throw new MercatorError(`zoom must be an integer in 0..24, got ${String(zoom)}`);
  }
  // The same validator the region declaration, coverage and the crop share. It also removes the
  // only way this could yield an empty range: with `west < east` guaranteed, a half-open upper
  // edge can step back at most to the tile the lower edge is already in. A guard for that case
  // was written first and removed — no valid box reaches it, so nothing could observe it.
  const [west, south, east, north] = parseBounds(bounds, "tile range");
  // The upper edges step back only when they land *on* a boundary; a bound inside a tile keeps
  // that tile. `Math.floor` alone would take the neighbour whenever the edge is exact.
  const lastIndex = (v) => {
    const nearest = Math.round(v);
    return Math.abs(v - nearest) < TILE_EPSILON ? nearest - 1 : Math.floor(v);
  };
  return {
    minX: Math.floor(lonToTileX(west, zoom)),
    maxX: lastIndex(lonToTileX(east, zoom)),
    minY: Math.floor(latToTileY(north, zoom)),
    maxY: lastIndex(latToTileY(south, zoom)),
  };
}

/**
 * A tile's full geographic footprint.
 *
 * @returns {[west: number, south: number, east: number, north: number]}
 */
export function tileBounds(zoom, x, y) {
  return [
    tileXToLon(x, zoom),
    tileYToLat(y + 1, zoom),
    tileXToLon(x + 1, zoom),
    tileYToLat(y, zoom),
  ];
}

/**
 * The lon/lat a tile pixel's centre falls on.
 *
 * @param {number} zoom
 * @param {number} x
 * @param {number} y
 * @param {number} col 0..255
 * @param {number} row 0..255
 * @returns {{ lon: number, lat: number }}
 */
export function tilePixelCentre(zoom, x, y, col, row) {
  const scale = TILE_SIZE * 2 ** zoom;
  const globalX = x * TILE_SIZE + col + 0.5;
  const globalY = y * TILE_SIZE + row + 0.5;
  return {
    lon: (globalX / scale) * 360 - 180,
    lat: (Math.atan(Math.sinh(Math.PI * (1 - (2 * globalY) / scale))) * 180) / Math.PI,
  };
}

/**
 * Every tile in the fixture pyramid, ascending by zoom then y then x.
 *
 * @param {[west: number, south: number, east: number, north: number]} bounds
 * @param {number} minZoom
 * @param {number} maxZoom
 * @returns {Generator<{ z: number, x: number, y: number }>}
 */
export function* tilesInRange(bounds, minZoom, maxZoom) {
  if (maxZoom < minZoom) {
    throw new MercatorError(`maxZoom ${String(maxZoom)} precedes minZoom ${String(minZoom)}`);
  }
  for (let z = minZoom; z <= maxZoom; z += 1) {
    const { minX, maxX, minY, maxY } = tileRange(bounds, z);
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) yield { z, x, y };
    }
  }
}

/**
 * The source extent the pyramid must actually read.
 *
 * **The distinction this exists for.** The *declared region* is what the consumer asked for and
 * what the archive's bounds advertise. The *production envelope* is the union of the full
 * footprints of every tile that intersects it, expanded by the halo interpolation needs. Output
 * tiles are complete 256×256 rasters, so their pixels outside the declared region are real
 * pixels that need real elevation — and there is no terrarium encoding for absence, so they can
 * be neither filled nor clamped nor omitted. They are read.
 *
 * The envelope is materially wider than the region: at z11 the fixture's eastern tile reaches
 * past 7°E, so the build must cover a source cell the declared region never touches. That is why
 * coverage is computed over this and not over the declaration.
 *
 * @param {[west: number, south: number, east: number, north: number]} bounds
 * @param {number} minZoom
 * @param {number} maxZoom
 * @param {number} haloDeg Source-sample spacing; bilinear needs one sample beyond each edge.
 * @returns {[west: number, south: number, east: number, north: number]}
 */
export function productionEnvelope(bounds, minZoom, maxZoom, haloDeg) {
  if (!(haloDeg >= 0)) {
    throw new MercatorError(
      `halo must be a non-negative number of degrees, got ${String(haloDeg)}`,
    );
  }
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (let z = minZoom; z <= maxZoom; z += 1) {
    const { minX, maxX, minY, maxY } = tileRange(bounds, z);
    const [w, , ,] = tileBounds(z, minX, minY);
    const [, , e] = tileBounds(z, maxX, minY);
    const [, s] = tileBounds(z, minX, maxY);
    const [, , , n] = tileBounds(z, minX, minY);
    west = Math.min(west, w);
    east = Math.max(east, e);
    south = Math.min(south, s);
    north = Math.max(north, n);
  }
  return [
    Math.max(west - haloDeg, -180),
    Math.max(south - haloDeg, -90),
    Math.min(east + haloDeg, 180),
    Math.min(north + haloDeg, 90),
  ];
}
