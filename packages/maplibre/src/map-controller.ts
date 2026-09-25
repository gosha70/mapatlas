// SPDX-License-Identifier: Apache-2.0

/**
 * MapLibre GL renderer (`specs/api.md §6`). Mounts a map into a container,
 * composites an ordered {@link TileSource} stack, and draws the live
 * position, the growing track line, and event markers (keyboard-reachable
 * HTML `Marker`s — no image assets). All view changes honour
 * `prefers-reduced-motion`.
 *
 * MapLibre requires the style to be loaded before `addSource`/`addLayer`
 * (Leaflet's layer model was synchronous). Tile-source and track-line setup
 * go through a `map.once("load", ...)` queue so calls made before the style
 * finishes loading still take effect once it does. Markers, click handling,
 * and camera moves need no such queue — they work as soon as the map
 * instance exists.
 *
 * This package renders; it holds no React and no domain knowledge (enforced
 * by the import-isolation scan).
 */
import {
  Map as MaplibreMap,
  Marker,
  LngLatBounds,
  AttributionControl,
} from "maplibre-gl";
import type { MapMouseEvent, GeoJSONSource } from "maplibre-gl";
import type {
  Id,
  LatLng,
  MapEvent,
  Track,
  TrackPoint,
  TileSource,
} from "@mapatlas/core";
import { createTileLayer, type MapLibreTileLayer } from "./tile-layers";

export interface MapControllerOptions {
  container: HTMLElement;
  /** ordered base → overlays */
  sources: TileSource[];
  center?: LatLng;
  zoom?: number;
}

export interface MapController {
  setSources(sources: TileSource[]): void;
  renderTrack(track: Track | null): void;
  renderEvents(events: MapEvent[]): void;
  showLivePosition(p: TrackPoint | null): void;
  fitTrack(track: Track): void;
  recenter(to: LatLng, zoom?: number): void;
  onMapTap(cb: (at: LatLng) => void): () => void;
  onEventClick(cb: (id: Id) => void): () => void;
  destroy(): void;
}

const DEFAULT_CENTER: [number, number] = [0, 0];
const DEFAULT_ZOOM = 2;
const EVENT_MARKER_CLASS = "mapatlas-event-marker";
const LIVE_MARKER_CLASS = "mapatlas-live-position";
const TRACK_SOURCE_ID = "mapatlas-track";
const TRACK_LAYER_ID = "mapatlas-track-layer";

/** Injected once so keyboard focus on markers/controls is always visible. */
const FOCUS_STYLE_ID = "mapatlas-focus-style";
const FOCUS_CSS = `
.maplibregl-map a:focus-visible,
.maplibregl-map button:focus-visible,
.${EVENT_MARKER_CLASS}:focus-visible,
.${EVENT_MARKER_CLASS}:focus {
  outline: 3px solid #1d4ed8;
  outline-offset: 2px;
}`;

function ensureFocusStyle(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById(FOCUS_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = FOCUS_STYLE_ID;
  style.textContent = FOCUS_CSS;
  document.head.appendChild(style);
}

function prefersReducedMotion(): boolean {
  if (
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function"
  ) {
    return false;
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function trackLine(track: Track): TrackPoint[] {
  const pts =
    track.simplified && track.simplified.length > 0
      ? track.simplified
      : track.points;
  return pts;
}

function emptyLineFC(): GeoJSON.FeatureCollection {
  return { type: "FeatureCollection", features: [] };
}

function lineFC(points: TrackPoint[]): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {},
        geometry: {
          type: "LineString",
          coordinates: points.map((p) => [p.lng, p.lat]),
        },
      },
    ],
  };
}

function eventMarkerElement(ev: MapEvent): HTMLElement {
  const el = document.createElement("span");
  el.className = EVENT_MARKER_CLASS;
  el.setAttribute("role", "button");
  el.tabIndex = 0;
  const label = ev.comment ?? ev.category ?? "map event";
  el.title = label;
  el.setAttribute("aria-label", label);
  const pin = document.createElement("span");
  pin.className = "mapatlas-event-marker__pin";
  pin.setAttribute("aria-hidden", "true");
  el.appendChild(pin);
  return el;
}

function liveMarkerElement(): HTMLElement {
  const el = document.createElement("span");
  el.className = LIVE_MARKER_CLASS;
  el.setAttribute("aria-hidden", "true");
  el.style.pointerEvents = "none";
  const dot = document.createElement("span");
  dot.className = "mapatlas-live-position__dot";
  dot.setAttribute("aria-hidden", "true");
  el.appendChild(dot);
  return el;
}

export function createMapController(o: MapControllerOptions): MapController {
  ensureFocusStyle();

  const map = new MaplibreMap({
    container: o.container,
    style: { version: 8, sources: {}, layers: [] },
    center: o.center ? [o.center.lng, o.center.lat] : DEFAULT_CENTER,
    zoom: o.zoom ?? DEFAULT_ZOOM,
    // The engine owns attribution: no default/branded control, no inherited
    // logo or prefix — only the per-source attributions declared below.
    attributionControl: false,
  });
  map.addControl(new AttributionControl({ compact: false }));

  // Defer addSource/addLayer calls until the style has finished loading.
  let styleLoaded = map.isStyleLoaded();
  const pendingOnLoad: Array<() => void> = [];
  map.once("load", () => {
    styleLoaded = true;
    const ops = pendingOnLoad.splice(0);
    for (const op of ops) op();
  });
  const onceLoaded = (op: () => void): void => {
    if (styleLoaded || map.isStyleLoaded()) op();
    else pendingOnLoad.push(op);
  };

  let tileLayers: MapLibreTileLayer[] = [];
  let trackLayerReady = false;
  const eventMarkers = new Map<Id, Marker>();
  let liveMarker: Marker | undefined;

  const tapCbs = new Set<(at: LatLng) => void>();
  const eventClickCbs = new Set<(id: Id) => void>();

  const animate = (): boolean => !prefersReducedMotion();

  const addSources = (sources: TileSource[]): void => {
    for (const source of sources) {
      const layer = createTileLayer(source);
      layer.addTo(map);
      tileLayers.push(layer);
    }
  };

  const clearSources = (): void => {
    for (const layer of tileLayers) layer.remove();
    tileLayers = [];
  };

  addSources(o.sources);

  const ensureTrackLayer = (): void => {
    if (trackLayerReady) return;
    map.addSource(TRACK_SOURCE_ID, { type: "geojson", data: emptyLineFC() });
    map.addLayer({
      id: TRACK_LAYER_ID,
      type: "line",
      source: TRACK_SOURCE_ID,
      paint: { "line-width": 4, "line-color": "#1d4ed8" },
    });
    trackLayerReady = true;
  };

  map.on("click", (e: MapMouseEvent) => {
    const at: LatLng = { lat: e.lngLat.lat, lng: e.lngLat.lng };
    for (const cb of tapCbs) cb(at);
  });

  return {
    setSources(sources: TileSource[]): void {
      clearSources();
      addSources(sources);
    },

    renderTrack(track: Track | null): void {
      onceLoaded(() => {
        ensureTrackLayer();
        const source = map.getSource<GeoJSONSource>(TRACK_SOURCE_ID);
        if (!track) {
          source?.setData(emptyLineFC());
          return;
        }
        const line = trackLine(track);
        source?.setData(line.length > 0 ? lineFC(line) : emptyLineFC());
      });
    },

    renderEvents(events: MapEvent[]): void {
      for (const marker of eventMarkers.values()) marker.remove();
      eventMarkers.clear();
      for (const ev of events) {
        const el = eventMarkerElement(ev);
        const trigger = (): void => {
          for (const cb of eventClickCbs) cb(ev.id);
        };
        el.addEventListener("click", trigger);
        el.addEventListener("keydown", (e: KeyboardEvent) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            trigger();
          }
        });
        const marker = new Marker({ element: el })
          .setLngLat([ev.position.lng, ev.position.lat])
          .addTo(map);
        eventMarkers.set(ev.id, marker);
      }
    },

    showLivePosition(p: TrackPoint | null): void {
      if (!p) {
        if (liveMarker) {
          liveMarker.remove();
          liveMarker = undefined;
        }
        return;
      }
      if (!liveMarker) {
        liveMarker = new Marker({ element: liveMarkerElement() })
          .setLngLat([p.lng, p.lat])
          .addTo(map);
      } else {
        liveMarker.setLngLat([p.lng, p.lat]);
      }
    },

    fitTrack(track: Track): void {
      const line = trackLine(track);
      if (line.length === 0) return;
      const first = line[0]!;
      const bounds = line.reduce(
        (b, p) => b.extend([p.lng, p.lat]),
        new LngLatBounds([first.lng, first.lat], [first.lng, first.lat]),
      );
      map.fitBounds(bounds, { padding: 24, animate: animate() });
    },

    recenter(to: LatLng, zoom?: number): void {
      const opts = {
        center: [to.lng, to.lat] as [number, number],
        zoom: zoom ?? map.getZoom(),
      };
      if (animate()) map.easeTo(opts);
      else map.jumpTo(opts);
    },

    onMapTap(cb: (at: LatLng) => void): () => void {
      tapCbs.add(cb);
      return () => tapCbs.delete(cb);
    },

    onEventClick(cb: (id: Id) => void): () => void {
      eventClickCbs.add(cb);
      return () => eventClickCbs.delete(cb);
    },

    destroy(): void {
      tapCbs.clear();
      eventClickCbs.clear();
      for (const marker of eventMarkers.values()) marker.remove();
      eventMarkers.clear();
      liveMarker?.remove();
      map.remove();
    },
  };
}
