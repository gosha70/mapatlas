// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { countTiles, tilesForRegion } from "./tiles";

describe("tilesForRegion", () => {
  it("returns the single root tile for a world bbox at zoom 0", () => {
    expect(tilesForRegion([-180, -85, 180, 85], 0, 0)).toEqual([
      { z: 0, x: 0, y: 0 },
    ]);
  });

  it("covers a small bbox with contiguous tiles at a single zoom", () => {
    const tiles = tilesForRegion([-122.34, 47.6, -122.33, 47.61], 14, 14);
    expect(tiles.length).toBeGreaterThan(0);
    expect(tiles.every((t) => t.z === 14)).toBe(true);
    // x increases eastward, y increases southward — all within tile-space.
    expect(tiles.every((t) => t.x >= 0 && t.y >= 0 && t.x < 2 ** 14)).toBe(
      true,
    );
  });

  it("accumulates tiles across a zoom range", () => {
    const bbox: [number, number, number, number] = [
      -122.34, 47.6, -122.33, 47.61,
    ];
    expect(countTiles(bbox, 12, 14)).toBeGreaterThan(countTiles(bbox, 14, 14));
  });
});
