// SPDX-License-Identifier: Apache-2.0

/**
 * `createMapController` (tasks T4.1–T4.3): mount a Leaflet map with an ordered
 * {@link TileSource} stack, render the live position, a growing track polyline,
 * and event markers, and expose imperative controls the React layer wraps.
 *
 * Accessibility (T4.3): custom controls are keyboard-reachable `<a role=button>`
 * elements with visible focus, event markers are focusable/Enter-activatable,
 * and `prefers-reduced-motion` disables map + pan/zoom animation.
 *
 * This package depends on Leaflet and the DOM but never on React — the
 * isolation scan enforces that boundary.
 */
import L from "leaflet";
import type {
  Id,
  LatLng,
  MapEvent,
  Track,
  TrackPoint,
  TileSource,
} from "@mapatlas/core";
import { buildLayer } from "./tile-layers.js";

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

const STYLE_ID = "mapatlas-leaflet-styles";

/** Inject focus-visibility + marker styles once per document (a11y, T4.3). */
function injectStyles(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
.leaflet-container a.leaflet-control-mapatlas-btn,
.leaflet-control-zoom a,
.leaflet-marker-icon.mapatlas-marker { cursor: pointer; }
.leaflet-container a:focus-visible,
.leaflet-marker-icon:focus-visible {
  outline: 3px solid #1a73e8;
  outline-offset: 2px;
}
.mapatlas-event-marker, .mapatlas-live-marker {
  border-radius: 50%;
  border: 2px solid #fff;
  box-shadow: 0 0 0 1px rgba(0,0,0,.4);
  box-sizing: border-box;
}
.mapatlas-event-marker { width: 18px; height: 18px; background: #d93025; }
.mapatlas-live-marker { width: 16px; height: 16px; background: #1a73e8; }
@media (prefers-reduced-motion: reduce) {
  .leaflet-fade-anim .leaflet-tile,
  .leaflet-zoom-anim .leaflet-zoom-animated { transition: none !important; }
}`;
  document.head.appendChild(style);
}

function prefersReducedMotion(): boolean {
  const mm = globalThis.matchMedia;
  if (typeof mm !== "function") return false;
  try {
    return mm("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

function pointsOf(track: Track): TrackPoint[] {
  return track.simplified && track.simplified.length > 0
    ? track.simplified
    : track.points;
}

class LeafletMapController implements MapController {
  private readonly map: L.Map;
  private readonly reduceMotion: boolean;
  private readonly renderer: L.SVG;
  private tileLayers: L.Layer[] = [];
  private readonly eventGroup: L.LayerGroup;
  private trackLine: L.Polyline | undefined;
  private liveMarker: L.Marker | undefined;
  private readonly tapCbs = new Set<(at: LatLng) => void>();
  private readonly eventCbs = new Set<(id: Id) => void>();
  private lastTrack: Track | null = null;

  constructor(opts: MapControllerOptions) {
    injectStyles();
    this.reduceMotion = prefersReducedMotion();

    const mapOptions: L.MapOptions = { zoomControl: true, keyboard: true };
    if (this.reduceMotion) {
      mapOptions.zoomAnimation = false;
      mapOptions.fadeAnimation = false;
      mapOptions.markerZoomAnimation = false;
      mapOptions.inertia = false;
    }
    // Construct the SVG renderer directly rather than via the `L.svg()`
    // factory: the factory returns null in environments (e.g. jsdom) whose
    // SVG feature-detection fails, which would leave vector layers unrendered.
    this.renderer = new L.SVG({ padding: 2 });
    mapOptions.renderer = this.renderer;
    this.map = L.map(opts.container, mapOptions);
    this.map.setView(
      opts.center ? [opts.center.lat, opts.center.lng] : [0, 0],
      opts.zoom ?? 2,
    );

    this.eventGroup = L.layerGroup().addTo(this.map);
    this.setSources(opts.sources);
    this.addControls();

    this.map.on("click", (e: L.LeafletMouseEvent) => {
      const at: LatLng = { lat: e.latlng.lat, lng: e.latlng.lng };
      for (const cb of this.tapCbs) cb(at);
    });
  }

  setSources(sources: TileSource[]): void {
    for (const layer of this.tileLayers) this.map.removeLayer(layer);
    this.tileLayers = [];
    // Base first, overlays after; Leaflet stacks in add order.
    for (const source of sources) {
      const layer = buildLayer(source);
      if (!layer) continue;
      layer.addTo(this.map);
      this.tileLayers.push(layer);
    }
  }

  renderTrack(track: Track | null): void {
    this.lastTrack = track;
    if (this.trackLine) {
      this.map.removeLayer(this.trackLine);
      this.trackLine = undefined;
    }
    if (!track) return;
    const pts = pointsOf(track);
    if (pts.length === 0) return;
    this.trackLine = L.polyline(
      pts.map((p) => [p.lat, p.lng] as L.LatLngTuple),
      {
        className: "mapatlas-track",
        color: "#1a73e8",
        weight: 4,
        renderer: this.renderer,
      },
    ).addTo(this.map);
  }

  renderEvents(events: MapEvent[]): void {
    this.eventGroup.clearLayers();
    for (const ev of events) {
      const icon = L.divIcon({
        className: "mapatlas-marker",
        html: `<span class="mapatlas-event-marker" aria-hidden="true"></span>`,
        iconSize: [18, 18],
        iconAnchor: [9, 9],
      });
      const label = ev.comment?.trim() || ev.category || "Map event";
      const marker = L.marker([ev.position.lat, ev.position.lng], {
        icon,
        keyboard: true,
        title: label,
        alt: label,
      });
      marker.on("click", () => {
        for (const cb of this.eventCbs) cb(ev.id);
      });
      marker.on("keypress", (e: L.LeafletKeyboardEvent) => {
        if (e.originalEvent.key === "Enter" || e.originalEvent.key === " ") {
          for (const cb of this.eventCbs) cb(ev.id);
        }
      });
      this.eventGroup.addLayer(marker);
    }
  }

  showLivePosition(p: TrackPoint | null): void {
    if (!p) {
      if (this.liveMarker) {
        this.map.removeLayer(this.liveMarker);
        this.liveMarker = undefined;
      }
      return;
    }
    const latlng: L.LatLngTuple = [p.lat, p.lng];
    if (this.liveMarker) {
      this.liveMarker.setLatLng(latlng);
      return;
    }
    const icon = L.divIcon({
      className: "mapatlas-marker",
      html: `<span class="mapatlas-live-marker" aria-hidden="true"></span>`,
      iconSize: [16, 16],
      iconAnchor: [8, 8],
    });
    this.liveMarker = L.marker(latlng, {
      icon,
      keyboard: false,
      title: "Your position",
      alt: "Your position",
    }).addTo(this.map);
  }

  fitTrack(track: Track): void {
    const pts = pointsOf(track);
    if (pts.length === 0) return;
    const bounds = L.latLngBounds(pts.map((p) => [p.lat, p.lng]));
    this.map.fitBounds(bounds, {
      animate: !this.reduceMotion,
      padding: [24, 24],
    });
  }

  recenter(to: LatLng, zoom?: number): void {
    this.map.setView([to.lat, to.lng], zoom ?? this.map.getZoom(), {
      animate: !this.reduceMotion,
    });
  }

  onMapTap(cb: (at: LatLng) => void): () => void {
    this.tapCbs.add(cb);
    return () => this.tapCbs.delete(cb);
  }

  onEventClick(cb: (id: Id) => void): () => void {
    this.eventCbs.add(cb);
    return () => this.eventCbs.delete(cb);
  }

  destroy(): void {
    this.tapCbs.clear();
    this.eventCbs.clear();
    this.map.remove();
  }

  /** Keyboard-reachable recenter / fit-track controls (a11y, T4.3). */
  private addControls(): void {
    const control = new L.Control({ position: "topright" });
    control.onAdd = (): HTMLElement => {
      const bar = L.DomUtil.create("div", "leaflet-bar mapatlas-control");
      bar.setAttribute("role", "group");
      bar.setAttribute("aria-label", "Map view controls");

      const mkButton = (
        label: string,
        text: string,
        action: () => void,
      ): void => {
        const a = L.DomUtil.create(
          "a",
          "leaflet-control-mapatlas-btn",
          bar,
        ) as HTMLAnchorElement;
        a.href = "#";
        a.setAttribute("role", "button");
        a.setAttribute("aria-label", label);
        a.title = label;
        a.textContent = text;
        L.DomEvent.on(a, "click", (e: Event) => {
          L.DomEvent.preventDefault(e);
          L.DomEvent.stopPropagation(e);
          action();
        });
      };

      mkButton("Fit track to view", "▣", () => {
        if (this.lastTrack) this.fitTrack(this.lastTrack);
      });
      mkButton("Recenter on live position", "◎", () => {
        const ll = this.liveMarker?.getLatLng();
        if (ll) this.recenter({ lat: ll.lat, lng: ll.lng });
      });

      L.DomEvent.disableClickPropagation(bar);
      return bar;
    };
    control.addTo(this.map);
  }
}

/** Create a {@link MapController} mounted on the given container. */
export function createMapController(opts: MapControllerOptions): MapController {
  return new LeafletMapController(opts);
}
