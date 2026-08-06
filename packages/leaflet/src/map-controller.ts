// SPDX-License-Identifier: Apache-2.0

/**
 * Leaflet renderer (`specs/api.md §6`). Mounts a map into a container, composites
 * an ordered {@link TileSource} stack, and draws the live position, the growing
 * track polyline, and event markers (keyboard-reachable DivIcons — no image
 * assets). All view changes honour `prefers-reduced-motion`.
 *
 * This package renders; it holds no React and no domain knowledge (enforced by
 * the import-isolation scan).
 */
import * as L from "leaflet";
import type {
  Id,
  LatLng,
  MapEvent,
  Track,
  TrackPoint,
  TileSource,
} from "@mapatlas/core";
import { createTileLayer } from "./tile-layers";

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

const DEFAULT_CENTER: L.LatLngExpression = [0, 0];
const DEFAULT_ZOOM = 2;
const EVENT_MARKER_CLASS = "mapatlas-event-marker";
const LIVE_MARKER_CLASS = "mapatlas-live-position";

/** Injected once so keyboard focus on markers/controls is always visible. */
const FOCUS_STYLE_ID = "mapatlas-focus-style";
const FOCUS_CSS = `
.leaflet-container a:focus-visible,
.leaflet-container button:focus-visible,
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

function eventIcon(): L.DivIcon {
  return L.divIcon({
    className: EVENT_MARKER_CLASS,
    html: '<span aria-hidden="true" class="mapatlas-event-marker__pin"></span>',
    iconSize: [24, 24],
    iconAnchor: [12, 24],
  });
}

function liveIcon(): L.DivIcon {
  return L.divIcon({
    className: LIVE_MARKER_CLASS,
    html: '<span aria-hidden="true" class="mapatlas-live-position__dot"></span>',
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });
}

export function createMapController(o: MapControllerOptions): MapController {
  ensureFocusStyle();

  const map = L.map(o.container, {
    center: o.center ? [o.center.lat, o.center.lng] : DEFAULT_CENTER,
    zoom: o.zoom ?? DEFAULT_ZOOM,
    keyboard: true,
    zoomControl: true,
    // Render vectors with SVG (the standard, deterministic renderer). The `L.svg()`
    // factory returns null when capability detection fails (e.g. under jsdom), so
    // instantiate the renderer class directly to stay host-independent.
    renderer: new L.SVG(),
  });

  // Drop Leaflet's branded/flagged default attribution prefix; keep only the
  // per-source data attributions (the legally required ones).
  map.attributionControl.setPrefix(false);

  let tileLayers: L.Layer[] = [];
  let trackPolyline: L.Polyline | undefined;
  const eventMarkers = new Map<Id, L.Marker>();
  let liveMarker: L.Marker | undefined;

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

  map.on("click", (e: L.LeafletMouseEvent) => {
    const at: LatLng = { lat: e.latlng.lat, lng: e.latlng.lng };
    for (const cb of tapCbs) cb(at);
  });

  return {
    setSources(sources: TileSource[]): void {
      clearSources();
      addSources(sources);
    },

    renderTrack(track: Track | null): void {
      if (trackPolyline) {
        trackPolyline.remove();
        trackPolyline = undefined;
      }
      if (!track) return;
      const line = trackLine(track);
      if (line.length === 0) return;
      trackPolyline = L.polyline(
        line.map((p) => [p.lat, p.lng] as L.LatLngTuple),
        { className: "mapatlas-track", weight: 4 },
      ).addTo(map);
    },

    renderEvents(events: MapEvent[]): void {
      for (const marker of eventMarkers.values()) marker.remove();
      eventMarkers.clear();
      for (const ev of events) {
        const marker = L.marker([ev.position.lat, ev.position.lng], {
          icon: eventIcon(),
          keyboard: true,
          title: ev.comment ?? ev.category ?? "event",
          alt: ev.comment ?? ev.category ?? "map event",
        });
        marker.on("click", () => {
          for (const cb of eventClickCbs) cb(ev.id);
        });
        marker.addTo(map);
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
        liveMarker = L.marker([p.lat, p.lng], {
          icon: liveIcon(),
          keyboard: false,
          interactive: false,
        }).addTo(map);
      } else {
        liveMarker.setLatLng([p.lat, p.lng]);
      }
    },

    fitTrack(track: Track): void {
      const line = trackLine(track);
      if (line.length === 0) return;
      const bounds = L.latLngBounds(
        line.map((p) => [p.lat, p.lng] as L.LatLngTuple),
      );
      map.fitBounds(bounds, { animate: animate(), padding: [24, 24] });
    },

    recenter(to: LatLng, zoom?: number): void {
      map.setView([to.lat, to.lng], zoom ?? map.getZoom(), {
        animate: animate(),
      });
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
      map.remove();
    },
  };
}
