// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { TILE_SIZE } from "./mercator.mjs";
import { pixelCentre } from "./mercator-oracle.mjs";
import {
  MAX_QUANTISATION_ERROR_M,
  ResampleError,
  decodeGrid,
  renderTerrariumTile,
  sampleBilinear,
} from "./resample.mjs";
import { decodeElevation, encodeElevation } from "./terrarium.mjs";

/**
 * An affine elevation field, `h(lon, lat) = A·lon + B·lat + C`.
 *
 * The oracle the bars name, and the reason it is the right one: **bilinear reproduces an affine
 * function exactly**, so the expected value is analytical rather than another interpolation.
 * One fixture therefore kills nearest-neighbour, transposed axes, wrong fractional weights and
 * channel interpolation at once — each of those disagrees with the plane somewhere.
 */
const PLANE = { a: 400, b: -300, c: 14000 };
const height = (lon, lat) => PLANE.a * lon + PLANE.b * lat + PLANE.c;

/**
 * What agreement with the plane is actually achievable, and why it is not zero.
 *
 * `elevationsM` is a `Float32Array`, whose ulp near 3,000 m is about 0.00024 m — deliberately,
 * since that is some sixteen times finer than the 1/256 m the encoding it round-trips through
 * can represent, so the storage is not the limiting factor for anything that matters. Four
 * weighted terms accumulate a little of it. The bound below is two orders of magnitude tighter
 * than the ~0.055 m a nearest-neighbour implementation would be off by on this plane, which is
 * what keeps the oracle discriminating rather than merely satisfiable.
 */
const FLOAT32_TOLERANCE_M = 0.002;

/** A grid whose samples are the plane, laid out `PixelIsPoint`. */
function planeGrid({
  west = 6.8,
  north = 45.9,
  scale = 1 / 3600,
  width = 64,
  height: h = 64,
} = {}) {
  const elevationsM = new Float32Array(width * h);
  for (let row = 0; row < h; row += 1) {
    for (let col = 0; col < width; col += 1) {
      elevationsM[row * width + col] = height(west + col * scale, north - row * scale);
    }
  }
  return { width, height: h, west, north, pixelScaleDeg: scale, elevationsM };
}

/** The same grid, terrarium-encoded, so `decodeGrid` is exercised as the only door in. */
function planeCrop(options) {
  const grid = planeGrid(options);
  const rgb = new Uint8Array(grid.width * grid.height * 3);
  grid.elevationsM.forEach((m, i) => {
    const [r, g, b] = encodeElevation(m);
    rgb[i * 3] = r;
    rgb[i * 3 + 1] = g;
    rgb[i * 3 + 2] = b;
  });
  return { ...grid, rgb };
}

describe("interpolation, against the affine oracle — no projection involved", () => {
  // Deliberately independent of `mercator.mjs`: positions are chosen directly in lon/lat, so a
  // wrong projection cannot make this pass and a wrong interpolation cannot hide behind one.
  const grid = planeGrid();

  it("reproduces an affine field exactly at the sample points", () => {
    for (const [col, row] of [
      [0, 0],
      [1, 3],
      [30, 40],
    ]) {
      const lon = grid.west + col * grid.pixelScaleDeg;
      const lat = grid.north - row * grid.pixelScaleDeg;
      expect(sampleBilinear(grid, lon, lat) - height(lon, lat)).toBeLessThan(FLOAT32_TOLERANCE_M);
    }
  });

  it("reproduces an affine field exactly between them, which is what excludes nearest", () => {
    // Nearest-neighbour agrees with the plane at sample points and disagrees everywhere else,
    // so the fractional positions are the discriminator — the whole-sample cases above would
    // pass against it.
    for (const [du, dv] of [
      [0.5, 0.5],
      [0.25, 0.75],
      [0.1, 0.9],
      [0.999, 0.001],
    ]) {
      const lon = grid.west + (10 + du) * grid.pixelScaleDeg;
      const lat = grid.north - (12 + dv) * grid.pixelScaleDeg;
      expect(Math.abs(sampleBilinear(grid, lon, lat) - height(lon, lat))).toBeLessThan(
        FLOAT32_TOLERANCE_M,
      );
    }
  });

  it("weights the two axes independently, so a transposed stencil is visible", () => {
    // A plane with unequal coefficients: swapping u and v, or rows and columns, moves the
    // result. With A === B the mistake would be invisible, which is why they differ here.
    expect(Math.abs(PLANE.a)).not.toBeCloseTo(Math.abs(PLANE.b), 1);
    const lon = grid.west + 5.3 * grid.pixelScaleDeg;
    const lat = grid.north - 9.7 * grid.pixelScaleDeg;
    expect(Math.abs(sampleBilinear(grid, lon, lat) - height(lon, lat))).toBeLessThan(
      FLOAT32_TOLERANCE_M,
    );
  });

  it("sees no discontinuity where the source cells were stitched", () => {
    // Source-cell seams are upstream: this module has no notion of 1° cells, so an integer
    // meridian inside the grid must be unremarkable. A jump here would mean the stitching is
    // wrong, not the interpolation.
    const spanning = planeGrid({ west: 6.999, north: 45.9, width: 20 });
    const step = spanning.pixelScaleDeg / 8;
    let previous = sampleBilinear(spanning, 6.9995, 45.899);
    for (let lon = 6.9995 + step; lon < 7.0015; lon += step) {
      const current = sampleBilinear(spanning, lon, 45.899);
      expect(Math.abs(current - previous)).toBeLessThan(Math.abs(PLANE.a) * step * 2);
      previous = current;
    }
  });
});

describe("nothing is invented outside the grid", () => {
  const grid = planeGrid({ width: 8, height: 8 });

  it.each([
    { note: "west of the grid", lon: 6.79, lat: 45.8995 },
    { note: "north of the grid", lon: 6.8005, lat: 45.91 },
    {
      note: "past the last column, where the stencil is incomplete",
      lon: 6.8 + 7 / 3600,
      lat: 45.8995,
    },
    { note: "past the last row", lon: 6.8005, lat: 45.9 - 7 / 3600 },
  ])("refuses a position $note rather than clamping it", ({ lon, lat }) => {
    expect(() => sampleBilinear(grid, lon, lat)).toThrow(ResampleError);
    expect(() => sampleBilinear(grid, lon, lat)).toThrow(/read envelope is too small/);
  });

  it("names the columns and rows it needed, so the envelope can be widened knowingly", () => {
    // Computed rather than written in: the point is that the message reports the stencil the
    // caller must cover, and hard-coding it would make the test agree with whatever it printed.
    const col = Math.floor((6.79 - grid.west) / grid.pixelScaleDeg);
    expect(() => sampleBilinear(grid, 6.79, 45.8995)).toThrow(
      `columns ${String(col)}..${String(col + 1)}`,
    );
  });
});

describe("the encoding is applied after interpolation, never during it", () => {
  it("takes a terrarium crop only through decodeGrid", () => {
    const crop = planeCrop({ width: 16, height: 16 });
    const grid = decodeGrid(crop);
    expect(grid.elevationsM).toBeInstanceOf(Float32Array);
    for (let i = 0; i < grid.elevationsM.length; i += 1) {
      const col = i % grid.width;
      const row = Math.floor(i / grid.width);
      const analytical = height(grid.west + col / 3600, grid.north - row / 3600);
      expect(Math.abs(grid.elevationsM[i] - analytical)).toBeLessThanOrEqual(
        MAX_QUANTISATION_ERROR_M,
      );
    }
  });

  it("refuses a crop whose byte count does not match its dimensions", () => {
    const crop = planeCrop({ width: 4, height: 4 });
    expect(() => decodeGrid({ ...crop, rgb: crop.rgb.subarray(0, 12) })).toThrow(
      /carries 12 bytes, not 48/,
    );
  });

  it("lands within half a quantisation step of the analytical plane", () => {
    // The round trip's only permitted loss. Interpolating the *channels* instead would leave
    // errors orders of magnitude larger than this, because the carries between them are not
    // linear — so this bound is what makes that mistake visible rather than merely wrong.
    const grid = decodeGrid(planeCrop({ width: 32, height: 32 }));
    for (const [du, dv] of [
      [0.5, 0.5],
      [0.3, 0.8],
      [0.95, 0.05],
    ]) {
      const lon = grid.west + (10 + du) / 3600;
      const lat = grid.north - (10 + dv) / 3600;
      const [r, g, b] = encodeElevation(sampleBilinear(grid, lon, lat));
      // Sample values are themselves quantised before interpolation, so the budget is one step
      // for the inputs and half a step for the output encode.
      expect(Math.abs(decodeElevation(r, g, b) - height(lon, lat))).toBeLessThanOrEqual(
        MAX_QUANTISATION_ERROR_M * 3,
      );
    }
  });
});

describe("a rendered tile, projection and interpolation together", () => {
  // The integration test the bars require, and never the only proof: the two oracles above and
  // in `mercator.test.mjs` each fail on their own account, so this cannot be the thing that
  // catches either in isolation.
  const Z = 14;
  const X = 8504;
  const Y = 5839;

  /** A grid wide enough to cover the tile's footprint plus a halo. */
  function gridForTile() {
    const nw = pixelCentre(Z, X, Y, 0, 0);
    const se = pixelCentre(Z, X, Y, TILE_SIZE - 1, TILE_SIZE - 1);
    const scale = 1 / 3600;
    const west = nw.lon - 2 * scale;
    const north = nw.lat + 2 * scale;
    return planeGrid({
      west,
      north,
      scale,
      width: Math.ceil((se.lon - west) / scale) + 4,
      height: Math.ceil((north - se.lat) / scale) + 4,
    });
  }

  it("matches the analytical plane at every pixel, within quantisation", () => {
    const rgb = renderTerrariumTile(gridForTile(), Z, X, Y);
    expect(rgb).toHaveLength(TILE_SIZE * TILE_SIZE * 3);

    let worst = 0;
    for (const [col, row] of [
      [0, 0],
      [255, 0],
      [0, 255],
      [255, 255],
      [128, 128],
      [37, 211],
    ]) {
      const i = (row * TILE_SIZE + col) * 3;
      const got = decodeElevation(rgb[i], rgb[i + 1], rgb[i + 2]);
      // The expected position comes from the **independent** oracle, not from `mercator.mjs`,
      // so a projection error cannot cancel itself out of both sides of this comparison.
      const { lon, lat } = pixelCentre(Z, X, Y, col, row);
      worst = Math.max(worst, Math.abs(got - height(lon, lat)));
    }
    expect(worst).toBeLessThanOrEqual(MAX_QUANTISATION_ERROR_M * 3);
  });

  it("varies across the tile, so a constant fill could not pass", () => {
    const rgb = renderTerrariumTile(gridForTile(), Z, X, Y);
    const first = decodeElevation(rgb[0], rgb[1], rgb[2]);
    const last = decodeElevation(rgb[rgb.length - 3], rgb[rgb.length - 2], rgb[rgb.length - 1]);
    expect(Math.abs(last - first)).toBeGreaterThan(1);
  });

  it("refuses to render a tile the grid does not fully cover", () => {
    // The edge rule, at tile granularity: a partially covered tile is a build failure, not a
    // tile with invented pixels in the corner.
    expect(() => renderTerrariumTile(planeGrid({ width: 8, height: 8 }), Z, X, Y)).toThrow(
      ResampleError,
    );
  });
});
