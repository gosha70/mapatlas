// SPDX-License-Identifier: Apache-2.0
// @vitest-environment happy-dom
import type { JSONValue, MapEvent, TileSource, Track, TrackPoint } from "@mapatlas/core";
import type { LayerSpecification } from "maplibre-gl";

import type { MarkerStyle } from "../marks/marker-style.js";
import type { EventPresentation } from "../marks/presentation.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ENGINE_ID_PREFIX, ENGINE_LAYER, ENGINE_SOURCE } from "./engine-layers.js";
import type { MapConstructorOptions, MapEnvironment } from "./environment.js";
import type { FakeMap, FakeMarker, MapCall, PreinstalledStyleState } from "./fake-map.js";
import { createFakeMap, createFakeMarker } from "./fake-map.js";
import type * as ControllerModule from "./controller.js";
import type { MapControllerOptions } from "./controller.js";
import {
  EMPTY_STYLE,
  MapControllerDestroyedError,
  MapNamespaceCollisionError,
  MapTerrainError,
  createMapControllerInternal,
} from "./controller.js";

const OSM: TileSource = {
  id: "osm",
  kind: "raster",
  transport: "template",
  url: "https://tiles.invalid/{z}/{x}/{y}.png",
  attribution: "© OpenStreetMap contributors",
};

const SEAMARKS: TileSource = { ...OSM, id: "seamarks" };

const DEM: TileSource = {
  id: "dem",
  kind: "raster-dem",
  transport: "tilejson",
  url: "https://tiles.invalid/dem.json",
  attribution: "Elevation data",
  role: "terrain",
};

const ARCHIVE: TileSource = {
  id: "offline",
  kind: "raster",
  transport: "pmtiles",
  url: "https://cdn.invalid/region.pmtiles",
  attribution: "© OpenStreetMap contributors",
};

/** A short two-point track, enough to have a line, a start and a finish. */
function trackFixture(): Track {
  return {
    id: "trk-1",
    startedAt: 1_700_000_000_000,
    status: "finalized",
    origin: "recorded",
    points: [
      { lat: 59.33, lng: 18.06, t: 1_700_000_000_000 },
      { lat: 59.34, lng: 18.07, t: 1_700_000_060_000 },
    ],
    segments: [
      {
        id: "seg-1",
        startIndex: 0,
        endIndex: 1,
        startedAt: 1_700_000_000_000,
        endedAt: 1_700_000_060_000,
      },
    ],
  };
}

/** Two active spans with a pause between, so a connecting line would be visible if drawn. */
function twoSegmentFixture(): Track {
  return {
    ...trackFixture(),
    points: [
      { lat: 59.33, lng: 18.06, t: 1_700_000_000_000 },
      { lat: 59.34, lng: 18.07, t: 1_700_000_060_000 },
      { lat: 59.35, lng: 18.08, t: 1_700_000_600_000 },
      { lat: 59.36, lng: 18.09, t: 1_700_000_660_000 },
    ],
    segments: [
      {
        id: "seg-1",
        startIndex: 0,
        endIndex: 1,
        startedAt: 1_700_000_000_000,
        endedAt: 1_700_000_060_000,
      },
      {
        id: "seg-2",
        startIndex: 2,
        endIndex: 3,
        startedAt: 1_700_000_600_000,
        endedAt: 1_700_000_660_000,
      },
    ],
  };
}

/** A minimal consumer mark, for cases where the style itself is not what is under test. */
const EVENT_MARK: MarkerStyle = { ariaLabel: "A consumer mark" };

function eventFixture(id: string, lng: number): MapEvent {
  return {
    id,
    position: { lat: 59.33, lng },
    occurredAt: 1_700_000_030_000,
    media: [],
    tags: [],
  };
}

/** A container the controller only ever forwards; no DOM behaviour is exercised. */
const CONTAINER = {} as HTMLElement;

interface Harness {
  readonly map: FakeMap;
  readonly markers: FakeMarker[];
  readonly environment: MapEnvironment;
  readonly addProtocol: ReturnType<typeof vi.fn>;
  readonly createProtocol: ReturnType<typeof vi.fn>;
}

function harness(preinstalled: PreinstalledStyleState = {}): Harness {
  let map: FakeMap | undefined;
  const addProtocol = vi.fn();
  const createProtocol = vi.fn(() => ({ tile: () => undefined }));
  const markers: FakeMarker[] = [];
  const environment: MapEnvironment = {
    createMap(options: MapConstructorOptions): FakeMap {
      map = createFakeMap(options, preinstalled);
      return map;
    },
    createMarker(element: HTMLElement, options) {
      const marker = createFakeMarker(element, options);
      markers.push(marker);
      return marker;
    },
    // A real DOM, so the accessibility contract is asserted against an implementation of it
    // rather than against a stand-in that agrees with whatever the code does.
    document: globalThis.document,
    protocolRegistrar: { addProtocol, createProtocol },
  };
  return {
    get map(): FakeMap {
      if (map === undefined) throw new Error("no map was constructed");
      return map;
    },
    markers,
    environment,
    addProtocol,
    createProtocol,
  };
}

/** Markers that are still on the map, in creation order. */
function placed(rig: Harness): FakeMarker[] {
  return rig.markers.filter((marker) => marker.attached && !marker.removed);
}

function mount(
  options: Partial<MapControllerOptions> = {},
  preinstalled: PreinstalledStyleState = {},
): {
  controller: ReturnType<typeof createMapControllerInternal>;
  harness: Harness;
} {
  const rig = harness(preinstalled);
  const controller = createMapControllerInternal(
    { container: CONTAINER, sources: [], ...options },
    rig.environment,
  );
  return { controller, harness: rig };
}

/**
 * Calls about consumer state only.
 *
 * Engine sources, layers and their data updates interleave with the consumer's, and a test
 * about what `setSources` did should not have to know how many layers the engine happens to
 * install. Filtering here keeps those assertions about one registry at a time.
 */
function consumerCalls(map: FakeMap): readonly MapCall[] {
  return map.calls.filter((call) => {
    if (call.op === "setSourceData") return false;
    if ("id" in call && call.id.startsWith(ENGINE_ID_PREFIX)) return false;
    if ("source" in call && typeof call.source === "string") {
      return !call.source.startsWith(ENGINE_ID_PREFIX);
    }
    return true;
  });
}

/** Consumer layer ids in the order they were added, which is the order MapLibre draws them. */
function addedLayers(map: FakeMap): string[] {
  return consumerCalls(map)
    .filter((call) => call.op === "addLayer")
    .map((call) => call.id);
}

/**
 * The two registries, kept apart in the assertions as they are in the controller.
 *
 * Engine sources and layers are installed once and survive every stack replacement, so a
 * test about what `setSources` did has no business seeing them — and one about the engine's
 * own state has no business seeing the consumer's.
 */
function consumerSourceIds(map: FakeMap): string[] {
  return map.sourceIds.filter((id) => !id.startsWith(ENGINE_ID_PREFIX));
}

function consumerLayerIds(map: FakeMap): string[] {
  return map.layerIds.filter((id) => !id.startsWith(ENGINE_ID_PREFIX));
}

function engineLayerIds(map: FakeMap): string[] {
  return map.layerIds.filter((id) => id.startsWith(ENGINE_ID_PREFIX));
}

describe("installation waits for the style to load", () => {
  it("touches nothing before load", () => {
    // MapLibre rejects addSource and addLayer until the style is ready, so an eager
    // controller would throw on construction rather than render a basemap.
    const { harness: rig } = mount({ sources: [OSM] });

    expect(rig.map.calls).toEqual([]);
    expect(consumerSourceIds(rig.map)).toEqual([]);
  });

  it("installs the stack when load fires", () => {
    const { harness: rig } = mount({ sources: [OSM] });

    rig.map.fireLoad();

    expect(consumerSourceIds(rig.map)).toEqual(["osm"]);
    expect(addedLayers(rig.map)).toEqual(["osm__raster"]);
  });

  it("installs only the latest desired stack, never the ones it replaced", () => {
    // The case that separates desired state from a command log. Two calls arrive before the
    // map can accept either; a queue would install A, tear it down and install B, so the
    // map would briefly show a stack nobody ever asked to see — and every source in A would
    // be fetched for nothing.
    const { controller, harness: rig } = mount({ sources: [] });

    controller.setSources([OSM]);
    controller.setSources([SEAMARKS]);
    rig.map.fireLoad();

    expect(consumerSourceIds(rig.map)).toEqual(["seamarks"]);
    expect(consumerCalls(rig.map).filter((call) => call.op === "addSource")).toHaveLength(1);
    // Not "added then removed": A was never installed at all.
    expect(consumerCalls(rig.map).some((call) => call.op === "removeSource")).toBe(false);
    expect(consumerCalls(rig.map).some((call) => "id" in call && call.id === "osm")).toBe(false);
  });

  it("rejects an invalid stack at the call, not from inside the load callback", () => {
    // Storing raw sources would make rejection asynchronous: this call would return
    // successfully, then throw from inside MapLibre's `load` handler where no caller can
    // catch it — and the last valid stack would already have been abandoned.
    const { controller, harness: rig } = mount({ sources: [OSM] });

    expect(() => {
      controller.setSources([{ ...SEAMARKS, attribution: "" }]);
    }).toThrow(/attribution/);

    rig.map.fireLoad();

    // The rejected stack never became the desired one.
    expect(consumerSourceIds(rig.map)).toEqual(["osm"]);
  });

  it("installs the state it was handed, not what the caller mutated afterwards", () => {
    // The scenario: a nested `paint` handed to setSources, mutated before the style loads.
    // With the layers aliased the map would receive 20, so "validated at the call" would be
    // a claim about the top level only — a caller could still mutate a nested value into
    // something MapLibre rejects and put the load-time failure back.
    const paint: Record<string, JSONValue> = { "line-width": 1 };
    const vector: TileSource = {
      id: "contours",
      kind: "vector",
      transport: "tilejson",
      url: "https://tiles.invalid/contours.json",
      attribution: "© Contour data",
      styleLayers: [{ id: "lines", type: "line", "source-layer": "contour", paint }],
    };
    const { controller, harness: rig } = mount({ sources: [] });

    controller.setSources([vector]);
    paint["line-width"] = 20;
    rig.map.fireLoad();

    expect(
      rig.map.layerSpecs.find((layer) => !layer.id.startsWith(ENGINE_ID_PREFIX)),
    ).toMatchObject({
      id: "contours__lines",
      paint: { "line-width": 1 },
    });
  });

  it("refuses to construct at all when the initial stack is invalid", () => {
    // And leaves no map behind: a WebGL context belonging to a controller the caller never
    // receives is a leak nothing can close.
    const rig = harness();

    expect(() =>
      createMapControllerInternal(
        { container: CONTAINER, sources: [{ ...OSM, attribution: "" }] },
        rig.environment,
      ),
    ).toThrow(/attribution/);
    expect(() => rig.map).toThrow(/no map was constructed/);
  });

  it("reconciles exactly once even if load fires again", () => {
    const { harness: rig } = mount({ sources: [OSM] });

    rig.map.fireLoad();
    rig.map.fireLoad();

    expect(consumerCalls(rig.map).filter((call) => call.op === "addSource")).toHaveLength(1);
  });

  it("does not install for a controller destroyed before its style loaded", () => {
    const { controller, harness: rig } = mount({ sources: [OSM] });

    controller.destroy();
    rig.map.fireLoad();

    expect(consumerSourceIds(rig.map)).toEqual([]);
  });
});

describe("the stack is installed in declared order", () => {
  it("adds sources and their layers base first, then overlays", () => {
    // MapLibre draws layers in the order they are added, so this order *is* the visual
    // stack: a base added after an overlay hides it.
    const vector: TileSource = {
      id: "contours",
      kind: "vector",
      transport: "tilejson",
      url: "https://tiles.invalid/contours.json",
      attribution: "© Contour data",
      styleLayers: [
        { id: "lines", type: "line", "source-layer": "contour" },
        { id: "labels", type: "symbol", "source-layer": "contour" },
      ],
    };
    const { harness: rig } = mount({ sources: [OSM, SEAMARKS, vector] });

    rig.map.fireLoad();

    expect(consumerSourceIds(rig.map)).toEqual(["osm", "seamarks", "contours"]);
    expect(addedLayers(rig.map)).toEqual([
      "osm__raster",
      "seamarks__raster",
      "contours__lines",
      "contours__labels",
    ]);
  });
});

describe("replacing the stack after load", () => {
  it("removes every old layer before any old source", () => {
    // MapLibre refuses to remove a source a layer still references. The fake enforces that,
    // so getting this backwards fails here rather than in a browser.
    const { controller, harness: rig } = mount({ sources: [OSM, SEAMARKS] });
    rig.map.fireLoad();

    controller.setSources([{ ...OSM, id: "replacement" }]);

    const ops = consumerCalls(rig.map).map((call) => call.op);
    const lastRemovedLayer = ops.lastIndexOf("removeLayer");
    const firstRemovedSource = ops.indexOf("removeSource");
    expect(lastRemovedLayer).toBeLessThan(firstRemovedSource);
    expect(consumerSourceIds(rig.map)).toEqual(["replacement"]);
    expect(consumerLayerIds(rig.map)).toEqual(["replacement__raster"]);
  });

  it("adds the new stack only after the old one is gone", () => {
    const { controller, harness: rig } = mount({ sources: [OSM] });
    rig.map.fireLoad();

    controller.setSources([SEAMARKS]);

    const ops = consumerCalls(rig.map).map((call) => call.op);
    expect(ops.lastIndexOf("removeSource")).toBeLessThan(ops.indexOf("addSource", 1));
  });

  it("reuses an id the previous stack held, having removed it first", () => {
    // Same id, different definition. Without a clean teardown the fake reports a duplicate,
    // which is exactly what the real map does.
    const { controller, harness: rig } = mount({ sources: [OSM] });
    rig.map.fireLoad();

    expect(() => {
      controller.setSources([{ ...OSM, url: "https://other.invalid/{z}/{x}/{y}.png" }]);
    }).not.toThrow();
    expect(consumerSourceIds(rig.map)).toEqual(["osm"]);
  });

  it("leaves the visible map intact when the new stack is invalid", () => {
    // The same guarantee as before load, at the other moment: translation happens at the
    // call, so a rejected setSources is a no-op rather than a half-torn-down map showing
    // nothing.
    const { controller, harness: rig } = mount({ sources: [OSM] });
    rig.map.fireLoad();
    const before = [...rig.map.calls];

    expect(() => {
      controller.setSources([{ ...SEAMARKS, attribution: "" }]);
    }).toThrow(/attribution/);

    expect(rig.map.calls).toEqual(before);
    expect(consumerSourceIds(rig.map)).toEqual(["osm"]);
  });
});

describe("map construction", () => {
  it("supplies an explicit empty style when the consumer names none", () => {
    // MapLibre documents that a map built with no style needs setStyle() before it renders,
    // so leaving it out hands the consumer a map that silently does nothing.
    const { harness: rig } = mount();
    expect(rig.map.options.style).toBe(EMPTY_STYLE);
    expect(EMPTY_STYLE).toMatchObject({ version: 8, sources: {}, layers: [] });
  });

  it("passes a consumer style through untouched", () => {
    const style = "https://styles.invalid/topo.json";
    const { harness: rig } = mount({ style });
    expect(rig.map.options.style).toBe(style);
  });

  it("never inherits MapLibre's default attribution control", () => {
    // The default control ships MapLibre's own attribution. ADR-0008 says the engine does
    // not put a library's branding in a consumer's app, so the option is always given.
    const { harness: rig } = mount();
    expect(rig.map.options.attributionControl).toEqual({ customAttribution: [] });
  });

  it("carries an engine-owned attribution prefix when one is given", () => {
    const { harness: rig } = mount({ attributionPrefix: "MAP-ATLAS" });
    expect(rig.map.options.attributionControl).toEqual({ customAttribution: ["MAP-ATLAS"] });
  });

  it("hands MapLibre a lng/lat pair, not a lat/lng one", () => {
    // Silently swapping these puts the map in the wrong hemisphere and nothing reports it.
    const { harness: rig } = mount({ center: { lat: 59.33, lng: 18.07 }, zoom: 11 });
    expect(rig.map.options.center).toEqual([18.07, 59.33]);
    expect(rig.map.options.zoom).toBe(11);
  });

  it("omits center and zoom that were not given, rather than inventing them", () => {
    const { harness: rig } = mount();
    expect(rig.map.options).not.toHaveProperty("center");
    expect(rig.map.options).not.toHaveProperty("zoom");
  });
});

describe("destroy", () => {
  it("removes the map and stops listening for load", () => {
    const { controller, harness: rig } = mount({ sources: [OSM] });

    controller.destroy();

    expect(rig.map.calls.at(-1)).toEqual({ op: "remove" });
    expect(rig.map.loadListenerCount).toBe(0);
  });

  it("is idempotent", () => {
    const { controller, harness: rig } = mount();

    controller.destroy();
    controller.destroy();

    expect(rig.map.calls.filter((call) => call.op === "remove")).toHaveLength(1);
  });

  it("rejects a later setSources rather than acting on a removed map", () => {
    const { controller } = mount();
    controller.destroy();
    expect(() => {
      controller.setSources([OSM]);
    }).toThrow(MapControllerDestroyedError);
  });
});

describe("the PMTiles protocol is realm infrastructure", () => {
  let controller: typeof ControllerModule;

  beforeEach(async () => {
    // A fresh realm, so registration starts unregistered. The module exports no reset: it
    // would be production code shipped for tests, and a consumer could use it to make a
    // second registration possible.
    vi.resetModules();
    controller = await import("./controller.js");
  });

  function mountIn(sources: TileSource[]): Harness {
    const rig = harness();
    controller.createMapControllerInternal({ container: CONTAINER, sources }, rig.environment);
    rig.map.fireLoad();
    return rig;
  }

  it("registers once across controllers, and never for one that needs it", () => {
    // The sequence the reviewer named: A has no PMTiles source, B and C do.
    const a = mountIn([OSM]);
    expect(a.createProtocol).not.toHaveBeenCalled();
    expect(a.addProtocol).not.toHaveBeenCalled();

    const b = mountIn([ARCHIVE]);
    expect(b.addProtocol).toHaveBeenCalledTimes(1);
    expect(b.addProtocol).toHaveBeenCalledWith("pmtiles", expect.anything());

    const c = mountIn([{ ...ARCHIVE, id: "second-archive" }]);
    expect(c.createProtocol).not.toHaveBeenCalled();
    expect(c.addProtocol).not.toHaveBeenCalled();
  });

  it("registers before the source that needs it is added", () => {
    const rig = harness();
    const order: string[] = [];
    rig.addProtocol.mockImplementation(() => order.push("addProtocol"));
    const recording = {
      ...rig.environment,
      createMap: (options: MapConstructorOptions) => {
        const map = rig.environment.createMap(options);
        return {
          ...map,
          addSource: (id: string, source: never) => {
            // Engine sources are installed in the same pass; only the PMTiles one is what
            // this ordering claim is about.
            if (!id.startsWith(ENGINE_ID_PREFIX)) order.push("addSource");
            map.addSource(id, source);
          },
        };
      },
    };
    const created = controller.createMapControllerInternal(
      { container: CONTAINER, sources: [ARCHIVE] },
      recording,
    );
    rig.map.fireLoad();

    expect(order).toEqual(["addProtocol", "addSource"]);
    created.destroy();
  });

  it("leaves the protocol registered when a controller that used it is destroyed", () => {
    // The failure this prevents: controller A registers, B is created, A is destroyed and
    // tears down the handler, and B breaks having done nothing wrong.
    const b = mountIn([ARCHIVE]);
    expect(b.addProtocol).toHaveBeenCalledTimes(1);

    const second = harness();
    const destroyable = controller.createMapControllerInternal(
      { container: CONTAINER, sources: [ARCHIVE] },
      second.environment,
    );
    second.map.fireLoad();
    destroyable.destroy();

    // Still registered: a third controller finds it and constructs nothing.
    const third = mountIn([{ ...ARCHIVE, id: "third-archive" }]);
    expect(third.createProtocol).not.toHaveBeenCalled();
    expect(third.addProtocol).not.toHaveBeenCalled();
  });
});

describe("terrain is prepared desired state over the source stack", () => {
  /** Terrain operations only, so an assertion reads as a sequence rather than a filter. */
  function terrainCalls(map: FakeMap): (string | null)[] {
    return map.calls.filter((call) => call.op === "setTerrain").map((call) => call.source);
  }

  it("reaches MapLibre only at load, and only after the sources it names", () => {
    const { controller, harness: rig } = mount({ sources: [OSM, DEM] });

    controller.setTerrain({ sourceId: "dem" });
    expect(terrainCalls(rig.map)).toEqual([]);

    rig.map.fireLoad();

    const ops = consumerCalls(rig.map).map((call) => call.op);
    expect(ops.indexOf("setTerrain")).toBeGreaterThan(ops.lastIndexOf("addSource"));
    expect(rig.map.terrain).toEqual({ source: "dem", exaggeration: 1 });
  });

  it("applies only the last terrain asked for before load", () => {
    // The terrain half of the desired-state rule: three calls, none of which reach a map
    // that cannot accept them, and exactly one that does.
    const second: TileSource = { ...DEM, id: "dem2" };
    const { controller, harness: rig } = mount({ sources: [OSM, DEM, second] });

    controller.setTerrain({ sourceId: "dem" });
    controller.setTerrain(null);
    controller.setTerrain({ sourceId: "dem2", exaggeration: 2 });
    expect(terrainCalls(rig.map)).toEqual([]);

    rig.map.fireLoad();

    expect(terrainCalls(rig.map)).toEqual(["dem2"]);
    expect(rig.map.terrain).toEqual({ source: "dem2", exaggeration: 2 });
  });

  it("takes terrain from the constructor as well", () => {
    const { harness: rig } = mount({ sources: [OSM, DEM], terrain: { sourceId: "dem" } });
    rig.map.fireLoad();
    expect(rig.map.terrain).toEqual({ source: "dem", exaggeration: 1 });
  });

  it("replaces terrain directly after load, with no null between", () => {
    // MapLibre takes a new definition straight. A `null` here would drop the render-to-
    // texture state and rebuild it for nothing.
    const second: TileSource = { ...DEM, id: "dem2" };
    const { controller, harness: rig } = mount({ sources: [OSM, DEM, second] });
    rig.map.fireLoad();

    controller.setTerrain({ sourceId: "dem" });
    controller.setTerrain({ sourceId: "dem2" });

    expect(terrainCalls(rig.map)).toEqual(["dem", "dem2"]);
  });

  it("disables terrain, and does not resurrect it on a later stack change", () => {
    const { controller, harness: rig } = mount({ sources: [OSM, DEM] });
    rig.map.fireLoad();
    controller.setTerrain({ sourceId: "dem" });

    controller.setTerrain(null);
    expect(rig.map.terrain).toBeNull();

    controller.setSources([OSM, DEM]);
    expect(rig.map.terrain).toBeNull();
    expect(terrainCalls(rig.map)).toEqual(["dem", null]);
  });

  it("clears terrain a base style brought, which it never applied but does own", () => {
    // MapLibre honours a style's own `terrain` as the style loads, before the controller has
    // done anything. A remembered "what I applied" flag starts at null and would leave that
    // terrain running under a controller reporting none — so applied state is read from the
    // map, which cannot drift.
    const style = { version: 8, sources: {}, layers: [], terrain: { source: "style-dem" } };
    const { harness: rig } = mount({ sources: [OSM], style });
    expect(rig.map.terrain).toEqual({ source: "style-dem" });

    rig.map.fireLoad();

    expect(rig.map.terrain).toBeNull();
  });

  it("replaces a base style's terrain with its own", () => {
    const style = { version: 8, sources: {}, layers: [], terrain: { source: "style-dem" } };
    const { harness: rig } = mount({
      sources: [OSM, DEM],
      style,
      terrain: { sourceId: "dem", exaggeration: 2 },
    });

    rig.map.fireLoad();

    expect(rig.map.terrain).toEqual({ source: "dem", exaggeration: 2 });
  });

  it("clears a base style's terrain on an explicit setTerrain(null) after load", () => {
    const style = { version: 8, sources: {}, layers: [], terrain: { source: "style-dem" } };
    const { controller, harness: rig } = mount({
      sources: [OSM, DEM],
      style,
      terrain: { sourceId: "dem" },
    });
    rig.map.fireLoad();

    controller.setTerrain(null);

    expect(rig.map.terrain).toBeNull();
  });

  it("says nothing to MapLibre when clearing terrain that was never applied", () => {
    const { controller, harness: rig } = mount({ sources: [OSM, DEM] });
    rig.map.fireLoad();

    controller.setTerrain(null);

    expect(terrainCalls(rig.map)).toEqual([]);
  });
});

describe("terrain is validated at the call", () => {
  it("rejects a source that is not in the desired stack", () => {
    // Against *desired* sources, not what the map holds — before load it holds nothing, so
    // validating against the map would accept everything and fail later.
    const { controller } = mount({ sources: [OSM] });
    expect(() => {
      controller.setTerrain({ sourceId: "dem" });
    }).toThrow(/no source "dem" in the stack/);
  });

  it("rejects a source that is not an elevation raster", () => {
    // The one check MapLibre makes at no point: terrain over a raster source renders flat,
    // which is indistinguishable from a DEM that failed to load.
    const { controller } = mount({ sources: [OSM] });
    expect(() => {
      controller.setTerrain({ sourceId: "osm" });
    }).toThrow(/is kind "raster", not "raster-dem"/);
  });

  it("accepts a DEM whatever role it plays, since kind states the capability", () => {
    const hillshade: TileSource = { ...DEM, role: "hillshade" };
    const { controller, harness: rig } = mount({ sources: [OSM, hillshade] });
    rig.map.fireLoad();

    expect(() => {
      controller.setTerrain({ sourceId: "dem" });
    }).not.toThrow();
  });

  it("rejects an exaggeration the style spec does not allow, but accepts zero", () => {
    // MapLibre 6.6 validates this too; the difference is when. Here it lands on the caller,
    // rather than from inside a load callback nobody can catch.
    const { controller } = mount({ sources: [OSM, DEM] });

    for (const exaggeration of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => {
        controller.setTerrain({ sourceId: "dem", exaggeration });
      }).toThrow(MapTerrainError);
    }
    // Flat terrain is still terrain, and the spec allows it.
    expect(() => {
      controller.setTerrain({ sourceId: "dem", exaggeration: 0 });
    }).not.toThrow();
  });

  it("leaves the previous terrain in place when a new one is rejected", () => {
    const { controller, harness: rig } = mount({ sources: [OSM, DEM] });
    rig.map.fireLoad();
    controller.setTerrain({ sourceId: "dem", exaggeration: 3 });

    expect(() => {
      controller.setTerrain({ sourceId: "osm" });
    }).toThrow(MapTerrainError);

    expect(rig.map.terrain).toEqual({ source: "dem", exaggeration: 3 });
  });

  it("rejects a controller constructed with terrain the stack cannot support", () => {
    const rig = harness();
    expect(() =>
      createMapControllerInternal(
        { container: CONTAINER, sources: [OSM], terrain: { sourceId: "dem" } },
        rig.environment,
      ),
    ).toThrow(MapTerrainError);
    expect(() => rig.map).toThrow(/no map was constructed/);
  });
});

describe("a stack replacement is atomic with respect to terrain", () => {
  it("releases terrain, tears down, rebuilds, then restores it — in that order", () => {
    // The fake refuses to remove a source terrain still holds — a rule MAP-ATLAS enforces
    // and MapLibre 6.6 does not — so this order is a behavioural requirement rather than an
    // assertion about a log.
    const { controller, harness: rig } = mount({ sources: [OSM, DEM] });
    rig.map.fireLoad();
    controller.setTerrain({ sourceId: "dem", exaggeration: 2 });
    const fromConsumer = consumerCalls(rig.map).length;

    controller.setSources([SEAMARKS, DEM]);

    // One layer each way, not two: the DEM is `role: "terrain"`, so it draws nothing itself.
    expect(
      consumerCalls(rig.map)
        .slice(fromConsumer)
        .map((call) => call.op),
    ).toEqual([
      "setTerrain",
      "removeLayer",
      "removeSource",
      "removeSource",
      "addSource",
      "addLayer",
      "addSource",
      "setTerrain",
    ]);
    expect(
      consumerCalls(rig.map)
        .slice(fromConsumer)
        .filter((call) => call.op === "setTerrain"),
    ).toEqual([
      { op: "setTerrain", source: null },
      { op: "setTerrain", source: "dem" },
    ]);
    expect(rig.map.terrain).toEqual({ source: "dem", exaggeration: 2 });
    expect(consumerSourceIds(rig.map)).toEqual(["seamarks", "dem"]);
  });

  it("rejects a stack that would orphan terrain, touching nothing", () => {
    const { controller, harness: rig } = mount({ sources: [OSM, DEM] });
    rig.map.fireLoad();
    controller.setTerrain({ sourceId: "dem" });
    const before = [...rig.map.calls];

    expect(() => {
      controller.setSources([OSM]);
    }).toThrow(/no source "dem" in the stack/);

    expect(rig.map.calls).toEqual(before);
    expect(consumerSourceIds(rig.map)).toEqual(["osm", "dem"]);
    expect(rig.map.terrain).toEqual({ source: "dem", exaggeration: 1 });
  });

  it("does not adopt a stack it rejected, even before anything is installed", () => {
    // The map-untouched assertions above cannot see this one: before load there is nothing
    // to touch. Assigning the prospective sources and *then* checking terrain would leave
    // the rejected stack as desired state, and load would install it — a call that threw
    // having changed what the map ends up showing. Hence: nothing is assigned until both
    // the sources and the standing terrain pass.
    const { controller, harness: rig } = mount({ sources: [OSM, DEM] });
    controller.setTerrain({ sourceId: "dem" });

    expect(() => {
      controller.setSources([SEAMARKS]);
    }).toThrow(/no source "dem" in the stack/);

    rig.map.fireLoad();

    expect(consumerSourceIds(rig.map)).toEqual(["osm", "dem"]);
    expect(rig.map.terrain).toEqual({ source: "dem", exaggeration: 1 });
  });

  it("rejects a stack that keeps the id but changes the source's kind", () => {
    // The subtler orphaning: the id resolves, so a presence check would pass, but the
    // source is no longer an elevation raster and terrain over it would render flat.
    const { controller, harness: rig } = mount({ sources: [OSM, DEM] });
    rig.map.fireLoad();
    controller.setTerrain({ sourceId: "dem" });

    const flattened: TileSource = { ...OSM, id: "dem" };
    expect(() => {
      controller.setSources([OSM, flattened]);
    }).toThrow(/is kind "raster", not "raster-dem"/);

    expect(rig.map.terrain).toEqual({ source: "dem", exaggeration: 1 });
  });

  it("carries the exaggeration through a replacement unchanged", () => {
    const { controller, harness: rig } = mount({ sources: [OSM, DEM] });
    rig.map.fireLoad();
    controller.setTerrain({ sourceId: "dem", exaggeration: 0 });

    controller.setSources([DEM]);

    expect(rig.map.terrain).toEqual({ source: "dem", exaggeration: 0 });
  });

  it("rejects setTerrain after destroy", () => {
    const { controller } = mount({ sources: [OSM, DEM] });
    controller.destroy();
    expect(() => {
      controller.setTerrain({ sourceId: "dem" });
    }).toThrow(MapControllerDestroyedError);
  });
});

describe("engine state is namespaced, persistent, and out of the consumer's way", () => {
  it("rejects a consumer source claiming the reserved prefix, before anything changes", () => {
    // Same treatment a duplicate id gets: MapLibre keys by id, so a collision means one of
    // them silently wins — and here the loser would be the user's own track.
    const { controller, harness: rig } = mount({ sources: [OSM] });
    rig.map.fireLoad();
    const before = [...rig.map.calls];

    expect(() => {
      controller.setSources([{ ...OSM, id: `${ENGINE_ID_PREFIX}track` }]);
    }).toThrow(/reserved for engine-owned/);

    expect(rig.map.calls).toEqual(before);
    expect(consumerSourceIds(rig.map)).toEqual(["osm"]);
  });

  it("rejects it at construction too, before a map exists", () => {
    const rig = harness();
    expect(() =>
      createMapControllerInternal(
        { container: CONTAINER, sources: [{ ...OSM, id: `${ENGINE_ID_PREFIX}anything` }] },
        rig.environment,
      ),
    ).toThrow(/reserved for engine-owned/);
    expect(() => rig.map).toThrow(/no map was constructed/);
  });

  it("installs its own sources and layers once, at load", () => {
    const { harness: rig } = mount({ sources: [OSM] });
    rig.map.fireLoad();

    expect(rig.map.sourceIds).toContain(ENGINE_SOURCE.track);
    expect(rig.map.sourceIds).toContain(ENGINE_SOURCE.draft);
    expect(engineLayerIds(rig.map)).toEqual([
      ENGINE_LAYER.trackLine,
      ENGINE_LAYER.trackLineDashed,
      ENGINE_LAYER.draftLine,
      ENGINE_LAYER.draftVertex,
    ]);
  });

  it("keeps consumer layers below every engine layer, across a replacement", () => {
    // The ordering trap: MapLibre draws in add order, so a basemap added after a persistent
    // track layer lands on top of it and hides the track. Consumer layers go in *before* the
    // engine anchor instead, which also means the engine's layers are never torn down.
    const { controller, harness: rig } = mount({ sources: [OSM] });
    rig.map.fireLoad();
    expect(rig.map.layerIds).toEqual(["osm__raster", ...Object.values(ENGINE_LAYER)]);

    controller.setSources([SEAMARKS, { ...OSM, id: "labels" }]);

    expect(rig.map.layerIds).toEqual([
      "seamarks__raster",
      "labels__raster",
      ...Object.values(ENGINE_LAYER),
    ]);
  });

  it("leaves engine sources and layers untouched when the consumer stack is replaced", () => {
    const { controller, harness: rig } = mount({ sources: [OSM] });
    rig.map.fireLoad();
    const from = rig.map.calls.length;

    controller.setSources([SEAMARKS]);

    const touched = rig.map.calls
      .slice(from)
      .filter((call) => call.op === "removeLayer" || call.op === "removeSource")
      .map((call) => call.id);
    expect(touched.filter((id) => id.startsWith(ENGINE_ID_PREFIX))).toEqual([]);
    expect(rig.map.sourceIds).toContain(ENGINE_SOURCE.track);
  });
});

describe("rendering a track", () => {
  const TRACK = trackFixture();

  it("waits for load, then fills the persistent source", () => {
    const { controller, harness: rig } = mount({ sources: [OSM] });

    controller.renderTrack(TRACK);
    expect(rig.map.calls.some((call) => call.op === "setSourceData")).toBe(false);

    rig.map.fireLoad();

    expect(rig.map.data(ENGINE_SOURCE.track)?.features).toHaveLength(1);
  });

  it("applies only the last track asked for before load", () => {
    const { controller, harness: rig } = mount({ sources: [OSM] });

    controller.renderTrack(TRACK);
    controller.renderTrack(null);
    rig.map.fireLoad();

    expect(rig.map.data(ENGINE_SOURCE.track)?.features).toEqual([]);
  });

  it("clears with an empty collection rather than removing the source", () => {
    // Removing and reinstating would churn the layer stack and drift the draw order — and a
    // track that comes back would have to reinstate everything under it.
    const { controller, harness: rig } = mount({ sources: [OSM] });
    rig.map.fireLoad();
    controller.renderTrack(TRACK);

    controller.renderTrack(null);

    expect(rig.map.data(ENGINE_SOURCE.track)).toEqual({ type: "FeatureCollection", features: [] });
    expect(rig.map.sourceIds).toContain(ENGINE_SOURCE.track);
    expect(rig.map.layerIds).toContain(ENGINE_LAYER.trackLine);
  });

  it("emits one line per segment and no geometry across a pause", () => {
    const { controller, harness: rig } = mount({ sources: [OSM] });
    rig.map.fireLoad();

    controller.renderTrack(twoSegmentFixture());

    const features = rig.map.data(ENGINE_SOURCE.track)?.features ?? [];
    expect(features).toHaveLength(2);
    for (const feature of features) {
      expect(feature.geometry.type).toBe("LineString");
      expect((feature.geometry as { coordinates: unknown[] }).coordinates.length).toBeGreaterThan(
        1,
      );
    }
  });

  it("places start and finish marks, and moves them rather than rebuilding on re-render", () => {
    // Rebuilding the element would drop focus, which is exactly what a keyboard user would
    // be holding when the track updates underneath them.
    const { controller, harness: rig } = mount({ sources: [OSM] });
    rig.map.fireLoad();

    controller.renderTrack(TRACK);
    const first = placed(rig);
    expect(first).toHaveLength(2);

    controller.renderTrack(TRACK);

    expect(placed(rig)).toEqual(first);
    expect(rig.markers).toHaveLength(2);
  });

  it("removes marks when the track goes", () => {
    const { controller, harness: rig } = mount({ sources: [OSM] });
    rig.map.fireLoad();
    controller.renderTrack(TRACK);

    controller.renderTrack(null);

    expect(placed(rig)).toEqual([]);
    expect(rig.markers.every((marker) => marker.removed)).toBe(true);
  });
});

describe("rendering events", () => {
  it("places one mark per event and keeps the track's own marks", () => {
    const { controller, harness: rig } = mount({ sources: [OSM] });
    rig.map.fireLoad();
    controller.renderTrack(trackFixture());

    controller.renderEvents([eventFixture("e1", 18.06), eventFixture("e2", 18.07)]);

    // Two track marks plus two event marks: rendering events must not strand the marks the
    // track contributed to the same marker set.
    expect(placed(rig)).toHaveLength(4);
  });

  it("clears them with an empty list", () => {
    const { controller, harness: rig } = mount({ sources: [OSM] });
    rig.map.fireLoad();
    controller.renderEvents([eventFixture("e1", 18.06)]);

    controller.renderEvents([]);

    expect(placed(rig)).toEqual([]);
  });
});

describe("every mark the engine places is accessible", () => {
  it("carries a name, a role, and a tab stop, with the consumer's markup inside", () => {
    // A marker is not accessible for having an aria-label. The engine owns the wrapper so a
    // consumer cannot ship a mark with no accessible name, and so the markup it does supply —
    // inserted verbatim, and consumer-trusted — is hidden from assistive tech rather than
    // read out twice.
    const { controller, harness: rig } = mount({ sources: [OSM] });
    rig.map.fireLoad();

    controller.renderTrack(trackFixture());

    for (const marker of placed(rig)) {
      expect(marker.element.getAttribute("aria-label")).toBeTruthy();
      expect(marker.element.getAttribute("role")).toBe("img");
      expect(marker.element.className).toContain("mapatlas-marker");
      expect(marker.element.querySelector("[aria-hidden='true']")).not.toBeNull();
    }
  });

  it("names start and finish distinctly, so they are not two identical stops", () => {
    const { controller, harness: rig } = mount({ sources: [OSM] });
    rig.map.fireLoad();

    controller.renderTrack(trackFixture());

    const labels = placed(rig).map((marker) => marker.element.getAttribute("aria-label"));
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe("rendering a draft", () => {
  it("draws a line and a vertex per point", () => {
    const { controller, harness: rig } = mount({ sources: [OSM] });
    rig.map.fireLoad();

    controller.renderDraft([
      { lat: 59.33, lng: 18.06 },
      { lat: 59.34, lng: 18.07 },
      { lat: 59.35, lng: 18.08 },
    ]);

    const features = rig.map.data(ENGINE_SOURCE.draft)?.features ?? [];
    expect(features.filter((f) => f.geometry.type === "LineString")).toHaveLength(1);
    expect(features.filter((f) => f.geometry.type === "Point")).toHaveLength(3);
  });

  it("draws a single point as a vertex and no line", () => {
    // Same rule as a singleton segment: a LineString needs two positions, and an invalid one
    // is either rejected or drawn as nothing.
    const { controller, harness: rig } = mount({ sources: [OSM] });
    rig.map.fireLoad();

    controller.renderDraft([{ lat: 59.33, lng: 18.06 }]);

    const features = rig.map.data(ENGINE_SOURCE.draft)?.features ?? [];
    expect(features.filter((f) => f.geometry.type === "LineString")).toEqual([]);
    expect(features).toHaveLength(1);
  });

  it("clears with an empty collection", () => {
    const { controller, harness: rig } = mount({ sources: [OSM] });
    rig.map.fireLoad();
    controller.renderDraft([{ lat: 59.33, lng: 18.06 }]);

    controller.renderDraft(null);

    expect(rig.map.data(ENGINE_SOURCE.draft)?.features).toEqual([]);
    expect(rig.map.layerIds).toContain(ENGINE_LAYER.draftLine);
  });
});

describe("live position", () => {
  const FIX = { lat: 59.33, lng: 18.06, t: 1_700_000_000_000 };

  it("moves one marker rather than creating a new one per fix", () => {
    // A fix arrives every second or two. Creating a marker each time would leak DOM nodes
    // and listeners for the length of the trip.
    const { controller, harness: rig } = mount({ sources: [OSM] });
    rig.map.fireLoad();

    controller.showLivePosition(FIX);
    controller.showLivePosition({ ...FIX, lat: 59.34 });
    controller.showLivePosition({ ...FIX, lat: 59.35 });

    expect(rig.markers).toHaveLength(1);
    expect(rig.markers[0]?.lngLat).toEqual([18.06, 59.35]);
  });

  it("removes it when there is no position", () => {
    const { controller, harness: rig } = mount({ sources: [OSM] });
    rig.map.fireLoad();
    controller.showLivePosition(FIX);

    controller.showLivePosition(null);

    expect(placed(rig)).toEqual([]);
  });

  it("says nothing before load, then places once", () => {
    const { controller, harness: rig } = mount({ sources: [OSM] });

    controller.showLivePosition(FIX);
    expect(rig.markers).toEqual([]);

    rig.map.fireLoad();

    expect(placed(rig)).toHaveLength(1);
  });
});

describe("the camera", () => {
  it("frames a track's extent", () => {
    const { controller, harness: rig } = mount({ sources: [OSM] });

    controller.fitTrack(twoSegmentFixture());

    const call = rig.map.calls.find((entry) => entry.op === "fitBounds");
    expect(call?.bounds).toEqual([18.06, 59.33, 18.09, 59.36]);
  });

  it("does not move for a track with no points", () => {
    // Moving to an invented extent is worse than leaving the camera where the user put it.
    const { controller, harness: rig } = mount({ sources: [OSM] });

    controller.fitTrack({ ...trackFixture(), points: [], segments: [] });

    expect(rig.map.calls.some((call) => call.op === "fitBounds")).toBe(false);
  });

  it("frames an explicit bbox and recenters, without waiting for load", () => {
    // A map has a transform from the moment it exists, and a consumer who recenters before
    // the style resolves means now, not eventually.
    const { controller, harness: rig } = mount({ sources: [OSM] });

    controller.fitBounds([1, 2, 3, 4]);
    controller.recenter({ lat: 59.33, lng: 18.06 }, 12);

    const framed = rig.map.calls.find((call) => call.op === "fitBounds");
    expect(framed?.bounds).toEqual([1, 2, 3, 4]);
    // A default rather than zero, so endpoints are not flush against the viewport edge.
    expect(framed?.paddingPx).toBeGreaterThan(0);
    expect(rig.map.calls.find((call) => call.op === "jumpTo")?.center).toEqual([18.06, 59.33]);
  });
});

describe("destroy takes the markers with it", () => {
  it("removes every placed marker, since they live outside MapLibre's container", () => {
    const { controller, harness: rig } = mount({ sources: [OSM] });
    rig.map.fireLoad();
    controller.renderTrack(trackFixture());
    controller.showLivePosition({ lat: 59.33, lng: 18.06, t: 1 });

    controller.destroy();

    expect(rig.markers.every((marker) => marker.removed)).toBe(true);
  });

  it("rejects every render call afterwards", () => {
    const { controller } = mount({ sources: [OSM] });
    controller.destroy();

    expect(() => {
      controller.renderTrack(null);
    }).toThrow(MapControllerDestroyedError);
    expect(() => {
      controller.renderEvents([]);
    }).toThrow(MapControllerDestroyedError);
    expect(() => {
      controller.renderDraft(null);
    }).toThrow(MapControllerDestroyedError);
    expect(() => {
      controller.showLivePosition(null);
    }).toThrow(MapControllerDestroyedError);
    expect(() => {
      controller.recenter({ lat: 0, lng: 0 });
    }).toThrow(MapControllerDestroyedError);
  });
});

describe("built-in marks are actually visible", () => {
  it("carries size and content, not just a colour", () => {
    // A wrapper with no size and no content lays out at zero by zero: positioned correctly,
    // in the accessibility tree, and invisible. Nothing reports it, because nothing is wrong
    // — there is simply nothing to draw.
    const { controller, harness: rig } = mount({ sources: [OSM] });
    rig.map.fireLoad();

    controller.renderTrack(trackFixture());

    for (const marker of placed(rig)) {
      expect(marker.element.style.width).not.toBe("");
      expect(marker.element.style.height).not.toBe("");
      expect(marker.element.querySelector("svg")).not.toBeNull();
    }
  });

  it("anchors a pin at its tip and a live dot at its centre", () => {
    // The anchor reaches the renderer's constructor, or every mark is centred on its
    // coordinate and a pin sits half above the place it points at.
    const { controller, harness: rig } = mount({ sources: [OSM] });
    rig.map.fireLoad();

    controller.renderTrack(trackFixture());
    expect(placed(rig).map((marker) => marker.anchor)).toEqual(["bottom", "bottom"]);

    controller.renderTrack(null);
    controller.showLivePosition({ lat: 59.33, lng: 18.06, t: 1 });
    expect(placed(rig).map((marker) => marker.anchor)).toEqual(["center"]);
  });
});

describe("a reused mark is brought up to date, not merely moved", () => {
  it("refreshes the accessible name when a lap is renamed", () => {
    // Keeping the element is what preserves focus; keeping what it *says* would make the
    // mark look maintained while announcing something untrue.
    const { controller, harness: rig } = mount({ sources: [OSM] });
    rig.map.fireLoad();
    const withLap = (label: string): Track => ({
      ...trackFixture(),
      laps: [
        { id: "lap-1", index: 0, startIndex: 0, endIndex: 1, startedAt: 1, endedAt: 2, label },
      ],
    });

    controller.renderTrack(withLap("Original"));
    const lapMark = placed(rig).find((marker) =>
      marker.element.getAttribute("aria-label")?.includes("Original"),
    );
    expect(lapMark).toBeDefined();

    controller.renderTrack(withLap("Renamed"));

    expect(lapMark?.element.getAttribute("aria-label")).toBe("Lap: Renamed");
    // Still the same element, so focus survived the rename.
    expect(placed(rig)).toContain(lapMark);
  });

  it("keys laps by id, so inserting one does not hand its element to another", () => {
    // Array position is not identity: with index keys, adding a lap in front would move the
    // focused element to a different lap and — through the reuse path — keep its old label.
    const { controller, harness: rig } = mount({ sources: [OSM] });
    rig.map.fireLoad();
    const lap = (id: string, label: string) => ({
      id,
      index: 0,
      startIndex: 0,
      endIndex: 1,
      startedAt: 1,
      endedAt: 2,
      label,
    });

    controller.renderTrack({ ...trackFixture(), laps: [lap("lap-2", "Second")] });
    const second = placed(rig).find((marker) =>
      marker.element.getAttribute("aria-label")?.includes("Second"),
    );

    controller.renderTrack({
      ...trackFixture(),
      laps: [lap("lap-1", "First"), lap("lap-2", "Second")],
    });

    // The element that was showing "Second" still is.
    expect(second?.element.getAttribute("aria-label")).toBe("Lap: Second");
    expect(placed(rig).map((marker) => marker.element.getAttribute("aria-label"))).toEqual(
      expect.arrayContaining(["Lap: First", "Lap: Second"]),
    );
  });
});

describe("desired render state is a snapshot of what was handed over", () => {
  it("does not reread a track a later call would have re-derived marks from", () => {
    // renderTrack takes the line and the marks in one pass. Keeping the track and rebuilding
    // marks on the next renderEvents would read the caller's object again, and a mutation in
    // between would leave marks disagreeing with the line beside them.
    const { controller, harness: rig } = mount({ sources: [OSM] });
    rig.map.fireLoad();
    const track = trackFixture();

    controller.renderTrack(track);
    const before = placed(rig).map((marker) => marker.lngLat);
    track.points[0] = { lat: 0, lng: 0, t: 1 };
    controller.renderEvents([]);

    expect(placed(rig).map((marker) => marker.lngLat)).toEqual(before);
  });

  it("does not reread events a later renderTrack would have re-derived marks from", () => {
    const { controller, harness: rig } = mount({ sources: [OSM] });
    rig.map.fireLoad();
    const events = [eventFixture("e1", 18.06)];

    controller.renderEvents(events);
    const before = placed(rig).map((marker) => marker.lngLat);
    events[0] = eventFixture("e1", 99);
    controller.renderTrack(null);

    expect(placed(rig).map((marker) => marker.lngLat)).toEqual(before);
  });

  it("copies a live fix rather than holding the caller's point", () => {
    // A recorder that reuses one point object per update would otherwise move a mark that
    // was never asked to move.
    const { controller, harness: rig } = mount({ sources: [OSM] });
    const fix = { lat: 59.33, lng: 18.06, t: 1 };

    controller.showLivePosition(fix);
    fix.lat = 0;
    fix.lng = 0;
    rig.map.fireLoad();

    expect(placed(rig)[0]?.lngLat).toEqual([18.06, 59.33]);
  });
});

describe("the engine does not assume it owns a map because one id is present", () => {
  it("rejects a base style document that declares a reserved id", () => {
    // Reading "the anchor exists" as "the engine owns this map" would skip every source and
    // layer, leaving a map with no track and nothing to say why.
    const rig = harness();
    expect(() =>
      createMapControllerInternal(
        {
          container: CONTAINER,
          sources: [OSM],
          style: { version: 8, sources: {}, layers: [{ id: `${ENGINE_ID_PREFIX}track-line` }] },
        },
        rig.environment,
      ),
    ).toThrow(/reserved for the engine/);

    expect(() =>
      createMapControllerInternal(
        {
          container: CONTAINER,
          sources: [OSM],
          style: { version: 8, sources: { [`${ENGINE_ID_PREFIX}track`]: {} }, layers: [] },
        },
        rig.environment,
      ),
    ).toThrow(/reserved for the engine/);
  });

  it("refuses to adopt a reserved layer a style URL brought", () => {
    // The case a style *document* check cannot reach: the renderer fetches a URL, so nothing
    // can inspect it beforehand. Skipping installation because the id is present would adopt
    // it — the reserved id would count as installed while the layer behind it draws
    // something else, and track geometry would go to a source nothing renders. A blank map,
    // reported by nobody. Ownership is tracked, not inferred from presence.
    const anchorFromStyle = {
      id: ENGINE_LAYER.trackLine,
      type: "background",
    } as unknown as LayerSpecification;
    const { harness: rig } = mount(
      { sources: [OSM], style: "https://styles.invalid/brings-a-reserved-id.json" },
      { layers: [anchorFromStyle] },
    );

    expect(() => {
      rig.map.fireLoad();
    }).toThrow(MapNamespaceCollisionError);
  });

  it("installs every engine layer, not just the ones after a missing anchor", () => {
    const { harness: rig } = mount({ sources: [OSM] });
    rig.map.fireLoad();
    expect(engineLayerIds(rig.map)).toEqual([
      ENGINE_LAYER.trackLine,
      ENGINE_LAYER.trackLineDashed,
      ENGINE_LAYER.draftLine,
      ENGINE_LAYER.draftVertex,
    ]);
    expect(rig.map.sourceIds).toContain(ENGINE_SOURCE.track);
    expect(rig.map.sourceIds).toContain(ENGINE_SOURCE.draft);
  });
});

describe("the presentation seam", () => {
  const EVENT_STYLE: MarkerStyle = {
    ariaLabel: "A marked spot",
    color: "#ff0000",
    html: "<b>F</b>",
  };

  function presentationOf(overrides: Partial<EventPresentation> = {}): EventPresentation {
    return { marker: () => EVENT_STYLE, ...overrides };
  }

  it("draws consumer marks for events, with their own accessible names", () => {
    const { controller, harness: rig } = mount({ sources: [OSM] });
    rig.map.fireLoad();
    controller.setPresentation(
      presentationOf({
        marker: (event) => ({ ariaLabel: `Event ${event.id}`, color: "#00ff00" }),
      }),
    );

    controller.renderEvents([eventFixture("e1", 18.06), eventFixture("e2", 18.07)]);

    expect(placed(rig).map((m) => m.element.getAttribute("aria-label"))).toEqual([
      "Event e1",
      "Event e2",
    ]);
  });

  it("applies to what is already drawn, without waiting for the next render call", () => {
    // A presentation change is a change to the map, not a change to the next update. Waiting
    // would leave the consumer's own marks absent until something unrelated happened.
    const { controller, harness: rig } = mount({ sources: [OSM] });
    rig.map.fireLoad();
    controller.renderEvents([eventFixture("e1", 18.06)]);
    expect(placed(rig)[0]?.element.getAttribute("aria-label")).toBe("Event");

    controller.setPresentation(presentationOf());

    expect(placed(rig)[0]?.element.getAttribute("aria-label")).toBe("A marked spot");
  });

  it("returns to neutral defaults on setPresentation(null), immediately", () => {
    const { controller, harness: rig } = mount({ sources: [OSM] });
    rig.map.fireLoad();
    controller.renderTrack(trackFixture());
    controller.renderEvents([eventFixture("e1", 18.06)]);
    controller.setPresentation(presentationOf());
    expect(placed(rig).some((m) => m.element.getAttribute("aria-label") === "A marked spot")).toBe(
      true,
    );

    controller.setPresentation(null);

    expect(
      placed(rig)
        .map((m) => m.element.getAttribute("aria-label"))
        .sort(),
    ).toEqual(["Event", "Track finish", "Track start"]);
  });

  it("lets a consumer suppress a mark entirely", () => {
    // `null` is a decision, not an absence: no start mark, rather than the engine's.
    const { controller, harness: rig } = mount({ sources: [OSM] });
    rig.map.fireLoad();
    controller.setPresentation(presentationOf({ startMarker: () => null }));

    controller.renderTrack(trackFixture());

    expect(placed(rig).map((m) => m.element.getAttribute("aria-label"))).toEqual(["Track finish"]);
  });

  it("styles each segment from the consumer's callback, folded into the features", () => {
    const { controller, harness: rig } = mount({ sources: [OSM] });
    rig.map.fireLoad();
    controller.setPresentation(
      presentationOf({
        trackLine: (_track, index) =>
          index === 0 ? { color: "#111111", widthPx: 8 } : { dashed: true },
      }),
    );

    controller.renderTrack(twoSegmentFixture());

    const features = rig.map.data(ENGINE_SOURCE.track)?.features ?? [];
    expect(features[0]?.properties).toMatchObject({ lineColor: "#111111", lineWidthPx: 8 });
    expect(features[1]?.properties).toMatchObject({ lineDashed: true });
    // Dashed is the one property MapLibre will not data-drive, so it gets its own layer and
    // the two are filtered apart rather than one segment being drawn twice.
    expect(rig.map.layerIds).toContain(ENGINE_LAYER.trackLineDashed);
  });
});

describe("a presentation is prepared, never retained and run later", () => {
  it("leaves everything unchanged when a callback throws at setPresentation", () => {
    const { controller, harness: rig } = mount({ sources: [OSM] });
    rig.map.fireLoad();
    controller.renderTrack(trackFixture());
    controller.renderEvents([eventFixture("e1", 18.06)]);
    const before = placed(rig).map((m) => m.element.getAttribute("aria-label"));

    expect(() => {
      controller.setPresentation({
        marker: () => {
          throw new Error("consumer blew up");
        },
      });
    }).toThrow(/consumer blew up/);

    expect(placed(rig).map((m) => m.element.getAttribute("aria-label"))).toEqual(before);
  });

  it("leaves the previous events visible when a callback throws at renderEvents", () => {
    const { controller, harness: rig } = mount({ sources: [OSM] });
    rig.map.fireLoad();
    controller.setPresentation({
      marker: (event) => {
        if (event.id === "bad") throw new Error("no style for that");
        return { ariaLabel: `Event ${event.id}` };
      },
    });
    controller.renderEvents([eventFixture("e1", 18.06)]);

    expect(() => {
      controller.renderEvents([eventFixture("bad", 18.07)]);
    }).toThrow(/no style for that/);

    expect(placed(rig).map((m) => m.element.getAttribute("aria-label"))).toEqual(["Event e1"]);
  });

  it("leaves the previous track visible when a line callback throws at renderTrack", () => {
    const { controller, harness: rig } = mount({ sources: [OSM] });
    rig.map.fireLoad();
    controller.renderTrack(trackFixture());
    const before = rig.map.data(ENGINE_SOURCE.track);

    expect(() => {
      controller.setPresentation({
        marker: () => EVENT_MARK,
        trackLine: () => {
          throw new Error("no line for that");
        },
      });
    }).toThrow(/no line for that/);

    expect(rig.map.data(ENGINE_SOURCE.track)).toEqual(before);
  });

  it("touches no marker at all when preparation fails part way", () => {
    // The case that separates "transactional stored state" from "transactional DOM". A
    // presentation that changes an anchor forces a rebuild; if reconciliation had started
    // before the later callback threw, the focused mark would already be gone — and no
    // amount of rolling back stored state brings focus back.
    const { controller, harness: rig } = mount({ sources: [OSM] });
    rig.map.fireLoad();
    controller.setPresentation({ marker: () => ({ ariaLabel: "First", anchor: "bottom" }) });
    controller.renderEvents([eventFixture("keep", 18.06), eventFixture("later", 18.07)]);
    const original = placed(rig);
    expect(original).toHaveLength(2);
    const createdBefore = rig.markers.length;

    expect(() => {
      controller.setPresentation({
        marker: (event) => {
          // A different anchor for the first mark, which would force a rebuild...
          if (event.id === "keep") return { ariaLabel: "Rebuilt", anchor: "center" };
          // ...and then a failure while preparing the second.
          throw new Error("blew up after the anchor changed");
        },
      });
    }).toThrow(/blew up after the anchor changed/);

    expect(placed(rig)).toEqual(original);
    expect(rig.markers).toHaveLength(createdBefore);
    expect(rig.markers.some((m) => m.removed)).toBe(false);
    expect(original[0]?.element.getAttribute("aria-label")).toBe("First");
  });
});

describe("reuse turns on identity and anchor together", () => {
  it("reuses the element when only the style changed", () => {
    const { controller, harness: rig } = mount({ sources: [OSM] });
    rig.map.fireLoad();
    controller.setPresentation({ marker: () => ({ ariaLabel: "Before", color: "#111111" }) });
    controller.renderEvents([eventFixture("e1", 18.06)]);
    const first = placed(rig)[0];

    controller.setPresentation({ marker: () => ({ ariaLabel: "After", color: "#222222" }) });

    expect(placed(rig)[0]).toBe(first);
    expect(first?.element.getAttribute("aria-label")).toBe("After");
    expect(rig.markers).toHaveLength(1);
  });

  it("rebuilds when the anchor changed, because the renderer fixes it at construction", () => {
    const { controller, harness: rig } = mount({ sources: [OSM] });
    rig.map.fireLoad();
    controller.setPresentation({ marker: () => ({ ariaLabel: "Pin", anchor: "bottom" }) });
    controller.renderEvents([eventFixture("e1", 18.06)]);
    const first = placed(rig)[0];

    controller.setPresentation({ marker: () => ({ ariaLabel: "Dot", anchor: "center" }) });

    expect(placed(rig)).toHaveLength(1);
    expect(placed(rig)[0]).not.toBe(first);
    expect(first?.removed).toBe(true);
    expect(placed(rig)[0]?.anchor).toBe("center");
  });
});

describe("presentation results are snapshots, not views", () => {
  it("ignores a style object the consumer mutates after returning it", () => {
    // A presentation that reuses one style object across events — or holds the `sizePx` it
    // returned — would otherwise be able to change the map after the call that decided it.
    //
    // The mutation has to be *re-applied* to be visible, since the first render already wrote
    // the then-current values into the DOM. Any later reconcile does that: prepared marks are
    // reapplied every time, which is what refreshes a renamed lap. So an aliased style would
    // surface at the next unrelated update, which is the worst possible moment to discover it.
    const shared: MarkerStyle = { ariaLabel: "Shared", sizePx: [10, 10] };
    const { controller, harness: rig } = mount({ sources: [OSM] });
    rig.map.fireLoad();
    controller.setPresentation({ marker: () => shared });
    controller.renderEvents([eventFixture("e1", 18.06)]);

    shared.sizePx![0] = 99;
    shared.ariaLabel = "Changed";
    // An unrelated update, which reapplies every prepared mark.
    controller.showLivePosition({ lat: 59.33, lng: 18.06, t: 1 });

    const mark = placed(rig).find((m) => m.element.getAttribute("aria-label") !== null);
    expect(mark?.element.style.width).toBe("10px");
    expect(mark?.element.getAttribute("aria-label")).toBe("Shared");
  });

  it("ignores a track the consumer mutates after renderTrack", () => {
    // setPresentation re-derives from the snapshot, not from the caller's object.
    const { controller, harness: rig } = mount({ sources: [OSM] });
    rig.map.fireLoad();
    const track = trackFixture();
    controller.renderTrack(track);

    track.points[0] = { lat: 0, lng: 0, t: 1 };
    controller.setPresentation({ marker: () => EVENT_MARK });

    expect(placed(rig).map((m) => m.lngLat)).toEqual([
      [18.06, 59.33],
      [18.07, 59.34],
    ]);
  });
});

describe("a presentation callback cannot reach behind the engine's back", () => {
  it("refuses a callback's attempt to mutate the track it was given", () => {
    // Two failures at once if it could. The line is built before the callbacks run and the
    // marks after, so a mutation lands in one and not the other — a start mark somewhere the
    // line does not go. And the mutation would persist into every later setPresentation,
    // which re-derives from this same snapshot.
    const { controller, harness: rig } = mount({ sources: [OSM] });
    rig.map.fireLoad();

    expect(() => {
      controller.setPresentation({
        marker: () => EVENT_MARK,
        trackLine: (track) => {
          (track.points as TrackPoint[])[0] = { lat: 10, lng: 999, t: 1 };
          return {};
        },
      });
      controller.renderTrack(trackFixture());
    }).toThrow(TypeError);
  });

  it("keeps geometry and marks agreeing after a callback has run", () => {
    const { controller, harness: rig } = mount({ sources: [OSM] });
    rig.map.fireLoad();
    controller.setPresentation({ marker: () => EVENT_MARK, trackLine: () => ({}) });

    controller.renderTrack(trackFixture());

    const line = rig.map.data(ENGINE_SOURCE.track)?.features[0];
    const first = (line?.geometry as { coordinates: [number, number][] }).coordinates[0];
    expect(placed(rig)[0]?.lngLat).toEqual(first);
  });
});

describe("marker content", () => {
  it("renders a consumer's icon when no markup was supplied", () => {
    const { controller, harness: rig } = mount({ sources: [OSM] });
    rig.map.fireLoad();
    controller.setPresentation({
      marker: () => ({ ariaLabel: "A marked spot", iconUrl: "https://cdn.invalid/sign.png" }),
    });

    controller.renderEvents([eventFixture("e1", 18.06)]);

    const image = placed(rig)[0]?.element.querySelector("img");
    expect(image?.getAttribute("src")).toBe("https://cdn.invalid/sign.png");
    // Empty, not absent: the wrapper already carries the name, and an img with no alt has
    // assistive technology read out the file name instead.
    expect(image?.getAttribute("alt")).toBe("");
  });

  it("sizes the icon to the mark, so an intrinsically larger asset cannot overflow it", () => {
    // An icon is a consumer's own asset and can be any size; nothing constrains it to the
    // mark unless the engine says so, and an unconstrained one overflows a wrapper that
    // measures correctly and reports no error. Whether the constraint *works* is a layout
    // question the browser lane settles; this pins that it is applied at all.
    const { controller, harness: rig } = mount({ sources: [OSM] });
    rig.map.fireLoad();
    controller.setPresentation({
      marker: () => ({
        ariaLabel: "A marked spot",
        iconUrl: "https://cdn.invalid/big.png",
        sizePx: [24, 24],
      }),
    });

    controller.renderEvents([eventFixture("e1", 18.06)]);

    const image = placed(rig)[0]?.element.querySelector("img");
    expect(image?.style.width).toBe("100%");
    expect(image?.style.height).toBe("100%");
    // Letterboxed rather than cropped or stretched: the engine has no idea what it depicts.
    expect(image?.style.objectFit).toBe("contain");
  });

  it("constrains an icon whatever sized the mark, including a class", () => {
    // Unconditional, because `className` is a documented styling path: gating the constraint
    // on `sizePx` would leave a class-sized wrapper unconstrained, and would contradict the
    // reason percentages were chosen — that they follow whatever sized the wrapper.
    //
    // Whether an unsized wrapper then leaves the asset at its intrinsic size is a layout
    // question the browser lane settles; this pins that the rule is applied either way.
    const { controller, harness: rig } = mount({ sources: [OSM] });
    rig.map.fireLoad();
    controller.setPresentation({
      marker: () => ({ ariaLabel: "A marked spot", iconUrl: "https://cdn.invalid/big.png" }),
    });

    controller.renderEvents([eventFixture("e1", 18.06)]);

    const image = placed(rig)[0]?.element.querySelector("img");
    expect(image?.style.width).toBe("100%");
    expect(image?.style.height).toBe("100%");
  });

  it("prefers supplied markup over an icon, since html is the explicit escape hatch", () => {
    const { controller, harness: rig } = mount({ sources: [OSM] });
    rig.map.fireLoad();
    controller.setPresentation({
      marker: () => ({
        ariaLabel: "A marked spot",
        html: "<b>F</b>",
        iconUrl: "https://x.invalid/i",
      }),
    });

    controller.renderEvents([eventFixture("e1", 18.06)]);

    const content = placed(rig)[0]?.element.querySelector("[aria-hidden='true']");
    expect(content?.innerHTML).toBe("<b>F</b>");
    expect(content?.querySelector("img")).toBeNull();
  });

  it("escapes an icon url, since the engine composes that markup itself", () => {
    // `html` is consumer-trusted by contract and inserted verbatim; `iconUrl` is a value the
    // engine puts into an attribute, so it must not be able to close it and add another.
    const { controller, harness: rig } = mount({ sources: [OSM] });
    rig.map.fireLoad();
    controller.setPresentation({
      marker: () => ({ ariaLabel: "A marked spot", iconUrl: '" onerror="boom()' }),
    });

    controller.renderEvents([eventFixture("e1", 18.06)]);

    const image = placed(rig)[0]?.element.querySelector("img");
    expect(image?.getAttribute("onerror")).toBeNull();
    expect(image?.getAttribute("src")).toBe('" onerror="boom()');
  });
});

describe("renderer-owned class names are reserved", () => {
  it("rejects a consumer class the renderer owns", () => {
    // DOM class tokens carry no ownership count, so a consumer that supplied
    // `maplibregl-marker` and later dropped it would have the refresh remove MapLibre's own
    // — taking the mark's absolute positioning with it.
    const { controller, harness: rig } = mount({ sources: [OSM] });
    rig.map.fireLoad();

    expect(() => {
      controller.setPresentation({
        marker: () => ({ ariaLabel: "A marked spot", className: "mine maplibregl-marker" }),
      });
      controller.renderEvents([eventFixture("e1", 18.06)]);
    }).toThrow(/reserved for the renderer/);
  });

  it("allows any class that is not the renderer's", () => {
    const { controller, harness: rig } = mount({ sources: [OSM] });
    rig.map.fireLoad();
    controller.setPresentation({
      marker: () => ({ ariaLabel: "A marked spot", className: "catch-mark important" }),
    });

    controller.renderEvents([eventFixture("e1", 18.06)]);

    expect(placed(rig)[0]?.element.className).toContain("catch-mark");
  });
});
