// SPDX-License-Identifier: Apache-2.0
import type { TileSource } from "@mapatlas/core";
import { describe, expect, it } from "vitest";

import {
  PMTILES_SCHEME,
  TileSourceError,
  buildTileSource,
  buildTileSources,
  resolveRole,
  usesPmtiles,
} from "./tile-source.js";

const OSM: TileSource = {
  id: "osm",
  kind: "raster",
  transport: "template",
  url: "https://tiles.invalid/{z}/{x}/{y}.png",
  attribution: "© OpenStreetMap contributors",
};

describe("raster sources", () => {
  it("translates a template source into a raster source and one layer", () => {
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

  it("draws a hillshade input at zero opacity, whatever opacity was asked for", () => {
    // Rendering an elevation raster as flat imagery buries the map under grey. It is an
    // input to a hillshade layer the consumer supplies, not something to composite.
    const built = buildTileSource({ ...OSM, role: "hillshade", opacity: 0.9 }, 1);
    expect(built.layers[0]).toMatchObject({ paint: { "raster-opacity": 0 } });
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
    kind: "raster",
    transport: "wms",
    url: "https://wms.invalid/?BBOX={bbox-epsg-3857}&WIDTH=256&HEIGHT=256",
    attribution: "NOAA",
  };

  it("translates to a raster source whose url is a tile template", () => {
    expect(buildTileSource(WMS, 1).source).toMatchObject({ type: "raster", tiles: [WMS.url] });
  });

  it("rejects a url with no bbox placeholder", () => {
    // Without it every request asks for the same extent, so one tile's worth of imagery
    // renders everywhere and the map looks broken in a way nothing reports.
    expect(() => buildTileSource({ ...WMS, url: "https://wms.invalid/?LAYERS=charts" }, 1)).toThrow(
      /bbox placeholder/,
    );
  });

  it("rejects a non-raster content kind, because GetMap returns an image", () => {
    expect(() => buildTileSource({ ...WMS, kind: "vector" }, 1)).toThrow(
      /raster tiles, not vector/,
    );
    expect(() => buildTileSource({ ...WMS, kind: "raster-dem" }, 1)).toThrow(TileSourceError);
  });
});

describe("vector sources carry the consumer's own layers", () => {
  const VECTOR: TileSource = {
    id: "contours",
    kind: "vector",
    transport: "tilejson",
    url: "https://tiles.invalid/contours.json",
    attribution: "© Contour data",
    styleLayers: [
      { id: "contour-lines", type: "line", "source-layer": "contour", paint: { "line-width": 1 } },
      { type: "symbol", "source-layer": "contour", layout: { "text-field": ["get", "ele"] } },
    ],
  };

  it("passes style layers through verbatim, only binding the source and namespacing the id", () => {
    // The engine has no opinion about how contours or bathymetry look. That passthrough is
    // what lets `core` describe them without importing renderer types. (ADR-0011)
    const built = buildTileSource(VECTOR, 1);

    expect(built.source).toMatchObject({ type: "vector", url: VECTOR.url });
    expect(built.layers).toHaveLength(2);
    expect(built.layers[0]).toMatchObject({
      id: "contours__contour-lines",
      type: "line",
      source: "contours",
      "source-layer": "contour",
      paint: { "line-width": 1 },
    });
  });

  it("namespaces every layer id, supplied or not, so two sources cannot collide", () => {
    // The failure this prevents: two vector sources each carrying a layer called `labels`.
    // MapLibre keys layers by id, so without namespacing the second `addLayer` throws — or
    // worse, one source's labels are styled by the other's rules.
    const labels = [{ id: "labels", type: "symbol" as const, "source-layer": "place" }];
    const a = buildTileSource({ ...VECTOR, id: "a", styleLayers: labels }, 0);
    const b = buildTileSource({ ...VECTOR, id: "b", styleLayers: labels }, 1);

    expect(a.layers[0]).toMatchObject({ id: "a__labels", source: "a" });
    expect(b.layers[0]).toMatchObject({ id: "b__labels", source: "b" });
    expect(a.layers[0]?.id).not.toBe(b.layers[0]?.id);
  });

  it("names an unnamed layer after its source and position", () => {
    expect(buildTileSource(VECTOR, 1).layers[1]).toMatchObject({ id: "contours__layer-1" });
  });

  it("does not mutate the style layers it was given", () => {
    // They are the consumer's objects; the namespaced id belongs to the built output only.
    const before = structuredClone(VECTOR.styleLayers);
    buildTileSource(VECTOR, 1);
    expect(VECTOR.styleLayers).toEqual(before);
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

  it("accepts a raw tile template as well as a TileJSON document", () => {
    const template: TileSource = {
      ...VECTOR,
      transport: "template",
      url: "https://tiles.invalid/{z}/{x}/{y}.pbf",
    };
    expect(buildTileSource(template, 1).source).toMatchObject({
      type: "vector",
      tiles: ["https://tiles.invalid/{z}/{x}/{y}.pbf"],
    });
  });
});

describe("elevation sources", () => {
  const DEM: TileSource = {
    id: "dem",
    kind: "raster-dem",
    transport: "tilejson",
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
      id: "dem__shade",
      type: "hillshade",
      source: "dem",
    });
  });
});

describe("PMTiles is a transport, not a content type", () => {
  /** What a consumer writes: the archive's own location, with no renderer scheme on it. */
  const ARCHIVE = "https://cdn.invalid/region.pmtiles";

  const RASTER: TileSource = {
    id: "offline",
    kind: "raster",
    transport: "pmtiles",
    url: ARCHIVE,
    attribution: "© OpenStreetMap contributors",
  };

  it("is recognised by the declared transport, never guessed from the url or the layers", () => {
    expect(usesPmtiles(RASTER)).toBe(true);
    expect(usesPmtiles(OSM)).toBe(false);
  });

  it("adds MapLibre's protocol scheme exactly once, for every content kind", () => {
    // Two failures pinned together. The scheme is this renderer's — Leaflet builds a
    // `PMTiles` object from the plain location and knows nothing about `pmtiles://` — so the
    // builder adds it and the contract never carries it. And the archive location is handed
    // over whole: the handler resolves tiles out of the archive itself, so appending
    // `/{z}/{x}/{y}` would ask for a path that does not exist and the map would stay blank
    // with nothing in the console to explain it.
    const layers = [{ id: "roads", type: "line" as const, "source-layer": "roads" }];
    const kinds = [
      { source: RASTER, type: "raster" },
      { source: { ...RASTER, kind: "vector" as const, styleLayers: layers }, type: "vector" },
      { source: { ...RASTER, kind: "raster-dem" as const }, type: "raster-dem" },
    ];

    for (const { source, type } of kinds) {
      const built = buildTileSource(source, 0).source as Record<string, unknown>;
      const url = String(built["url"]);

      expect(built).toMatchObject({ type });
      expect(url).toBe(`${PMTILES_SCHEME}${ARCHIVE}`);
      // Exactly one, so a second pass over an already-built source cannot double it.
      expect(url.split(PMTILES_SCHEME)).toHaveLength(2);
      expect(url.slice(PMTILES_SCHEME.length)).toBe(ARCHIVE);
      expect(built).not.toHaveProperty("tiles");
      expect(url).not.toContain("{z}");
    }
  });

  it("leaves the scheme off every other transport", () => {
    // Only the PMTiles branch rewrites the url. A TileJSON document is fetched as given.
    const tilejson = buildTileSource(
      { ...RASTER, transport: "tilejson", url: "https://cdn.invalid/tiles.json" },
      0,
    ).source as Record<string, unknown>;
    expect(tilejson["url"]).toBe("https://cdn.invalid/tiles.json");
  });

  it("takes the content kind from `kind`, not from whether style layers are present", () => {
    // The defect this pins: a raster archive is raster whether or not the consumer supplied
    // layers, and a vector archive is vector whether or not they did. Inferring one from the
    // other renders the wrong source type with no error.
    const rasterWithLayers: TileSource = {
      ...RASTER,
      styleLayers: [{ id: "shade", type: "hillshade" }],
    };
    expect(buildTileSource(rasterWithLayers, 0).source).toMatchObject({ type: "raster" });

    const vectorWithout: TileSource = { ...RASTER, kind: "vector" };
    expect(buildTileSource(vectorWithout, 0).source).toMatchObject({ type: "vector" });
    expect(buildTileSource(vectorWithout, 0).layers).toEqual([]);
  });

  it("rejects a url that already carries the renderer's scheme, under any transport", () => {
    // `transport: "pmtiles"` already says the source is an archive, so a prefixed url is a
    // second representation of the same fact — and it is a MapLibre pseudo-scheme sitting in
    // a renderer-neutral type, which no other renderer can read. Accepting it would also
    // mean guessing whether to prefix again.
    const prefixed = `${PMTILES_SCHEME}${ARCHIVE}`;
    for (const transport of ["pmtiles", "tilejson", "template"] as const) {
      expect(() => buildTileSource({ ...RASTER, transport, url: prefixed }, 0)).toThrow(
        /renderer's to add/,
      );
    }
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
    const sources: TileSource[] = [
      OSM,
      { ...OSM, id: "dem", kind: "raster-dem", transport: "tilejson", role: "terrain" },
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
