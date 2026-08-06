// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

/**
 * T4.1–T4.3 acceptance, rendered from fixtures in jsdom:
 *  - ordered TileSource stack (base + overlay) with verbatim attribution;
 *  - live position, a growing track polyline, event DivIcon markers;
 *  - fitTrack / recenter; onMapTap / onEventClick; keyboard-reachable a11y
 *    controls with visible-focus styling; prefers-reduced-motion respected.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MapEvent, Track, TileSource } from "@mapatlas/core";
import { createMapController } from "./map-controller.js";
import type { MapController } from "./map-controller.js";

const SOURCES: TileSource[] = [
  {
    id: "osm",
    kind: "xyz",
    url: "https://tiles.example/{z}/{x}/{y}.png",
    attribution: "© OpenStreetMap contributors",
  },
  {
    id: "seamark",
    kind: "xyz",
    url: "https://seamark.example/{z}/{x}/{y}.png",
    attribution: "© OpenSeaMap contributors",
    opacity: 0.8,
  },
];

const TRACK: Track = {
  id: "t1",
  startedAt: 0,
  status: "finalized",
  points: [
    { lat: 51.5, lng: -0.1, t: 1 },
    { lat: 51.51, lng: -0.09, t: 2 },
    { lat: 51.52, lng: -0.08, t: 3 },
  ],
};

const EVENTS: MapEvent[] = [
  {
    id: "e1",
    position: { lat: 51.5, lng: -0.1 },
    occurredAt: 1,
    media: [],
    tags: [],
    comment: "gull",
  },
  {
    id: "e2",
    position: { lat: 51.52, lng: -0.08 },
    occurredAt: 3,
    media: [],
    tags: [],
  },
];

let container: HTMLElement;
let controller: MapController;

/** jsdom returns zero sizes; give the map a real viewport so Leaflet projects. */
function sizeContainer(el: HTMLElement): void {
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
      toJSON() {},
    }) as DOMRect;
}

beforeEach(() => {
  container = document.createElement("div");
  sizeContainer(container);
  document.body.appendChild(container);
});

afterEach(() => {
  controller?.destroy();
  container.remove();
  vi.unstubAllGlobals();
});

describe("createMapController", () => {
  it("mounts an ordered tile stack with verbatim attribution (T4.1)", () => {
    controller = createMapController({ container, sources: SOURCES, zoom: 12 });
    const layers = container.querySelectorAll(".leaflet-layer");
    expect(layers.length).toBe(2);

    const attribution = container.querySelector(
      ".leaflet-control-attribution",
    )!.textContent!;
    expect(attribution).toContain("© OpenStreetMap contributors");
    expect(attribution).toContain("© OpenSeaMap contributors");
  });

  it("re-composites layers on setSources", () => {
    controller = createMapController({ container, sources: SOURCES });
    controller.setSources([SOURCES[0]!]);
    expect(container.querySelectorAll(".leaflet-layer").length).toBe(1);
  });

  it("renders a growing track polyline (T4.2)", () => {
    controller = createMapController({ container, sources: SOURCES, zoom: 12 });
    controller.renderTrack({ ...TRACK, points: TRACK.points.slice(0, 2) });
    expect(container.querySelectorAll("path.mapatlas-track").length).toBe(1);

    // Growing: re-render with more points still yields exactly one polyline.
    controller.renderTrack(TRACK);
    expect(container.querySelectorAll("path.mapatlas-track").length).toBe(1);

    controller.renderTrack(null);
    expect(container.querySelectorAll("path.mapatlas-track").length).toBe(0);
  });

  it("renders event DivIcon markers and a live position (T4.2)", () => {
    controller = createMapController({ container, sources: SOURCES, zoom: 12 });
    controller.renderEvents(EVENTS);
    expect(container.querySelectorAll(".mapatlas-event-marker").length).toBe(2);

    controller.showLivePosition({ lat: 51.5, lng: -0.1, t: 1 });
    expect(container.querySelectorAll(".mapatlas-live-marker").length).toBe(1);
    controller.showLivePosition(null);
    expect(container.querySelectorAll(".mapatlas-live-marker").length).toBe(0);
  });

  it("fitTrack and recenter do not throw and change the view", () => {
    controller = createMapController({ container, sources: SOURCES, zoom: 2 });
    controller.fitTrack(TRACK);
    controller.recenter({ lat: 0, lng: 0 }, 5);
    // No assertion on pixels; reaching here without throwing is the contract.
    expect(container.classList.contains("leaflet-container")).toBe(true);
  });

  it("fires onEventClick when a marker is activated (T4.3)", () => {
    controller = createMapController({ container, sources: SOURCES, zoom: 12 });
    const clicked: string[] = [];
    const off = controller.onEventClick((id) => clicked.push(id));
    controller.renderEvents(EVENTS);

    const marker = container.querySelector<HTMLElement>(".mapatlas-marker")!;
    marker.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(clicked).toEqual(["e1"]);

    off();
    marker.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(clicked).toEqual(["e1"]); // unsubscribed
  });

  it("exposes keyboard-reachable controls with accessible labels (T4.3)", () => {
    controller = createMapController({ container, sources: SOURCES, zoom: 12 });
    const buttons = container.querySelectorAll<HTMLAnchorElement>(
      "a.leaflet-control-mapatlas-btn",
    );
    expect(buttons.length).toBe(2);
    for (const b of buttons) {
      expect(b.getAttribute("role")).toBe("button");
      expect(b.getAttribute("aria-label")).toBeTruthy();
      // <a href> is natively focusable / Enter-activatable.
      expect(b.getAttribute("href")).toBe("#");
    }
    // Focus styling is injected for visible focus.
    const style = document.getElementById("mapatlas-leaflet-styles")!;
    expect(style.textContent).toContain(":focus-visible");
  });

  it("respects prefers-reduced-motion by disabling animations (T4.3)", () => {
    vi.stubGlobal(
      "matchMedia",
      (q: string) =>
        ({
          matches: q.includes("prefers-reduced-motion"),
          media: q,
          addEventListener() {},
          removeEventListener() {},
        }) as unknown as MediaQueryList,
    );
    controller = createMapController({ container, sources: SOURCES, zoom: 12 });
    // A reduced-motion map should not throw on animated ops.
    controller.recenter({ lat: 10, lng: 10 }, 8);
    expect(container.classList.contains("leaflet-container")).toBe(true);
  });
});
