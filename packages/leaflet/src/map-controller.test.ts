// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as L from "leaflet";
import type { MapEvent, TileSource, Track } from "@mapatlas/core";
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
  Object.defineProperty(el, "clientWidth", { value: 800, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: 600, configurable: true });
  el.getBoundingClientRect = () =>
    ({
      width: 800,
      height: 600,
      top: 0,
      left: 0,
      right: 800,
      bottom: 600,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
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

describe("createMapController", () => {
  let container: HTMLElement;

  beforeEach(() => {
    setReducedMotion(false);
    container = makeContainer();
  });
  afterEach(() => {
    container.remove();
    vi.restoreAllMocks();
  });

  describe("T4.1 mount + layered sources + attribution", () => {
    it("mounts a Leaflet map into the container", () => {
      const c = createMapController({ container, sources: [BASE] });
      expect(container.classList.contains("leaflet-container")).toBe(true);
      c.destroy();
    });

    it("composites an ordered base + overlay stack", () => {
      const c = createMapController({ container, sources: [BASE, OVERLAY] });
      const layers = container.querySelectorAll(
        ".leaflet-tile-pane .leaflet-layer",
      );
      expect(layers).toHaveLength(2);
      c.destroy();
    });

    it("renders each source's attribution verbatim", () => {
      const c = createMapController({ container, sources: [BASE, OVERLAY] });
      const attr = container.querySelector(".leaflet-control-attribution");
      expect(attr?.innerHTML).toContain("© OpenStreetMap contributors");
      expect(attr?.innerHTML).toContain("© OpenSeaMap contributors (ODbL)");
      c.destroy();
    });

    it("swaps the whole stack on setSources", () => {
      const c = createMapController({ container, sources: [BASE] });
      c.setSources([BASE, OVERLAY]);
      expect(
        container.querySelectorAll(".leaflet-tile-pane .leaflet-layer"),
      ).toHaveLength(2);
      c.destroy();
    });
  });

  describe("T4.2 track, events, live position, fit, recenter", () => {
    it("draws the track polyline from simplified geometry", () => {
      const c = createMapController({ container, sources: [BASE] });
      c.renderTrack(TRACK);
      expect(container.querySelector("path.mapatlas-track")).not.toBeNull();
      c.renderTrack(null);
      expect(container.querySelector("path.mapatlas-track")).toBeNull();
      c.destroy();
    });

    it("renders one keyboard-reachable DivIcon marker per event", () => {
      const c = createMapController({ container, sources: [BASE] });
      c.renderEvents(EVENTS);
      const markers = container.querySelectorAll(".mapatlas-event-marker");
      expect(markers).toHaveLength(2);
      expect((markers[0] as HTMLElement).getAttribute("tabindex")).toBe("0");
      c.destroy();
    });

    it("adds and removes the live position marker", () => {
      const c = createMapController({ container, sources: [BASE] });
      c.showLivePosition({ lat: 47.6, lng: -122.33, t: 0 });
      expect(container.querySelector(".mapatlas-live-position")).not.toBeNull();
      c.showLivePosition(null);
      expect(container.querySelector(".mapatlas-live-position")).toBeNull();
      c.destroy();
    });

    it("fits the map to the track bounds (animated by default)", () => {
      const c = createMapController({ container, sources: [BASE] });
      const spy = vi.spyOn(L.Map.prototype, "fitBounds");
      c.fitTrack(TRACK);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]?.[1]).toMatchObject({ animate: true });
      c.destroy();
    });

    it("recenters to a coordinate", () => {
      const c = createMapController({ container, sources: [BASE] });
      const spy = vi.spyOn(L.Map.prototype, "setView");
      c.recenter({ lat: 10, lng: 20 }, 12);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]?.[0]).toEqual([10, 20]);
      expect(spy.mock.calls[0]?.[1]).toBe(12);
      c.destroy();
    });
  });

  describe("T4.3 interaction + a11y", () => {
    it("invokes onMapTap with the tapped coordinate", () => {
      const c = createMapController({ container, sources: [BASE] });
      const taps: Array<{ lat: number; lng: number }> = [];
      c.onMapTap((at) => taps.push(at));
      container.dispatchEvent(
        new MouseEvent("click", { bubbles: true, clientX: 400, clientY: 300 }),
      );
      expect(taps).toHaveLength(1);
      c.destroy();
    });

    it("invokes onEventClick with the event id", () => {
      const c = createMapController({ container, sources: [BASE] });
      const clicked: string[] = [];
      c.onEventClick((id) => clicked.push(id));
      c.renderEvents(EVENTS);
      const marker = container.querySelector(
        ".mapatlas-event-marker",
      ) as HTMLElement;
      marker.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(clicked).toEqual(["e1"]);
      c.destroy();
    });

    it("unsubscribes tap/click listeners", () => {
      const c = createMapController({ container, sources: [BASE] });
      const taps: unknown[] = [];
      const off = c.onMapTap((at) => taps.push(at));
      off();
      container.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(taps).toHaveLength(0);
      c.destroy();
    });

    it("injects a visible-focus stylesheet", () => {
      const c = createMapController({ container, sources: [BASE] });
      const style = document.getElementById("mapatlas-focus-style");
      expect(style?.textContent).toContain("focus-visible");
      c.destroy();
    });

    it("disables view animation under prefers-reduced-motion", () => {
      const c = createMapController({ container, sources: [BASE] });
      setReducedMotion(true);
      const fit = vi.spyOn(L.Map.prototype, "fitBounds");
      const view = vi.spyOn(L.Map.prototype, "setView");
      c.fitTrack(TRACK);
      c.recenter({ lat: 1, lng: 2 });
      expect(fit.mock.calls[0]?.[1]).toMatchObject({ animate: false });
      expect(view.mock.calls[0]?.[2]).toMatchObject({ animate: false });
      c.destroy();
    });
  });
});
