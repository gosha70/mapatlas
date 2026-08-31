// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  MercatorError,
  TILE_SIZE,
  productionEnvelope,
  tileBounds,
  tilePixelCentre,
  tileRange,
  tilesInRange,
} from "./mercator.mjs";

const REGION = JSON.parse(
  readFileSync(new URL("../../fixtures/vertical/region.json", import.meta.url), "utf8"),
);
const BOUNDS = REGION.bounds;
/** The source's sample spacing, 1 arcsecond — the halo bilinear needs. */
const ARCSEC = 1 / 3600;

/**
 * The projection oracle, written from a **different formulation** than the implementation.
 *
 * `mercator.mjs` inverts with `atan(sinh(...))`. This uses the Gudermannian in its
 * `2·atan(exp(y)) − π/2` form, and the forward direction through `ln(tan(π/4 + φ/2))`. The two
 * are mathematically equal and textually unrelated, so a transcription slip in one does not
 * reproduce itself in the other. Testing a projection against its own formula restated would
 * prove only that the restatement was faithful.
 */
const oracle = {
  lonToX: (lon, z) => (2 ** z * (lon + 180)) / 360,
  latToY: (lat, z) => {
    const merc = Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
    return 2 ** z * (0.5 - merc / (2 * Math.PI));
  },
  xToLon: (x, z) => (360 * x) / 2 ** z - 180,
  yToLat: (y, z) => {
    const merc = 2 * Math.PI * (0.5 - y / 2 ** z);
    return ((2 * Math.atan(Math.exp(merc)) - Math.PI / 2) * 180) / Math.PI;
  },
};

describe("the projection, against an independently written oracle", () => {
  it.each([
    { lat: 0, note: "the equator, which must land exactly halfway down the pyramid" },
    { lat: 85.0511287798066, note: "the Mercator limit, which must land at the very top" },
  ])("places $note", ({ lat }) => {
    // Two anchors that are published constants rather than outputs of either formulation, so
    // they catch a pair of formulas that agree with each other and are both wrong.
    const z = 4;
    expect(oracle.latToY(lat, z)).toBeCloseTo(lat === 0 ? 2 ** z / 2 : 0, 9);
    expect(tileBounds(z, 0, lat === 0 ? 2 ** z / 2 : 0)[3]).toBeCloseTo(lat, 6);
  });

  it("puts pixel centres where the oracle puts them, at half-pixel offsets", () => {
    // The +0.5 is the claim. Asserted against independently computed coordinates rather than
    // against a neighbouring pixel, because a uniform half-pixel shift preserves every
    // pixel-to-pixel relationship and would survive any relative check.
    for (const [z, x, y] of [
      [0, 0, 0],
      [11, 1062, 729],
      [12, 2126, 1460],
    ]) {
      for (const [col, row] of [
        [0, 0],
        [128, 200],
        [255, 255],
      ]) {
        const got = tilePixelCentre(z, x, y, col, row);
        const scale = TILE_SIZE * 2 ** z;
        expect(got.lon).toBeCloseTo(oracle.xToLon((x * TILE_SIZE + col + 0.5) / TILE_SIZE, z), 9);
        expect(got.lat).toBeCloseTo(oracle.yToLat((y * TILE_SIZE + row + 0.5) / TILE_SIZE, z), 9);
        expect(got.lon).toBeGreaterThan(tileBounds(z, x, y)[0]);
        expect(scale).toBeGreaterThan(0);
      }
    }
  });

  it("round-trips a pixel centre back to its own tile and pixel", () => {
    const z = 12;
    for (const [x, y, col, row] of [
      [2125, 1459, 0, 0],
      [2126, 1460, 255, 255],
      [2125, 1460, 77, 200],
    ]) {
      const { lon, lat } = tilePixelCentre(z, x, y, col, row);
      expect(Math.floor(oracle.lonToX(lon, z))).toBe(x);
      expect(Math.floor(oracle.latToY(lat, z))).toBe(y);
      expect(Math.floor(oracle.lonToX(lon, z) * TILE_SIZE) % TILE_SIZE).toBe(col);
      expect(Math.floor(oracle.latToY(lat, z) * TILE_SIZE) % TILE_SIZE).toBe(row);
    }
  });

  it("spaces adjacent pixel centres by exactly one pixel across a tile boundary", () => {
    // The seam property, on coordinates rather than appearance: the last pixel of one tile and
    // the first of the next are one pixel apart — neither duplicated nor skipped.
    const z = 11;
    const left = tilePixelCentre(z, 1062, 729, 255, 100);
    const right = tilePixelCentre(z, 1063, 729, 0, 100);
    const step = 360 / (TILE_SIZE * 2 ** z);
    expect(right.lon - left.lon).toBeCloseTo(step, 12);
    expect(right.lat).toBe(left.lat);

    const above = tilePixelCentre(z, 1062, 729, 100, 255);
    const below = tilePixelCentre(z, 1062, 730, 100, 0);
    expect(above.lat).toBeGreaterThan(below.lat);
    expect(oracle.latToY(above.lat, z) * TILE_SIZE).toBeCloseTo(
      oracle.latToY(below.lat, z) * TILE_SIZE - 1,
      6,
    );
  });

  it("is not linear in latitude, which a plate-carrée mistake would make it", () => {
    // Named because the two agree at the equator and diverge with distance from it, so a test
    // near 0° would pass against a linear implementation.
    const z = 11;
    // Mercator *stretches* high latitudes, so a polar tile spans fewer degrees than an
    // equatorial one — the inequality runs the opposite way to the intuition that the poles
    // are "compressed". Under a linear-latitude implementation every tile spans the same
    // degrees and the ratio is exactly 1, which is what this discriminates.
    const polar = tileBounds(z, 0, 0)[3] - tileBounds(z, 0, 1)[3];
    const equatorial = tileBounds(z, 0, 2 ** z / 2)[3] - tileBounds(z, 0, 2 ** z / 2 + 1)[3];
    expect(equatorial).toBeGreaterThan(polar * 5);
  });
});

describe("the fixture pyramid's addressing", () => {
  it.each([
    { z: 11, minX: 1062, maxX: 1063, minY: 729, maxY: 730 },
    { z: 12, minX: 2125, maxX: 2126, minY: 1459, maxY: 1460 },
  ])("covers the declared region at z$z with four tiles", ({ z, ...expected }) => {
    expect(tileRange(BOUNDS, z)).toEqual(expected);
  });

  it("enumerates the pyramid ascending by zoom, then row, then column", () => {
    const tiles = [...tilesInRange(BOUNDS, 11, 12)];
    expect(tiles).toHaveLength(8);
    expect(tiles[0]).toEqual({ z: 11, x: 1062, y: 729 });
    expect(tiles[3]).toEqual({ z: 11, x: 1063, y: 730 });
    expect(tiles[4]).toEqual({ z: 12, x: 2125, y: 1459 });
  });

  it("refuses a maxZoom below its minZoom", () => {
    expect(() => [...tilesInRange(BOUNDS, 12, 11)]).toThrow(MercatorError);
  });
});

describe("the region edge is half-open, as it is everywhere else", () => {
  it("does not take the eastern neighbour when the bound lands exactly on a tile edge", () => {
    // At z1 the meridian is exactly the boundary between tiles 0 and 1, so a region ending
    // there must stop at tile 0. `Math.floor` alone takes tile 1 and produces a column of
    // output covering land the region never asked for.
    expect(tileRange([-90, -10, 0, 10], 1)).toMatchObject({ minX: 0, maxX: 0 });
    expect(tileRange([-90, -10, 0.0001, 10], 1)).toMatchObject({ minX: 0, maxX: 1 });
  });

  it("does not take the southern neighbour when the bound lands exactly on a tile edge", () => {
    // The equator is the exact boundary between tile rows at any even split, and latitude is
    // the axis where a naive floor is easiest to get away with, since exact hits are rare.
    expect(tileRange([-10, 0, 10, 40], 1)).toMatchObject({ minY: 0, maxY: 0 });
    expect(tileRange([-10, -0.0001, 10, 40], 1)).toMatchObject({ minY: 0, maxY: 1 });
  });

  it("still covers one tile for a box far smaller than a tile", () => {
    // The half-open rule steps the upper edge back only when it lands *on* a boundary, so a
    // sub-tile box keeps the tile it sits inside rather than collapsing to nothing.
    expect(tileRange([0.001, 0.001, 0.002, 0.002], 1)).toEqual({
      minX: 1,
      maxX: 1,
      minY: 0,
      maxY: 0,
    });
  });

  it("rejects an inverted box through the shared bounds validator", () => {
    // Not a rule of its own: `tileRange` uses the same validator as the region declaration,
    // coverage and the crop, so the four cannot drift on what a box is.
    expect(() => tileRange([10, 0, 5, 10], 1)).toThrow(/west must precede east/);
  });
});

describe("the production envelope is wider than the declared region", () => {
  it("spans the full footprints of every tile the pyramid contains", () => {
    const envelope = productionEnvelope(BOUNDS, 11, 12, 0);
    expect(envelope[0]).toBeLessThan(BOUNDS[0]);
    expect(envelope[1]).toBeLessThan(BOUNDS[1]);
    expect(envelope[2]).toBeGreaterThan(BOUNDS[2]);
    expect(envelope[3]).toBeGreaterThan(BOUNDS[3]);
    for (const { z, x, y } of tilesInRange(BOUNDS, 11, 12)) {
      const [w, s, e, n] = tileBounds(z, x, y);
      expect(w).toBeGreaterThanOrEqual(envelope[0]);
      expect(s).toBeGreaterThanOrEqual(envelope[1]);
      expect(e).toBeLessThanOrEqual(envelope[2]);
      expect(n).toBeLessThanOrEqual(envelope[3]);
    }
  });

  it("reaches past 7°E, so the build needs a source cell the region never touches", () => {
    // The concrete consequence, and the reason coverage moves off the declaration. The
    // declared region ends at 6.905°E and lies wholly inside N45E006; the z11 envelope crosses
    // the integer meridian, so N45E007 becomes required.
    expect(BOUNDS[2]).toBeLessThan(7);
    expect(productionEnvelope(BOUNDS, 11, 12, ARCSEC)[2]).toBeGreaterThan(7);
  });

  it("stays south of 46°N at z11, which is why z10 is not in the pyramid", () => {
    // Recorded as a test because it is the load-bearing half of the zoom choice: z10 would
    // cross the parallel and pull in the N46 cells, making the zoom range a coverage decision
    // rather than a resolution preference.
    expect(productionEnvelope(BOUNDS, 11, 12, ARCSEC)[3]).toBeLessThan(46);
    expect(productionEnvelope(BOUNDS, 10, 12, ARCSEC)[3]).toBeGreaterThan(46);
  });

  it("adds the interpolation halo on every side", () => {
    const bare = productionEnvelope(BOUNDS, 11, 12, 0);
    const haloed = productionEnvelope(BOUNDS, 11, 12, ARCSEC);
    expect(bare[0] - haloed[0]).toBeCloseTo(ARCSEC, 12);
    expect(bare[1] - haloed[1]).toBeCloseTo(ARCSEC, 12);
    expect(haloed[2] - bare[2]).toBeCloseTo(ARCSEC, 12);
    expect(haloed[3] - bare[3]).toBeCloseTo(ARCSEC, 12);
  });

  it("clamps the halo at the edges of the world rather than running past them", () => {
    const envelope = productionEnvelope([-180, -85, 180, 85], 0, 0, 1);
    expect(envelope[0]).toBe(-180);
    expect(envelope[2]).toBe(180);
  });

  it("refuses a negative halo", () => {
    expect(() => productionEnvelope(BOUNDS, 11, 12, -1)).toThrow(/non-negative/);
  });
});
