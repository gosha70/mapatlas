// SPDX-License-Identifier: Apache-2.0
import type { TileSource } from "@mapatlas/core";
import { describe, expect, it } from "vitest";

import {
  TileSourceError,
  buildTileSource,
  buildTileSources,
  resolveRole,
  usesPmtiles,
} from "./tile-source.js";

const OSM: TileSource = {
  id: "osm",
  kind: "xyz",
  url: "https://tiles.invalid/{z}/{x}/{y}.png",
  attribution: "© OpenStreetMap contributors",
};

describe("raster sources", () => {
  it("translates an xyz source into a raster source and one layer", () => {
    const built = buildTileSource(OSM, 0);

    expect(built.source).toMatchObject({
      type: "raster",
      tiles: ["https://tiles.invalid/{z}/{x}/{y}.png"],
      tileSize: 256,
      attribution: "© OpenStreetMap contributors",
    });
    expect(built.layers).toHaveLength(1);
    expect(built.layers[0]).toMatchObject({ type: "raster", source: "osm" });
  });

  it("carries zoom bounds and tile size through", () => {
    const built = buildTileSource({ ...OSM, minZoom: 4, maxZoom: 17, tileSize: 512 }, 0);
    expect(built.source).toMatchObject({ minzoom: 4, maxzoom: 17, tileSize: 512 });
  });

  it("omits zoom bounds that were not given, rather than inventing them", () => {
    const source = buildTileSource(OSM, 0).source as Record<string, unknown>;
    expect(source).not.toHaveProperty("minzoom");
    expect(source).not.toHaveProperty("maxzoom");
  });

  it("applies opacity to the raster layer", () => {
    const built = buildTileSource({ ...OSM, opacity: 0.4 }, 1);
    expect(built.layers[0]).toMatchObject({ paint: { "raster-opacity": 0.4 } });
  });
});

describe("attribution is a licence obligation", () => {
  it("rejects a source with none", () => {
    // OSM and OpenSeaMap both require it (architecture.md §8), so a source that cannot
    // state its own is one the engine must not silently render.
    expect(() => buildTileSource({ ...OSM, attribution: "" }, 0)).toThrow(TileSourceError);
    expect(() => buildTileSource({ ...OSM, attribution: "   " }, 0)).toThrow(/attribution/);
  });

  it("passes it through verbatim", () => {
    const attribution = '© OpenStreetMap contributors, <a href="x">ODbL</a>';
    expect(buildTileSource({ ...OSM, attribution }, 0).source).toMatchObject({ attribution });
  });
});

describe("WMS", () => {
  const WMS: TileSource = {
    id: "charts",
    kind: "wms",
    url: "https://wms.invalid/?BBOX={bbox-epsg-3857}&WIDTH=256&HEIGHT=256",
    attribution: "NOAA",
  };

  it("translates to a raster source", () => {
    expect(buildTileSource(WMS, 1).source).toMatchObject({ type: "raster" });
  });

  it("rejects a url with no bbox placeholder", () => {
    // Without it every request asks for the same extent, so one tile's worth of imagery
    // renders everywhere and the map looks broken in a way nothing reports.
    expect(() => buildTileSource({ ...WMS, url: "https://wms.invalid/?LAYERS=charts" }, 1)).toThrow(
      /bbox placeholder/,
    );
  });
});

describe("vector sources carry the consumer's own layers", () => {
  const VECTOR: TileSource = {
    id: "contours",
    kind: "vector",
    url: "https://tiles.invalid/contours.json",
    attribution: "© Contour data",
    styleLayers: [
      { id: "contour-lines", type: "line", "source-layer": "contour", paint: { "line-width": 1 } },
      { type: "symbol", "source-layer": "contour", layout: { "text-field": ["get", "ele"] } },
    ],
  };

  it("passes style layers through verbatim, only binding the source", () => {
    // The engine has no opinion about how contours or bathymetry look. That passthrough is
    // what lets `core` describe them without importing renderer types. (ADR-0011)
    const built = buildTileSource(VECTOR, 1);

    expect(built.source).toMatchObject({ type: "vector", url: VECTOR.url });
    expect(built.layers).toHaveLength(2);
    expect(built.layers[0]).toMatchObject({
      id: "contour-lines",
      type: "line",
      source: "contours",
      "source-layer": "contour",
      paint: { "line-width": 1 },
    });
  });

  it("names an unnamed layer after its source, so two sources cannot collide", () => {
    expect(buildTileSource(VECTOR, 1).layers[1]).toMatchObject({ id: "contours__layer-1" });
  });

  it("rejects a style layer that is not an object or has no type", () => {
    expect(() => buildTileSource({ ...VECTOR, styleLayers: ["not an object"] }, 1)).toThrow(
      /not an object/,
    );
    expect(() => buildTileSource({ ...VECTOR, styleLayers: [{ id: "x" }] }, 1)).toThrow(
      /no "type"/,
    );
  });

  it("produces no layers when none were given", () => {
    const bare = { ...VECTOR };
    delete bare.styleLayers;
    expect(buildTileSource(bare, 1).layers).toEqual([]);
  });
});

describe("elevation sources", () => {
  const DEM: TileSource = {
    id: "dem",
    kind: "raster-dem",
    url: "https://tiles.invalid/dem.json",
    attribution: "Elevation data",
    role: "terrain",
  };

  it("translates to a raster-dem source with a sensible default tile size and encoding", () => {
    expect(buildTileSource(DEM, 1).source).toMatchObject({
      type: "raster-dem",
      tileSize: 512,
      encoding: "mapbox",
    });
  });

  it("honours terrarium encoding when asked", () => {
    expect(buildTileSource({ ...DEM, encoding: "terrarium" }, 1).source).toMatchObject({
      encoding: "terrarium",
    });
  });

  it("draws nothing itself when its role is terrain", () => {
    // TerrainOptions points at it; a hillshade layer is the consumer's to add.
    expect(buildTileSource(DEM, 1).layers).toEqual([]);
  });

  it("carries style layers when used as a hillshade source", () => {
    const hillshade: TileSource = {
      ...DEM,
      role: "hillshade",
      styleLayers: [{ id: "shade", type: "hillshade", paint: { "hillshade-exaggeration": 0.5 } }],
    };
    expect(buildTileSource(hillshade, 1).layers[0]).toMatchObject({
      id: "shade",
      type: "hillshade",
      source: "dem",
    });
  });
});

describe("PMTiles", () => {
  const RASTER: TileSource = {
    id: "offline",
    kind: "pmtiles",
    url: "pmtiles://https://cdn.invalid/region.pmtiles",
    attribution: "© OpenStreetMap contributors",
  };

  it("is recognised by kind or by url scheme", () => {
    expect(usesPmtiles(RASTER)).toBe(true);
    expect(usesPmtiles({ ...RASTER, kind: "xyz" })).toBe(true);
    expect(usesPmtiles(OSM)).toBe(false);
  });

  it("produces a raster source for an archive with no style layers", () => {
    expect(buildTileSource(RASTER, 0).source).toMatchObject({ type: "raster" });
  });

  it("produces a vector source when style layers are present", () => {
    // The one inference in the builders: `kind: "pmtiles"` states a transport, not a
    // content type, and an archive holds either raster or vector tiles. Style layers are
    // meaningless for raster and mandatory for vector, so they decide it.
    const vector: TileSource = {
      ...RASTER,
      styleLayers: [{ id: "roads", type: "line", "source-layer": "roads" }],
    };
    expect(buildTileSource(vector, 0).source).toMatchObject({ type: "vector" });
    expect(buildTileSource(vector, 0).layers[0]).toMatchObject({ source: "offline" });
  });

  it("registers nothing and touches no global — the builders are pure", () => {
    // The protocol is a runtime capability owned by the controller. If this ever changes,
    // describing a source would start depending on a MapLibre runtime being present.
    const before = { ...globalThis } as Record<string, unknown>;
    buildTileSource(RASTER, 0);
    expect(Object.keys(globalThis as object)).toEqual(Object.keys(before));
  });
});

describe("the stack", () => {
  it("makes the first source the base and the rest overlays", () => {
    expect(resolveRole(OSM, 0)).toBe("base");
    expect(resolveRole(OSM, 1)).toBe("overlay");
    expect(resolveRole({ ...OSM, role: "hillshade" }, 0)).toBe("hillshade");
  });

  it("preserves order, because order is the contract", () => {
    const built = buildTileSources([OSM, { ...OSM, id: "seamarks" }, { ...OSM, id: "labels" }]);
    expect(built.map((entry) => entry.id)).toEqual(["osm", "seamarks", "labels"]);
    expect(built.map((entry) => entry.role)).toEqual(["base", "overlay", "overlay"]);
  });

  it("rejects two sources sharing an id", () => {
    // MapLibre would silently keep one of them, and the map would be missing a layer with
    // nothing to say why.
    expect(() => buildTileSources([OSM, { ...OSM }])).toThrow(/share this id/);
  });

  it("handles an empty stack", () => {
    expect(buildTileSources([])).toEqual([]);
  });

  it("is deterministic — the same input builds the same output", () => {
    const sources = [
      OSM,
      { ...OSM, id: "dem", kind: "raster-dem" as const, role: "terrain" as const },
    ];
    expect(JSON.stringify(buildTileSources(sources))).toBe(
      JSON.stringify(buildTileSources(sources)),
    );
  });

  it("does not mutate the sources it was given", () => {
    const sources = [OSM, { ...OSM, id: "second" }];
    const before = structuredClone(sources);
    buildTileSources(sources);
    expect(sources).toEqual(before);
  });
});
