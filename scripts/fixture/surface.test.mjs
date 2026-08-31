// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { ResampleError, sampleBilinear } from "./resample.mjs";
import { SurfaceError, stitchSurface } from "./surface.mjs";
import { encodeElevation } from "./terrarium.mjs";

const SCALE = 1 / 3600;
/** One affine plane, so a correct join reproduces it and any misalignment does not. */
const PLANE = { a: 400, b: -300, c: 14000 };
const height = (lon, lat) => PLANE.a * lon + PLANE.b * lat + PLANE.c;
/** Float32 storage plus the encoding's own step; far below one sample step of 0.111 m. */
const TOLERANCE_M = 0.01;

/**
 * A crop of one source cell, terrarium-encoded, sampled from the plane.
 *
 * `poison`, when given, replaces the plane throughout that crop — so a sample taken from the
 * wrong cell is off by thousands of metres rather than by a rounding difference. An earlier
 * version poisoned "outside columns 0..7" of an 8-wide crop, which is no columns at all: the
 * test passed without a single poisoned sample existing.
 */
function crop({ west, north, width, height: h, poison = null }) {
  const rgb = new Uint8Array(width * h * 3);
  for (let row = 0; row < h; row += 1) {
    for (let col = 0; col < width; col += 1) {
      const lon = west + col * SCALE;
      const lat = north - row * SCALE;
      const [r, g, b] = encodeElevation(poison === null ? height(lon, lat) : poison);
      const i = (row * width + col) * 3;
      rgb[i] = r;
      rgb[i + 1] = g;
      rgb[i + 2] = b;
    }
  }
  return { width, height: h, west, north, pixelScaleDeg: SCALE, rgb };
}

/** The two cells of the real seam, abutting exactly as GLO-30's lattices do. */
function seamCrops(options = {}) {
  const westCell = crop({ west: 7 - 8 * SCALE, north: 45.9, width: 8, height: 8, ...options.west });
  const eastCell = crop({ west: 7, north: 45.9, width: 8, height: 8, ...options.east });
  return [westCell, eastCell];
}

describe("two abutting cells become one lattice", () => {
  it("joins them into a grid spanning both, with the western origin", () => {
    const surface = stitchSurface(seamCrops());
    expect(surface).toMatchObject({ width: 16, height: 8, north: 45.9 });
    expect(surface.west).toBeCloseTo(7 - 8 * SCALE, 12);
  });

  it("reproduces the plane across the join, including where the stencil straddles it", () => {
    // The property the whole module exists for. Asserted at positions whose four-sample
    // stencil takes two samples from each cell — and the straddle is **asserted, not assumed**,
    // because a stencil that happened to sit wholly inside one cell would pass this while
    // proving nothing about the join.
    const surface = stitchSurface(seamCrops());
    let straddled = 0;
    for (const offset of [0.1, 0.5, 0.9]) {
      const lon = 7 - SCALE + offset * SCALE;
      const lat = 45.9 - 3.5 * SCALE;
      const col = Math.floor((lon - surface.west) / SCALE);
      const seamCol = Math.round((7 - surface.west) / SCALE);
      expect(col).toBe(seamCol - 1);
      expect(col + 1).toBe(seamCol); // the stencil's other column is the eastern cell's first
      straddled += 1;
      expect(Math.abs(sampleBilinear(surface, lon, lat) - height(lon, lat))).toBeLessThan(
        TOLERANCE_M,
      );
    }
    expect(straddled).toBe(3);
  });

  it.each([
    { poisoned: "west", at: 7 + 5.5 * SCALE },
    { poisoned: "east", at: 7 - 5.5 * SCALE },
  ])("keeps each cell's samples in its own half — $poisoned cell poisoned", ({ poisoned, at }) => {
    // One cell filled entirely with a value no terrain has. Sampling deep inside the *other*
    // cell must still be the plane, so nothing bled across the placement. A stride or offset
    // mistake writes one crop over the other's region and fails here by ~23,000 m.
    const surface = stitchSurface(seamCrops({ [poisoned]: { poison: -20000 } }));
    const lat = 45.9 - 3.5 * SCALE;
    expect(Math.abs(sampleBilinear(surface, at, lat) - height(at, lat))).toBeLessThan(TOLERANCE_M);
  });

  it("joins cells stacked north to south, not only side by side", () => {
    // The latitude seam, which the longitude fixture cannot reach: with every crop sharing one
    // `north`, the row offset is zero however it is computed, so flipping the sign of the north
    // axis was invisible. That is the same blind spot as a crop placed at the raster origin —
    // a fixture with no variation on the axis under test.
    const northern = crop({ west: 6.9, north: 46, width: 8, height: 8 });
    const southern = crop({ west: 6.9, north: 46 - 8 * SCALE, width: 8, height: 8 });

    const surface = stitchSurface([northern, southern]);

    expect(surface).toMatchObject({ width: 8, height: 16 });
    expect(surface.north).toBeCloseTo(46, 12);
    const lat = 46 - 7.5 * SCALE; // a stencil straddling the horizontal join
    const lon = 6.9 + 3.5 * SCALE;
    expect(Math.abs(sampleBilinear(surface, lon, lat) - height(lon, lat))).toBeLessThan(
      TOLERANCE_M,
    );
  });

  it.each([
    {
      axis: "west to east",
      pair: () => seamCrops(),
    },
    {
      axis: "north to south",
      pair: () => [
        crop({ west: 6.9, north: 46, width: 8, height: 8 }),
        crop({ west: 6.9, north: 46 - 8 * SCALE, width: 8, height: 8 }),
      ],
    },
  ])("does not depend on the order crops arrive in — $axis", ({ pair }) => {
    // With the first crop always the north-westernmost, the union's origin equals it and an
    // implementation that simply used it passed. Reversing makes the offset non-zero, which is
    // what the assertion needs in order to observe anything — and it has to be done on **both**
    // axes, because doing it on one left the other's mutation alive.
    const [first, second] = pair();
    const forward = stitchSurface([first, second]);
    const reversed = stitchSurface([second, first]);

    expect(reversed.west).toBeCloseTo(forward.west, 12);
    expect(reversed.north).toBeCloseTo(forward.north, 12);
    expect(reversed.width).toBe(forward.width);
    expect(reversed.height).toBe(forward.height);
    expect([...reversed.elevationsM]).toEqual([...forward.elevationsM]);
  });

  it("refuses an off-by-one at the join instead of producing a plausible surface", () => {
    // Shifting the eastern cell by one sample leaves the seam column covered by neither crop,
    // so the tiling check catches it before any value is read. Worth stating the limit
    // honestly: this detects a crop placed wrongly, **not** a crop whose declared origin
    // disagrees with its own pixels — that one still tiles perfectly. It is caught upstream
    // instead, by the reader's tiepoint cross-check against the cell the tile id names.
    const [west, east] = seamCrops();
    expect(() => stitchSurface([west, { ...east, west: east.west + SCALE }])).toThrow(
      /covered by none/,
    );
  });
});

describe("the join refuses what it cannot make continuous", () => {
  it("refuses crops that sample different grids", () => {
    const [west, east] = seamCrops();
    expect(() => stitchSurface([west, { ...east, west: east.west + SCALE / 3 }])).toThrow(
      /samples from the lattice on west/,
    );
  });

  it("refuses crops that disagree on spacing", () => {
    const [west, east] = seamCrops();
    expect(() => stitchSurface([west, { ...east, pixelScaleDeg: SCALE / 2 }])).toThrow(
      /disagree on sample spacing/,
    );
  });

  it("refuses a gap between crops rather than joining across it", () => {
    // A hole in the middle of the union is exactly the case where a fill would be tempting and
    // there is no value to fill with.
    const [west, east] = seamCrops();
    expect(() => stitchSurface([west, { ...east, west: east.west + 4 * SCALE }])).toThrow(
      /covered by none/,
    );
  });

  it("refuses overlapping crops rather than letting one silently win", () => {
    const [west, east] = seamCrops();
    expect(() => stitchSurface([west, { ...east, west: east.west - 4 * SCALE }])).toThrow(
      /by more than one/,
    );
  });

  it("refuses an empty set of crops", () => {
    expect(() => stitchSurface([])).toThrow(SurfaceError);
  });

  it("joins a single crop unchanged, so the one-cell case is not a special path", () => {
    const [only] = seamCrops();
    const surface = stitchSurface([only]);
    expect(surface).toMatchObject({ width: 8, height: 8, north: 45.9 });
    const lon = only.west + 3.5 * SCALE;
    expect(
      Math.abs(sampleBilinear(surface, lon, 45.9 - 3.5 * SCALE) - height(lon, 45.9 - 3.5 * SCALE)),
    ).toBeLessThan(TOLERANCE_M);
  });
});

describe("the surface is what the resampler already understands", () => {
  it("still throws outside its own extent, rather than the join widening the contract", () => {
    const surface = stitchSurface(seamCrops());
    expect(() => sampleBilinear(surface, 7.5, 45.9)).toThrow(ResampleError);
  });
});
