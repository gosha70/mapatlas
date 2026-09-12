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

  /**
   * The diagnostic half of the same refusal (T8.1 increment 1).
   *
   * **Three crops, exactly one overlapping pair**, because two cannot tell attribution from
   * enumeration: with a single possible pair, a report that labelled *every* pair as overlapping
   * would pass while saying nothing. The third crop abuts cleanly and must not be named in the
   * overlap, which is the assertion a blanket reporter fails.
   *
   * Issue #30's flake is why this exists at all: four occurrences produced four copies of one
   * sentence, and the arithmetic that identified which crop had moved was reconstructed by hand
   * each time from the union's dimensions.
   */
  describe("the failure report", () => {
    /** `east` shifted 4 samples west, so it lands inside `west`; `far` abuts the union cleanly. */
    function overlappingTrio() {
      const [west, east] = seamCrops();
      const moved = { ...east, west: east.west - 4 * SCALE };
      const far = crop({ west: 7 + 4 * SCALE, north: 45.9, width: 8, height: 8 });
      return [west, moved, far];
    }

    /**
     * The same horizontal overlap, with the third crop **below** rather than beside.
     *
     * `[2]` shares `[0]`'s columns exactly and sits in the row band immediately under it, so the
     * two abut vertically and must not be reported as overlapping. Without this fixture the row
     * half of the intersection test is unreachable: every crop in `overlappingTrio` occupies rows
     * 0..7, so a report that only ever compared columns would pass.
     */
    function stackedTrio() {
      const [west, east] = seamCrops();
      const moved = { ...east, west: east.west - 4 * SCALE };
      const below = crop({ west: 7 - 8 * SCALE, north: 45.9 - 8 * SCALE, width: 8, height: 8 });
      return [west, moved, below];
    }

    /**
     * A whole placement line, assembled from the crop itself.
     *
     * Built rather than written out so the expectation cannot quietly drift from the fixture, and
     * asserted **whole** — size, both column bounds, both row bounds and the origin — because a
     * fragment that stopped at the columns would let the row bounds be dropped from the report
     * without a single test noticing.
     */
    const placementLine = (index, c, col, row) =>
      `  [${String(index)}] ${String(c.width)}x${String(c.height)} at ` +
      `col ${String(col)}..${String(col + c.width - 1)}, ` +
      `row ${String(row)}..${String(row + c.height - 1)}, ` +
      `origin (${String(c.west)}, ${String(c.north)})`;

    const messageOf = (crops) => {
      try {
        stitchSurface(crops);
      } catch (error) {
        return error.message;
      }
      throw new Error("stitchSurface did not refuse crops that overlap");
    };

    /**
     * **The first line is the identity of this failure and may not move.** Four occurrences in
     * issue #30 were matched to each other by exactly this sentence; a reworded, reordered or
     * re-spaced version would orphan that history and every search built on it. Asserted as a
     * whole line rather than by a fragment, so a change anywhere in it fails here.
     */
    it("keeps the signature line byte for byte, and appends rather than replaces", () => {
      const [first] = messageOf(overlappingTrio()).split("\n");
      expect(first).toBe(
        "the crops do not tile their union: 0 sample(s) covered by none and 32 by more than one, " +
          "over 20x8",
      );
    });

    it("reports every crop's placement in full, not only the ones that overlap", () => {
      const crops = overlappingTrio();
      const message = messageOf(crops);
      expect(message).toContain(placementLine(0, crops[0], 0, 0));
      expect(message).toContain(placementLine(1, crops[1], 4, 0));
      expect(message).toContain(placementLine(2, crops[2], 12, 0));
    });

    /**
     * The attribution claim, and the reason the fixture carries three crops. `[2]` abuts `[1]`
     * exactly — `cropWindow`'s half-open edge — so a report that enumerated pairs would name it
     * and a report that computes intersections does not.
     */
    it("names the overlapping pair and does not attribute the crop that merely abuts", () => {
      const message = messageOf(overlappingTrio());
      expect(message).toContain("[0] and [1] overlap over col 4..7, row 0..7");
      expect(message).not.toContain("[0] and [2]");
      expect(message).not.toContain("[1] and [2]");
    });

    /**
     * The row half of the same claim. `[2]` now shares `[0]`'s columns and lies in the band
     * beneath it: a pair test that checked columns alone, or that dropped its row bounds, would
     * report both `[0]`/`[2]` and `[1]`/`[2]` as overlapping. Neither does.
     */
    it("does not attribute a crop that abuts vertically rather than horizontally", () => {
      const crops = stackedTrio();
      const message = messageOf(crops);
      expect(message).toContain(placementLine(2, crops[2], 0, 8));
      expect(message).toContain("[0] and [1] overlap over col 4..7, row 0..7");
      expect(message).not.toContain("[0] and [2]");
      expect(message).not.toContain("[1] and [2]");
    });

    /** A hole is a different failure from a double-write, and the report says which it is. */
    it("says so plainly when the union has a gap and no overlap", () => {
      const [west, east] = seamCrops();
      const moved = { ...east, west: east.west + 4 * SCALE };
      const message = messageOf([west, moved]);
      expect(message).toContain("no two crops overlap; the union is not covered");
      expect(message).toContain(placementLine(1, moved, 12, 0));
    });
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
