// SPDX-License-Identifier: Apache-2.0
import { VectorTile } from "@mapbox/vector-tile";
import Pbf from "pbf";
import { describe, expect, it } from "vitest";

import {
  CONTOUR_LAYER,
  ContourError,
  D3_GRID_OFFSET_SAMPLES,
  EXTENT,
  contourTiles,
  levelsFor,
  traceContours,
} from "./contour.mjs";
import { tilesInRange } from "./mercator.mjs";

const SPACING = 1 / 3600;
const WEST = 6.8;
const NORTH = 45.9;

/** A grid built from an analytical surface, laid out `PixelIsPoint` like the source. */
function gridOf(surface, width = 40, height = 40) {
  const elevationsM = new Float32Array(width * height);
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      elevationsM[row * width + col] = surface(WEST + col * SPACING, NORTH - row * SPACING);
    }
  }
  return { width, height, west: WEST, north: NORTH, pixelScaleDeg: SPACING, elevationsM };
}

/** An affine plane: every contour is a straight line on `a·lon + b·lat + c = level`. */
const PLANE = { a: 400, b: -300, c: 14000 };
const plane = (lon, lat) => PLANE.a * lon + PLANE.b * lat + PLANE.c;

/**
 * A radially symmetric dome: every contour is a circle of a radius the level determines.
 *
 * `k` is chosen so the levels used below give radii of 11–20 samples inside a 60-sample grid —
 * comfortably clear of the raster edge. A first attempt put the 3,000 m ring 25 samples across in
 * a 40-sample grid, so it *reached* the boundary and was correctly split into runs, and the
 * 2,900 m ring fell outside the raster altogether. The fixture was wrong and the tracer was
 * right, which is why the sizes are derived here rather than picked.
 */
const DOME_GRID = 60;
const DOME = {
  peak: 3200,
  k: 1e7,
  lon: WEST + (DOME_GRID / 2) * SPACING,
  lat: NORTH - (DOME_GRID / 2) * SPACING,
};
const dome = (lon, lat) => DOME.peak - DOME.k * ((lon - DOME.lon) ** 2 + (lat - DOME.lat) ** 2);
/** The radius, in degrees, at which the dome passes through a level. */
const domeRadius = (level) => Math.sqrt((DOME.peak - level) / DOME.k);

const shoelace = (ring) => {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return Math.abs(sum) / 2;
};

describe("the traced geometry lies where the surface says it does", () => {
  it("puts every vertex of every contour on the affine plane", () => {
    // The oracle: for an affine surface a contour is a straight line, so each vertex must
    // satisfy the plane equation at its own level exactly. It kills the half-cell offset, a
    // transposed axis, a wrong scale, and the raster-edge artefacts in one assertion — each of
    // those moves vertices off the plane by far more than float32 noise.
    const grid = gridOf(plane);
    const levels = levelsFor(2950, 2957.5, 0.5);

    const collection = traceContours(grid, levels);

    expect(collection.features.length).toBeGreaterThan(5);
    let worst = 0;
    let vertices = 0;
    for (const feature of collection.features) {
      for (const [lon, lat] of feature.geometry.coordinates) {
        worst = Math.max(worst, Math.abs(plane(lon, lat) - feature.properties.elevation));
        vertices += 1;
      }
    }
    expect(vertices).toBeGreaterThan(100);
    // Float32 storage puts an ulp of about 2.4e-4 m at 3,000 m; a half-sample offset would be
    // 0.06 m and an edge artefact several metres.
    expect(worst).toBeLessThan(1e-3);
  });

  it("is offset half a sample from d3-contour's own grid space", () => {
    // Pinned as its own claim because it is the single most consequential constant here and it
    // is invisible on a map: getting it wrong shifts the whole layer uniformly north-west.
    // Measured, not read: on `value = 10·x`, the level-15 crossing belongs at sample index 1.5
    // and d3-contour reports 2.0.
    expect(D3_GRID_OFFSET_SAMPLES).toBe(0.5);

    const width = 5;
    const height = 5;
    const elevationsM = new Float32Array(width * height);
    for (let row = 0; row < height; row += 1) {
      for (let col = 0; col < width; col += 1) elevationsM[row * width + col] = col * 10;
    }
    const grid = { width, height, west: WEST, north: NORTH, pixelScaleDeg: SPACING, elevationsM };

    const [feature] = traceContours(grid, [15]).features;
    const lons = feature.geometry.coordinates.map(([lon]) => lon);

    // The crossing sits between samples 1 and 2, so at `west + 1.5 · spacing`.
    for (const lon of lons) expect(lon).toBeCloseTo(WEST + 1.5 * SPACING, 12);
  });

  it("carries no vertex on the raster's own boundary", () => {
    // Where the data stops is not where the terrain reaches an elevation. d3-contour closes its
    // regions along the raster edge, and those vertices are placed on the edge rather than at an
    // interpolated crossing.
    //
    // **The bounds are the transformed edges, not a loose window round them.** An earlier version
    // allowed anything within one sample of `WEST`, while d3's `x = 0` maps to `WEST − 0.5·SPACING`
    // — so the assertion permitted precisely the vertices it claimed to exclude and would have
    // passed with every artefact present.
    const grid = gridOf(plane);
    const edge = {
      west: WEST - D3_GRID_OFFSET_SAMPLES * SPACING,
      east: WEST + (grid.width - D3_GRID_OFFSET_SAMPLES) * SPACING,
      north: NORTH + D3_GRID_OFFSET_SAMPLES * SPACING,
      south: NORTH - (grid.height - D3_GRID_OFFSET_SAMPLES) * SPACING,
    };
    // A hundredth of a sample: far below any real vertex spacing, far above float noise.
    const margin = SPACING / 100;

    let checked = 0;
    for (const feature of traceContours(grid, levelsFor(2950, 2957.5, 0.5)).features) {
      for (const [lon, lat] of feature.geometry.coordinates) {
        expect(lon).toBeGreaterThan(edge.west + margin);
        expect(lon).toBeLessThan(edge.east - margin);
        expect(lat).toBeLessThan(edge.north - margin);
        expect(lat).toBeGreaterThan(edge.south + margin);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it("closes a ring that lies wholly inside the raster, at the radius the level implies", () => {
    // The second oracle, and the one the plane cannot give: a dome's contours are circles, so a
    // level fixes both that the ring closes and how much area it encloses. This is the property
    // the toolchain was evaluated for — a small loop that survives as a loop rather than as an
    // open path or a line.
    const grid = gridOf(dome, DOME_GRID, DOME_GRID);
    const level = 3000;

    const rings = traceContours(grid, [level]).features;

    expect(rings).toHaveLength(1);
    const ring = rings[0].geometry.coordinates;
    expect(ring[0]).toEqual(ring.at(-1)); // closed
    const expected = Math.PI * domeRadius(level) ** 2;
    // Marching squares inscribes a polygon in the circle, so it under-estimates slightly.
    expect(shoelace(ring)).toBeGreaterThan(expected * 0.97);
    expect(shoelace(ring)).toBeLessThan(expected * 1.01);
  });

  it("keeps each ring's level as data rather than leaving it to be measured", () => {
    // Identify a contour by its tag, never by its geometry: measuring is what produced five
    // successive false failures in the toolchain evaluation.
    const grid = gridOf(dome, DOME_GRID, DOME_GRID);
    const levels = [2900, 3000, 3100];

    const features = traceContours(grid, levels).features;

    expect(new Set(features.map((f) => f.properties.elevation))).toEqual(new Set(levels));
    for (const feature of features) {
      const radius = domeRadius(feature.properties.elevation);
      expect(shoelace(feature.geometry.coordinates)).toBeGreaterThan(Math.PI * radius ** 2 * 0.97);
    }
  });

  it.each([
    { note: "no levels", args: [[]], expected: /at least one contour level/ },
    { note: "a non-finite level", args: [[Number.NaN]], expected: /finite metres/ },
  ])("refuses $note", ({ args, expected }) => {
    expect(() => traceContours(gridOf(plane), ...args)).toThrow(ContourError);
    expect(() => traceContours(gridOf(plane), ...args)).toThrow(expected);
  });
});

describe("levels are anchored to multiples of the interval", () => {
  it("gives the same elevations whatever range they are asked for", () => {
    // A 2,600 m line is a 2,600 m line everywhere. Anchoring to the terrain's own minimum would
    // make two adjacent fixtures disagree about where their contours are.
    expect(levelsFor(2560.8, 2810.7, 100)).toEqual([2600, 2700, 2800]);
    expect(levelsFor(2600, 2810.7, 100)).toEqual([2600, 2700, 2800]);
  });

  it.each([
    { note: "a zero interval", args: [0, 100, 0], expected: /positive number of metres/ },
    { note: "an empty range", args: [100, 100, 10], expected: /range is empty/ },
  ])("refuses $note", ({ args, expected }) => {
    expect(() => levelsFor(...args)).toThrow(expected);
  });
});

describe("tiling, decoded by an independent reader", () => {
  const grid = gridOf(dome, DOME_GRID, DOME_GRID);
  const collection = traceContours(grid, [2900, 3000, 3100]);
  /** The raster's own extent, so every tile cut from it can carry geometry. */
  const bounds = [WEST, NORTH - (DOME_GRID - 1) * SPACING, WEST + (DOME_GRID - 1) * SPACING, NORTH];

  /** `@mapbox/vector-tile`, not `vt-pbf` run backwards. */
  function decode(bytes) {
    const tile = new VectorTile(new Pbf(bytes));
    const layer = tile.layers[CONTOUR_LAYER];
    const features = [];
    for (let i = 0; i < (layer?.length ?? 0); i += 1) {
      const feature = layer.feature(i);
      features.push({ properties: feature.properties, geometry: feature.loadGeometry() });
    }
    return { layerNames: Object.keys(tile.layers), features };
  }

  it("writes one layer, and every requested level survives encoding", () => {
    // Per-feature membership is not enough: a tile set carrying only the 2,900 m contour
    // satisfies "every elevation is one of these" while two thirds of the layer is missing.
    // What has to hold is that the set of elevations that came back is *exactly* the set asked
    // for, aggregated across the tiles rather than checked within each.
    const tiles = contourTiles(collection, tilesInRange(bounds, 14, 15));

    expect(tiles.length).toBeGreaterThan(0);
    const recovered = new Set();
    for (const tile of tiles) {
      const { layerNames, features } = decode(tile.bytes);
      expect(layerNames).toEqual([CONTOUR_LAYER]);
      expect(features.length).toBeGreaterThan(0);
      for (const feature of features) recovered.add(feature.properties.elevation);
    }
    expect([...recovered].sort((a, b) => a - b)).toEqual([2900, 3000, 3100]);
  });

  it("keeps geometry inside the tile's extent, plus the declared buffer", () => {
    for (const tile of contourTiles(collection, tilesInRange(bounds, 14, 15))) {
      for (const feature of decode(tile.bytes).features) {
        for (const ring of feature.geometry) {
          for (const { x, y } of ring) {
            expect(x).toBeGreaterThanOrEqual(-BUFFER_UNITS);
            expect(x).toBeLessThanOrEqual(EXTENT + BUFFER_UNITS);
            expect(y).toBeGreaterThanOrEqual(-BUFFER_UNITS);
            expect(y).toBeLessThanOrEqual(EXTENT + BUFFER_UNITS);
          }
        }
      }
    }
  });

  it("accepts a generator of addresses, which is what the pyramid actually is", () => {
    // `tilesInRange` is a generator. An implementation that iterated it twice — once to size the
    // index and once to cut — would find it empty the second time and emit nothing at all, with
    // no error anywhere.
    const fromGenerator = contourTiles(collection, tilesInRange(bounds, 14, 14));
    const fromArray = contourTiles(collection, [...tilesInRange(bounds, 14, 14)]);

    expect(fromGenerator.length).toBeGreaterThan(0);
    expect(fromGenerator.map((t) => `${t.z}/${t.x}/${t.y}`)).toEqual(
      fromArray.map((t) => `${t.z}/${t.x}/${t.y}`),
    );
  });

  it("omits an empty tile rather than writing one that carries nothing", () => {
    // A tile that was never written reads back as absent; one written empty is neither data nor
    // absence, which is the distinction obligation 3 rests on.
    const far = [{ z: 14, x: 0, y: 0 }];
    expect(contourTiles(collection, far)).toEqual([]);
  });

  it("refuses to tile with no addresses at all", () => {
    expect(() => contourTiles(collection, [])).toThrow(/no tile addresses/);
  });
});

/** The render buffer, in the same units the decoder reports. */
const BUFFER_UNITS = 64;
