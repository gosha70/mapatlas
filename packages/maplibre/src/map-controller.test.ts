// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
//
// `maplibre-gl` needs WebGL and Web Workers, neither of which jsdom
// provides, so this file mocks the whole module and drives the controller
// against a minimal fake `Map`/`Marker`/`LngLatBounds`/`AttributionControl`.
// The fake models the one behaviour that matters for the controller's logic:
// MapLibre defers `addSource`/`addLayer` until the style has loaded
// (`isStyleLoaded()` / a `"load"` event), so tests exercise both the
// before-load queue and the after-load steady state.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MapEvent, TileSource, Track } from "@mapatlas/core";

interface FakeSource {
  spec: Record<string, unknown>;
  setData: ReturnType<typeof vi.fn>;
}

interface FakeMarkerInstance {
  element: HTMLElement;
  lngLat: [number, number] | undefined;
  removed: boolean;
  setLngLat(ll: [number, number]): FakeMarkerInstance;
  addTo(map: FakeMapInstance): FakeMarkerInstance;
  remove(): FakeMarkerInstance;
}

interface FakeMapInstance {
  options: Record<string, unknown>;
  sources: Map<string, FakeSource>;
  layers: Map<string, Record<string, unknown>>;
  controls: unknown[];
  removed: boolean;
  fitBounds: ReturnType<typeof vi.fn>;
  easeTo: ReturnType<typeof vi.fn>;
  jumpTo: ReturnType<typeof vi.fn>;
  isStyleLoaded(): boolean;
  getZoom(): number;
  addSource(id: string, spec: Record<string, unknown>): FakeMapInstance;
  getSource(id: string): FakeSource | undefined;
  removeSource(id: string): FakeMapInstance;
  addLayer(layer: Record<string, unknown> & { id: string }): FakeMapInstance;
  removeLayer(id: string): FakeMapInstance;
  getLayer(id: string): Record<string, unknown> | undefined;
  addControl(control: unknown): FakeMapInstance;
  remove(): void;
  __load(): void;
  __click(at: { lat: number; lng: number }): void;
}

const { fakeMaps, fakeMarkers } = vi.hoisted(() => ({
  fakeMaps: [] as FakeMapInstance[],
  fakeMarkers: [] as FakeMarkerInstance[],
}));

vi.mock("maplibre-gl", () => {
  class FakeMarker implements FakeMarkerInstance {
    element: HTMLElement;
    lngLat: [number, number] | undefined;
    removed = false;
    map: FakeMapInstance | undefined;

    constructor(options: { element?: HTMLElement } = {}) {
      this.element = options.element ?? document.createElement("div");
      fakeMarkers.push(this);
    }
    setLngLat(ll: [number, number]): FakeMarkerInstance {
      this.lngLat = ll;
      return this;
    }
    addTo(map: FakeMapInstance): FakeMarkerInstance {
      this.map = map;
      return this;
    }
    remove(): FakeMarkerInstance {
      this.removed = true;
      this.map = undefined;
      return this;
    }
  }

  class FakeLngLatBounds {
    sw: [number, number];
    ne: [number, number];
    constructor(sw: [number, number], ne: [number, number]) {
      this.sw = sw;
      this.ne = ne;
    }
    extend(ll: [number, number]): FakeLngLatBounds {
      this.sw = [Math.min(this.sw[0], ll[0]), Math.min(this.sw[1], ll[1])];
      this.ne = [Math.max(this.ne[0], ll[0]), Math.max(this.ne[1], ll[1])];
      return this;
    }
  }

  class FakeAttributionControl {
    options: unknown;
    constructor(options?: unknown) {
      this.options = options;
    }
  }

  class FakeMap implements FakeMapInstance {
    options: Record<string, unknown>;
    sources = new Map<string, FakeSource>();
    layers = new Map<string, Record<string, unknown>>();
    controls: unknown[] = [];
    removed = false;
    fitBounds = vi.fn();
    easeTo = vi.fn();
    jumpTo = vi.fn();
    #loaded = false;
    #zoom: number;
    #loadListeners = new Set<() => void>();
    #clickListeners = new Set<
      (e: { lngLat: { lat: number; lng: number } }) => void
    >();

    constructor(options: Record<string, unknown>) {
      this.options = options;
      this.#zoom = (options["zoom"] as number | undefined) ?? 0;
      fakeMaps.push(this);
    }
    isStyleLoaded(): boolean {
      return this.#loaded;
    }
    getZoom(): number {
      return this.#zoom;
    }
    on(
      type: "click" | "load",
      cb:
        (() => void) | ((e: { lngLat: { lat: number; lng: number } }) => void),
    ): FakeMapInstance {
      if (type === "load") this.#loadListeners.add(cb as () => void);
      else
        this.#clickListeners.add(
          cb as (e: { lngLat: { lat: number; lng: number } }) => void,
        );
      return this;
    }
    once(type: "load", cb: () => void): FakeMapInstance {
      const wrapped = (): void => {
        this.#loadListeners.delete(wrapped);
        cb();
      };
      this.#loadListeners.add(wrapped);
      return this;
    }
    addSource(id: string, spec: Record<string, unknown>): FakeMapInstance {
      this.sources.set(id, { spec, setData: vi.fn() });
      return this;
    }
    getSource(id: string): FakeSource | undefined {
      return this.sources.get(id);
    }
    removeSource(id: string): FakeMapInstance {
      this.sources.delete(id);
      return this;
    }
    addLayer(layer: Record<string, unknown> & { id: string }): FakeMapInstance {
      this.layers.set(layer.id, layer);
      return this;
    }
    removeLayer(id: string): FakeMapInstance {
      this.layers.delete(id);
      return this;
    }
    getLayer(id: string): Record<string, unknown> | undefined {
      return this.layers.get(id);
    }
    addControl(control: unknown): FakeMapInstance {
      this.controls.push(control);
      return this;
    }
    remove(): void {
      this.removed = true;
    }
    // Test-only helpers simulating MapLibre's async style load and clicks.
    __load(): void {
      this.#loaded = true;
      for (const cb of [...this.#loadListeners]) cb();
    }
    __click(at: { lat: number; lng: number }): void {
      for (const cb of [...this.#clickListeners]) cb({ lngLat: at });
    }
  }

  return {
    Map: FakeMap,
    Marker: FakeMarker,
    LngLatBounds: FakeLngLatBounds,
    AttributionControl: FakeAttributionControl,
    addProtocol: vi.fn(),
    removeProtocol: vi.fn(),
  };
});

import { createMapController } from "./map-controller";

const BASE: TileSource = {
  id: "osm",
  kind: "xyz",
  url: "https://tiles.example/{z}/{x}/{y}.png",
  attribution: "© OpenStreetMap contributors",
};
const OVERLAY: TileSource = {
  id: "seamark",
  kind: "wms",
  url: "https://wms.example/seamarks",
  attribution: "© OpenSeaMap contributors (ODbL)",
  opacity: 0.8,
};

const TRACK: Track = {
  id: "t1",
  startedAt: 0,
  endedAt: 1000,
  status: "finalized",
  points: [
    { lat: 47.6, lng: -122.33, t: 0 },
    { lat: 47.61, lng: -122.34, t: 500 },
    { lat: 47.62, lng: -122.35, t: 1000 },
  ],
  simplified: [
    { lat: 47.6, lng: -122.33, t: 0 },
    { lat: 47.62, lng: -122.35, t: 1000 },
  ],
  distanceM: 3000,
};

const EVENTS: MapEvent[] = [
  {
    id: "e1",
    position: { lat: 47.605, lng: -122.335 },
    occurredAt: 250,
    comment: "first pin",
    media: [],
    tags: [],
  },
  {
    id: "e2",
    position: { lat: 47.615, lng: -122.345 },
    occurredAt: 750,
    media: [],
    tags: [],
  },
];

function makeContainer(): HTMLElement {
  const el = document.createElement("div");
  document.body.appendChild(el);
  return el;
}

function setReducedMotion(reduce: boolean): void {
  window.matchMedia = ((query: string) => ({
    matches: reduce,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

/** The last `Map` instance the controller under test constructed. */
function lastMap(): FakeMapInstance {
  const map = fakeMaps.at(-1);
  if (!map) throw new Error("no FakeMap constructed");
  return map;
}

describe("createMapController", () => {
  let container: HTMLElement;

  beforeEach(() => {
    setReducedMotion(false);
    container = makeContainer();
    fakeMaps.length = 0;
    fakeMarkers.length = 0;
  });
  afterEach(() => {
    container.remove();
    vi.restoreAllMocks();
  });

  describe("T4.1 mount + layered sources + attribution", () => {
    it("mounts a MapLibre map into the container", () => {
      createMapController({ container, sources: [BASE] });
      expect(lastMap().options["container"]).toBe(container);
    });

    it("owns attribution: no default control, only an explicit neutral one", () => {
      createMapController({ container, sources: [BASE] });
      const map = lastMap();
      expect(map.options["attributionControl"]).toBe(false);
      expect(map.controls).toHaveLength(1);
    });

    it("defers the tile-source stack until the style loads, then applies it", () => {
      createMapController({ container, sources: [BASE, OVERLAY] });
      const map = lastMap();
      expect(map.sources.size).toBe(0);
      expect(map.layers.size).toBe(0);

      map.__load();
      expect(map.sources.size).toBe(2);
      expect(map.layers.size).toBe(2);
    });

    it("renders each source's attribution verbatim", () => {
      createMapController({ container, sources: [BASE, OVERLAY] });
      const map = lastMap();
      map.__load();
      const attributions = [...map.sources.values()].map(
        (s) => s.spec["attribution"],
      );
      expect(attributions).toContain("© OpenStreetMap contributors");
      expect(attributions).toContain("© OpenSeaMap contributors (ODbL)");
    });

    it("swaps the whole stack on setSources", () => {
      const c = createMapController({ container, sources: [BASE] });
      const map = lastMap();
      map.__load();
      expect(map.sources.size).toBe(1);

      c.setSources([BASE, OVERLAY]);
      expect(map.sources.size).toBe(2);
      expect(map.layers.size).toBe(2);
    });
  });

  describe("T4.2 track, events, live position, fit, recenter", () => {
    it("queues the track line until load, then draws it from simplified geometry", () => {
      const c = createMapController({ container, sources: [BASE] });
      const map = lastMap();
      c.renderTrack(TRACK);
      expect(map.layers.size).toBe(0); // nothing applied yet — queued

      map.__load();
      const trackSource = [...map.sources.values()].find(
        (s) => s.spec["type"] === "geojson",
      );
      expect(trackSource).toBeDefined();
      const lastCall = trackSource!.setData.mock.calls.at(-1)![0] as {
        features: Array<{ geometry: { coordinates: [number, number][] } }>;
      };
      expect(lastCall.features[0]!.geometry.coordinates).toEqual([
        [-122.33, 47.6],
        [-122.35, 47.62],
      ]);
    });

    it("empties the track line on renderTrack(null)", () => {
      const c = createMapController({ container, sources: [BASE] });
      const map = lastMap();
      map.__load();
      c.renderTrack(TRACK);
      c.renderTrack(null);

      const trackSource = [...map.sources.values()].find(
        (s) => s.spec["type"] === "geojson",
      )!;
      const lastCall = trackSource.setData.mock.calls.at(-1)![0] as {
        features: unknown[];
      };
      expect(lastCall.features).toHaveLength(0);
    });

    it("renders one keyboard-reachable Marker per event", () => {
      const c = createMapController({ container, sources: [BASE] });
      c.renderEvents(EVENTS);
      expect(fakeMarkers).toHaveLength(2);
      expect(fakeMarkers[0]!.lngLat).toEqual([-122.335, 47.605]);
      expect(fakeMarkers[0]!.element.getAttribute("role")).toBe("button");
      expect(fakeMarkers[0]!.element.tabIndex).toBe(0);
      expect(fakeMarkers[0]!.element.getAttribute("aria-label")).toBe(
        "first pin",
      );
    });

    it("adds and removes the live position marker", () => {
      const c = createMapController({ container, sources: [BASE] });
      c.showLivePosition({ lat: 47.6, lng: -122.33, t: 0 });
      expect(fakeMarkers).toHaveLength(1);
      expect(fakeMarkers[0]!.lngLat).toEqual([-122.33, 47.6]);
      expect(fakeMarkers[0]!.element.style.pointerEvents).toBe("none");

      c.showLivePosition(null);
      expect(fakeMarkers[0]!.removed).toBe(true);
    });

    it("fits the map to the track bounds (animated by default)", () => {
      const c = createMapController({ container, sources: [BASE] });
      const map = lastMap();
      c.fitTrack(TRACK);
      expect(map.fitBounds).toHaveBeenCalledTimes(1);
      expect(map.fitBounds.mock.calls[0]?.[1]).toMatchObject({
        padding: 24,
        animate: true,
      });
    });

    it("recenters via easeTo by default", () => {
      const c = createMapController({ container, sources: [BASE] });
      const map = lastMap();
      c.recenter({ lat: 10, lng: 20 }, 12);
      expect(map.easeTo).toHaveBeenCalledWith({ center: [20, 10], zoom: 12 });
      expect(map.jumpTo).not.toHaveBeenCalled();
    });
  });

  describe("T4.3 interaction + a11y", () => {
    it("invokes onMapTap with the tapped coordinate", () => {
      const c = createMapController({ container, sources: [BASE] });
      const map = lastMap();
      const taps: Array<{ lat: number; lng: number }> = [];
      c.onMapTap((at) => taps.push(at));
      map.__click({ lat: 5, lng: 6 });
      expect(taps).toEqual([{ lat: 5, lng: 6 }]);
    });

    it("invokes onEventClick when an event marker is clicked", () => {
      const c = createMapController({ container, sources: [BASE] });
      const clicked: string[] = [];
      c.onEventClick((id) => clicked.push(id));
      c.renderEvents(EVENTS);
      fakeMarkers[0]!.element.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
      expect(clicked).toEqual(["e1"]);
    });

    it("invokes onEventClick on Enter/Space keyboard activation", () => {
      const c = createMapController({ container, sources: [BASE] });
      const clicked: string[] = [];
      c.onEventClick((id) => clicked.push(id));
      c.renderEvents(EVENTS);
      fakeMarkers[0]!.element.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
      expect(clicked).toEqual(["e1"]);
    });

    it("unsubscribes tap/click listeners", () => {
      const c = createMapController({ container, sources: [BASE] });
      const map = lastMap();
      const taps: unknown[] = [];
      const off = c.onMapTap((at) => taps.push(at));
      off();
      map.__click({ lat: 1, lng: 2 });
      expect(taps).toHaveLength(0);
    });

    it("injects a visible-focus stylesheet", () => {
      createMapController({ container, sources: [BASE] });
      const style = document.getElementById("mapatlas-focus-style");
      expect(style?.textContent).toContain("focus-visible");
    });

    it("disables view animation under prefers-reduced-motion", () => {
      const c = createMapController({ container, sources: [BASE] });
      const map = lastMap();
      setReducedMotion(true);
      c.fitTrack(TRACK);
      c.recenter({ lat: 1, lng: 2 });
      expect(map.fitBounds.mock.calls[0]?.[1]).toMatchObject({
        animate: false,
      });
      // No explicit zoom passed to createMapController, so the map used
      // DEFAULT_ZOOM (2); recenter() without a zoom falls back to getZoom().
      expect(map.jumpTo).toHaveBeenCalledWith({ center: [2, 1], zoom: 2 });
      expect(map.easeTo).not.toHaveBeenCalled();
    });
  });

  describe("destroy", () => {
    it("removes markers and the map", () => {
      const c = createMapController({ container, sources: [BASE] });
      const map = lastMap();
      c.renderEvents(EVENTS);
      c.showLivePosition({ lat: 1, lng: 2, t: 0 });
      c.destroy();
      expect(fakeMarkers.every((m) => m.removed)).toBe(true);
      expect(map.removed).toBe(true);
    });
  });
});
