// SPDX-License-Identifier: Apache-2.0
import type { JSONValue, TileSource } from "@mapatlas/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MapConstructorOptions, MapEnvironment } from "./environment.js";
import type { FakeMap } from "./fake-map.js";
import { createFakeMap } from "./fake-map.js";
import type * as ControllerModule from "./controller.js";
import type { MapControllerOptions } from "./controller.js";
import {
  EMPTY_STYLE,
  MapControllerDestroyedError,
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

const ARCHIVE: TileSource = {
  id: "offline",
  kind: "raster",
  transport: "pmtiles",
  url: "https://cdn.invalid/region.pmtiles",
  attribution: "© OpenStreetMap contributors",
};

/** A container the controller only ever forwards; no DOM behaviour is exercised. */
const CONTAINER = {} as HTMLElement;

interface Harness {
  readonly map: FakeMap;
  readonly environment: MapEnvironment;
  readonly addProtocol: ReturnType<typeof vi.fn>;
  readonly createProtocol: ReturnType<typeof vi.fn>;
}

function harness(): Harness {
  let map: FakeMap | undefined;
  const addProtocol = vi.fn();
  const createProtocol = vi.fn(() => ({ tile: () => undefined }));
  const environment: MapEnvironment = {
    createMap(options: MapConstructorOptions): FakeMap {
      map = createFakeMap(options);
      return map;
    },
    protocolRegistrar: { addProtocol, createProtocol },
  };
  return {
    get map(): FakeMap {
      if (map === undefined) throw new Error("no map was constructed");
      return map;
    },
    environment,
    addProtocol,
    createProtocol,
  };
}

function mount(options: Partial<MapControllerOptions> = {}): {
  controller: ReturnType<typeof createMapControllerInternal>;
  harness: Harness;
} {
  const rig = harness();
  const controller = createMapControllerInternal(
    { container: CONTAINER, sources: [], ...options },
    rig.environment,
  );
  return { controller, harness: rig };
}

/** Layer ids in the order they were added, which is the order MapLibre draws them. */
function addedLayers(map: FakeMap): string[] {
  return map.calls.filter((call) => call.op === "addLayer").map((call) => call.id);
}

describe("installation waits for the style to load", () => {
  it("touches nothing before load", () => {
    // MapLibre rejects addSource and addLayer until the style is ready, so an eager
    // controller would throw on construction rather than render a basemap.
    const { harness: rig } = mount({ sources: [OSM] });

    expect(rig.map.calls).toEqual([]);
    expect(rig.map.sourceIds).toEqual([]);
  });

  it("installs the stack when load fires", () => {
    const { harness: rig } = mount({ sources: [OSM] });

    rig.map.fireLoad();

    expect(rig.map.sourceIds).toEqual(["osm"]);
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

    expect(rig.map.sourceIds).toEqual(["seamarks"]);
    expect(rig.map.calls.filter((call) => call.op === "addSource")).toHaveLength(1);
    // Not "added then removed": A was never installed at all.
    expect(rig.map.calls.some((call) => call.op === "removeSource")).toBe(false);
    expect(rig.map.calls.some((call) => call.op !== "remove" && call.id === "osm")).toBe(false);
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
    expect(rig.map.sourceIds).toEqual(["osm"]);
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

    expect(rig.map.layerSpecs[0]).toMatchObject({
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

    expect(rig.map.calls.filter((call) => call.op === "addSource")).toHaveLength(1);
  });

  it("does not install for a controller destroyed before its style loaded", () => {
    const { controller, harness: rig } = mount({ sources: [OSM] });

    controller.destroy();
    rig.map.fireLoad();

    expect(rig.map.sourceIds).toEqual([]);
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

    expect(rig.map.sourceIds).toEqual(["osm", "seamarks", "contours"]);
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

    const ops = rig.map.calls.map((call) => call.op);
    const lastRemovedLayer = ops.lastIndexOf("removeLayer");
    const firstRemovedSource = ops.indexOf("removeSource");
    expect(lastRemovedLayer).toBeLessThan(firstRemovedSource);
    expect(rig.map.sourceIds).toEqual(["replacement"]);
    expect(rig.map.layerIds).toEqual(["replacement__raster"]);
  });

  it("adds the new stack only after the old one is gone", () => {
    const { controller, harness: rig } = mount({ sources: [OSM] });
    rig.map.fireLoad();

    controller.setSources([SEAMARKS]);

    const ops = rig.map.calls.map((call) => call.op);
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
    expect(rig.map.sourceIds).toEqual(["osm"]);
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
    expect(rig.map.sourceIds).toEqual(["osm"]);
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
            order.push("addSource");
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
