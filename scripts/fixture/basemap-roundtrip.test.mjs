// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { enumerateTiles, extractMetadata } from "./basemap-roundtrip.mjs";

/**
 * The tile enumeration, checked without a network.
 *
 * **Why a live run is not enough.** `basemap-roundtrip.mjs` exercises this against one interior
 * box and then reads back exactly what it wrote — so an off-by-one, or a north/south inversion,
 * produces a perfectly self-consistent round trip over the wrong tiles. The set decides every
 * byte the build fetches, and the only way to catch that is an oracle stated *independently* of
 * the implementation. Every expectation below is written out by hand.
 */

/** Slippy coordinates written out rather than computed, so the test cannot share a bug. */
describe("enumerateTiles", () => {
  it("covers the whole world with one tile at z0", () => {
    expect(enumerateTiles([-180, -85, 180, 85], 0, 0)).toStrictEqual([{ z: 0, x: 0, y: 0 }]);
  });

  it("splits the world into four at z1, with north on the low y", () => {
    // The orientation check. y grows *southward*: the northern hemisphere is y=0.
    expect(enumerateTiles([-180, -85, 180, 85], 1, 1)).toStrictEqual([
      { z: 1, x: 0, y: 0 },
      { z: 1, x: 0, y: 1 },
      { z: 1, x: 1, y: 0 },
      { z: 1, x: 1, y: 1 },
    ]);
  });

  it("puts a northern point in the north tile and a southern one in the south", () => {
    // Stated independently: at z1, anything above the equator is y=0, below is y=1.
    expect(enumerateTiles([10, 40, 11, 41], 1, 1)).toStrictEqual([{ z: 1, x: 1, y: 0 }]);
    expect(enumerateTiles([10, -41, 11, -40], 1, 1)).toStrictEqual([{ z: 1, x: 1, y: 1 }]);
  });

  it("takes both tiles when the bounds straddle an exact tile boundary", () => {
    // At z2 the meridians are 90° apart, so 0°E is the boundary between x=1 and x=2. Bounds
    // spanning it must yield both columns — the case an inclusive/exclusive slip gets wrong.
    const straddling = enumerateTiles([-1, 10, 1, 11], 2, 2);

    expect(straddling.map((t) => t.x)).toStrictEqual([1, 2]);
  });

  it("takes one tile when the bounds sit exactly on a boundary with no width", () => {
    // Degenerate but legal: the west and east edges are the same meridian. `Math.floor` puts
    // 0°E in x=2 at z2, so this is one tile, not two — and not zero.
    expect(enumerateTiles([0, 10, 0, 11], 2, 2)).toStrictEqual([{ z: 2, x: 2, y: 1 }]);
  });

  it("clamps at the antimeridian rather than running off the grid", () => {
    // 180°E maps to x = 2^z, which is one past the last column. An unclamped enumeration would
    // ask for a tile that cannot exist and the reader would report it missing — an extract
    // silently short of its eastern edge.
    const eastEdge = enumerateTiles([179, 10, 180, 11], 2, 2);

    expect(eastEdge.every((t) => t.x <= 3)).toBe(true);
    expect(eastEdge.map((t) => t.x)).toStrictEqual([3]);
  });

  it("returns every zoom in the range, in ascending order", () => {
    const zooms = enumerateTiles([10, 10, 11, 11], 3, 6).map((t) => t.z);

    expect(zooms).toStrictEqual([...zooms].sort((a, b) => a - b));
    expect(new Set(zooms)).toStrictEqual(new Set([3, 4, 5, 6]));
  });

  it("grows by roughly four per zoom level, not by one", () => {
    // A box that spans two tiles per axis at z10 spans about four at z11. This catches an
    // enumeration that walked only the north-west corner of the range.
    const wide = [6.0, 45.0, 7.0, 46.0];
    const atTen = enumerateTiles(wide, 10, 10).length;
    const atEleven = enumerateTiles(wide, 11, 11).length;

    expect(atEleven).toBeGreaterThan(atTen * 2);
  });

  it("enumerates the declared region at z8-14 as a closed set with no duplicates", () => {
    const tiles = enumerateTiles([6.825, 45.815, 6.905, 45.865], 8, 14);
    const keys = tiles.map((t) => `${String(t.z)}/${String(t.x)}/${String(t.y)}`);

    expect(new Set(keys).size).toBe(tiles.length);
    // z8 holds the region in a single tile, stated independently: floor(((6.825+180)/360)*256)
    // = 132, and the Mercator y for 45.865N at z8 is 91.
    expect(tiles[0]).toStrictEqual({ z: 8, x: 132, y: 91 });
  });
});

describe("extractMetadata", () => {
  const region = { id: "r", bounds: [1, 2, 3, 4] };

  it("preserves the upstream document whole", () => {
    // vector_layers is the v4 schema every style layer will be written against; the planetiler
    // keys are the provenance that says which OSM replication these tiles came from. An extract
    // that dropped them would render identically and be untraceable.
    const upstream = {
      vector_layers: [{ id: "roads" }],
      attribution: "© OpenStreetMap",
      name: "Protomaps Basemap",
      "planetiler:osm:osmosisreplicationseq": "121941",
    };

    const out = extractMetadata(upstream, region);

    for (const [key, value] of Object.entries(upstream)) expect(out[key]).toStrictEqual(value);
  });

  it("adds the bounds the writer requires", () => {
    expect(extractMetadata({}, region)["bounds"]).toStrictEqual(region.bounds);
  });

  it("records which build the tiles came from", () => {
    const source = extractMetadata({}, region)["mapatlas:source"];

    expect(source.key).toBe("20260811.pmtiles");
    expect(source.blake3).toHaveLength(64);
  });

  it("reads no clock, so the extract is byte-identical across runs", () => {
    // A timestamp here would make the recorded SHA-256 meaningless — every build would differ
    // and the pin would have to be deleted rather than checked.
    expect(JSON.stringify(extractMetadata({ a: 1 }, region))).toBe(
      JSON.stringify(extractMetadata({ a: 1 }, region)),
    );
  });
});
