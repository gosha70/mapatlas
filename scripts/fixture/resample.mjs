// SPDX-License-Identifier: Apache-2.0

/**
 * Resampling the geographic source onto the Web-Mercator pyramid (T4.6).
 *
 * **The contract is an ordering, and the ordering is the whole point:**
 *
 * ```
 * source encoded bytes -> decode to metres -> bilinear interpolate -> encode as terrarium
 * ```
 *
 * Terrarium channels are **never** interpolated, and this module is arranged so that they
 * cannot be rather than merely should not be: {@link decodeGrid} is the only door in, and
 * everything past it holds `Float32Array` metres with no bytes in sight. The encoding packs a
 * value across three channels with carries between them, so a per-channel average is not the
 * average of the elevations — and it is a perfectly well-formed colour, which is why the mistake
 * renders as terrain instead of failing.
 *
 * Bilinear rather than nearest: elevation is a continuous field and this is a reprojection onto
 * a different lattice, where nearest makes the result depend on grid alignment and staircases
 * the terrain. The property that pins it is that **bilinear reproduces an affine field exactly**,
 * which nearest does not.
 *
 * **Nothing is invented at the edges.** A sample whose four-neighbour stencil is not entirely
 * inside the grid throws. Callers guarantee it cannot happen by reading the production envelope
 * — every intersecting tile's full footprint plus one sample of halo — rather than the declared
 * region. There is no terrarium encoding for absence, so there is no fill, no clamp and no
 * no-data value to reach for, exactly as with obligation 3.
 *
 * **Source-cell seams are upstream.** This module sees one grid and has no notion of the 1°
 * cells it was stitched from, so a seam is invisible here by construction; a discontinuity at an
 * integer degree would mean the stitching, not the interpolation, is wrong.
 */

import { TILE_SIZE, tilePixelCentre } from "./mercator.mjs";
import { RESOLUTION_M, decodeElevation, encodeElevation } from "./terrarium.mjs";

/** The most an encode/decode round trip can move a value: half a quantisation step. */
export const MAX_QUANTISATION_ERROR_M = RESOLUTION_M / 2;

export class ResampleError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "ResampleError";
  }
}

/**
 * @typedef {object} ElevationGrid
 * @property {number} width
 * @property {number} height
 * @property {number} west Longitude of column 0's samples.
 * @property {number} north Latitude of row 0's samples.
 * @property {number} pixelScaleDeg
 * @property {Float32Array} elevationsM
 */

/**
 * Decode a terrarium crop into metres, once, up front.
 *
 * The one place bytes become elevations. Everything downstream takes an {@link ElevationGrid},
 * so "do not interpolate the encoding" is a property of the types rather than a rule someone has
 * to remember.
 *
 * @param {{ width: number, height: number, west: number, north: number, pixelScaleDeg: number, rgb: Uint8Array }} crop
 * @returns {ElevationGrid}
 */
export function decodeGrid(crop) {
  const count = crop.width * crop.height;
  if (crop.rgb.length !== count * 3) {
    throw new ResampleError(
      `crop is ${String(crop.width)}x${String(crop.height)} but carries ${String(crop.rgb.length)} bytes, not ${String(count * 3)}`,
    );
  }
  const elevationsM = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    elevationsM[i] = decodeElevation(crop.rgb[i * 3], crop.rgb[i * 3 + 1], crop.rgb[i * 3 + 2]);
  }
  return {
    width: crop.width,
    height: crop.height,
    west: crop.west,
    north: crop.north,
    pixelScaleDeg: crop.pixelScaleDeg,
    elevationsM,
  };
}

/**
 * Bilinearly interpolate the grid at a geographic position, in metres.
 *
 * Samples sit *at* their coordinates rather than covering cells — `PixelIsPoint`, which the
 * source declares and the reader asserts — so column `c` is at `west + c·scale` exactly, and the
 * fractional position between columns is the interpolation weight.
 *
 * @param {ElevationGrid} grid
 * @param {number} lon
 * @param {number} lat
 * @returns {number} metres
 */
export function sampleBilinear(grid, lon, lat) {
  const fx = (lon - grid.west) / grid.pixelScaleDeg;
  const fy = (grid.north - lat) / grid.pixelScaleDeg;
  const col = Math.floor(fx);
  const row = Math.floor(fy);
  if (col < 0 || row < 0 || col + 1 >= grid.width || row + 1 >= grid.height) {
    // Thrown rather than clamped. A clamp would produce a plausible elevation for a position
    // the source does not cover, which is the silent-wrong-answer shape the whole fixture
    // refuses; the caller's job is to have read a wide enough envelope.
    throw new ResampleError(
      `(${String(lon)}, ${String(lat)}) needs source samples at columns ` +
        `${String(col)}..${String(col + 1)} and rows ${String(row)}..${String(row + 1)}, ` +
        `outside a ${String(grid.width)}x${String(grid.height)} grid — the read envelope is too small`,
    );
  }
  const u = fx - col;
  const v = fy - row;
  const i = row * grid.width + col;
  const h00 = grid.elevationsM[i];
  const h10 = grid.elevationsM[i + 1];
  const h01 = grid.elevationsM[i + grid.width];
  const h11 = grid.elevationsM[i + grid.width + 1];
  return h00 * (1 - u) * (1 - v) + h10 * u * (1 - v) + h01 * (1 - u) * v + h11 * u * v;
}

/**
 * Render one Web-Mercator tile as terrarium RGB.
 *
 * @param {ElevationGrid} grid
 * @param {number} z
 * @param {number} x
 * @param {number} y
 * @returns {Uint8Array} `TILE_SIZE² × 3` bytes, row-major from the tile's north-west pixel.
 */
export function renderTerrariumTile(grid, z, x, y) {
  const rgb = new Uint8Array(TILE_SIZE * TILE_SIZE * 3);
  let out = 0;
  for (let row = 0; row < TILE_SIZE; row += 1) {
    for (let col = 0; col < TILE_SIZE; col += 1) {
      const { lon, lat } = tilePixelCentre(z, x, y, col, row);
      const [r, g, b] = encodeElevation(sampleBilinear(grid, lon, lat));
      rgb[out] = r;
      rgb[out + 1] = g;
      rgb[out + 2] = b;
      out += 3;
    }
  }
  return rgb;
}
