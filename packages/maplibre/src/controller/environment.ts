// SPDX-License-Identifier: Apache-2.0

import type { JSONValue } from "@mapatlas/core";
import type { LayerSpecification, SourceSpecification, TerrainSpecification } from "maplibre-gl";

import type { EngineFeatureCollection } from "./engine-layers.js";
import type { DocumentLike } from "../marks/marker-element.js";
import type { ProtocolRegistrar } from "../protocols/pmtiles.js";

/**
 * Everything the controller needs from MapLibre, in one injectable place.
 *
 * Deliberately **not** part of `MapControllerOptions`: how a map is constructed and how a
 * protocol is registered are implementation machinery, and putting them in `api.md` would
 * mean owning their shapes indefinitely for the benefit of nobody who consumes the engine.
 * The internal factory takes one of these; the exported one supplies the real MapLibre.
 *
 * The same seam is what makes the source-stack lifecycle testable at all. A real map needs
 * a WebGL context and only tells you it is ready by firing `load`; a fake tells you exactly
 * which calls arrived, in what order, and lets a test choose when `load` happens.
 */

/**
 * The part of MapLibre's `Map` the controller actually uses.
 *
 * `load` is in the seam because it is not optional detail: MapLibre rejects `addSource` and
 * `addLayer` before the style is ready, so the controller's whole install path hangs off
 * that one event. A fake without it could only test the easy half.
 */
/**
 * Pointer events draw mode listens to.
 *
 * Both families, because both terminate differently: a mouse gesture ends at `mouseup` or
 * leaves at `mouseout`, a touch gesture ends at `touchend` or is taken away at `touchcancel`
 * — by a system gesture, an incoming call, a second finger. Every one of those paths has to
 * release the drag, so every one of them is on the seam.
 */
export type MapPointerEventName =
  | "mousedown"
  | "mousemove"
  | "mouseup"
  | "mouseout"
  | "touchstart"
  | "touchmove"
  | "touchend"
  | "touchcancel"
  | "click";

export type MapEventName = "load" | MapPointerEventName;

/** Where a pointer is, in both spaces, and the one thing a handler can do about it. */
export interface MapPointerEvent {
  /** Screen space, for hit-testing what is under the pointer. */
  point: { x: number; y: number };
  /** Map space, for telling a consumer where a vertex went. */
  lngLat: { lng: number; lat: number };
  /**
   * Stop this gesture becoming a map drag.
   *
   * Called on the down event, before anything else. Disabling `dragPan` inside the callback
   * is not enough on its own — the renderer decides at gesture start whether it owns the
   * pointer, and by the time a handler runs that decision may already be made.
   */
  preventDefault(): void;
}

/** What a hit test returns: only enough to recover which vertex is under the pointer. */
export interface RenderedFeature {
  properties: Record<string, unknown>;
}

/**
 * Map interaction the engine borrows and gives back.
 *
 * `isEnabled` is not decoration. Dragging a vertex has to stop the map panning under it, but
 * a consumer may have disabled panning themselves — so the engine restores the state it
 * found rather than enabling something nobody asked for.
 */
export interface DragPanLike {
  enable(): void;
  disable(): void;
  isEnabled(): boolean;
}

export interface MapLike {
  // Overloaded rather than one signature taking a pointer event, because `load` carries none.
  // A single signature typechecks only because a zero-argument function is assignable to it,
  // and then something has to cast to call the listener back — a seam quietly saying that
  // every listener receives an event when one of them never does.
  on(type: "load", listener: () => void): void;
  on(type: MapPointerEventName, listener: (event: MapPointerEvent) => void): void;
  off(type: "load", listener: () => void): void;
  off(type: MapPointerEventName, listener: (event: MapPointerEvent) => void): void;
  /** What is drawn at a point, restricted to the layers asked about. */
  queryRenderedFeatures(
    point: { x: number; y: number },
    layerIds: readonly string[],
  ): readonly RenderedFeature[];
  readonly dragPan: DragPanLike;
  addSource(id: string, source: SourceSpecification): void;
  removeSource(id: string): void;
  /**
   * Draw order is add order, which is why the controller installs in declared order.
   *
   * `beforeId` inserts below an existing layer instead of on top. Consumer layers use it to
   * stay under the engine's persistent overlays: without it, replacing the source stack
   * would put a fresh basemap above the track it is supposed to sit beneath.
   */
  addLayer(layer: LayerSpecification, beforeId?: string): void;
  removeLayer(id: string): void;
  /**
   * Whether a layer is in the style.
   *
   * Engine layers are installed once, and "once" is decided by asking the map rather than by
   * a flag the controller keeps — the same reasoning that removed the mirrored terrain
   * state. A flag says what the controller did; the map says what is true.
   */
  getLayer(id: string): unknown;
  /**
   * Replace what a GeoJSON source holds.
   *
   * Narrower than exposing `getSource`, and the reason engine layers are installed once and
   * updated rather than rebuilt: a live position arriving every second must not churn the
   * layer stack.
   */
  setSourceData(id: string, data: EngineFeatureCollection): void;
  /**
   * Terrain is another consumer of the source stack, exactly as layers are, so it appears
   * on the same seam. `null` disables it — and must be sent before the DEM source it names
   * is removed, since MAP-ATLAS treats terrain as a source dependency.
   */
  setTerrain(terrain: TerrainSpecification | null): void;
  /**
   * What terrain the map *actually* has, which is not always what this controller applied.
   *
   * A base `style` may carry its own `terrain`, and MapLibre honours it as the style loads —
   * before the controller has done anything. Mirroring applied state in a variable would
   * start wrong in exactly that case and stay wrong, so the map is asked instead.
   */
  getTerrain(): TerrainSpecification | null;
  /** Frame a bounding box, in `[west, south, east, north]` degrees. */
  fitBounds(bounds: [number, number, number, number], paddingPx: number): void;
  /** Move the camera without animating — motion policy is T4.7's to decide. */
  jumpTo(camera: { center: [lng: number, lat: number]; zoom?: number }): void;
  remove(): void;
}

/**
 * What the controller hands MapLibre's constructor.
 *
 * `style` and `attributionControl` are **required** here even though MapLibre makes both
 * optional, because leaving either to the library is a decision the engine has already
 * made differently: a map with no style needs `setStyle()` before it renders anything, and
 * the default attribution control ships MapLibre's own attribution, which ADR-0008 says the
 * engine does not put in a consumer's app.
 */
export interface MapConstructorOptions {
  container: HTMLElement;
  style: string | JSONValue;
  center?: [lng: number, lat: number];
  zoom?: number;
  attributionControl: { customAttribution: string[] };
}

/**
 * Renderer options fixed when a marker is constructed.
 *
 * `anchor` says which part of the element sits on the coordinate — a pin's tip, a dot's
 * centre — and MapLibre takes it at construction and never after. So it belongs here rather
 * than in the element styling, and a mark whose anchor changes is rebuilt rather than
 * updated.
 */
export interface MarkerOptions {
  anchor: "center" | "bottom";
}

/** A placed marker, from the renderer's own marker implementation. */
export interface MarkerHandle {
  setLngLat(lng: number, lat: number): void;
  addTo(map: MapLike): void;
  remove(): void;
}

export interface MapEnvironment {
  createMap(options: MapConstructorOptions): MapLike;
  /**
   * Construct the renderer's marker around an engine-owned element.
   *
   * Construction belongs here rather than on `MapLike` for the same reason `createMap` does:
   * the environment owns the renderer's constructors, and the map instance owns operations
   * on a map. A `MapLike` that could build markers would be two things at once.
   */
  createMarker(element: HTMLElement, options: MarkerOptions): MarkerHandle;
  /**
   * A pointer release anywhere in the document, and a function to stop listening.
   *
   * The map cannot answer this. Its `mouseup` fires only for a release over the container, so
   * a drag that ends a pixel outside it — an ordinary thing to do near a map's edge — never
   * ends, and the pan behaviour the drag borrowed is never given back.
   *
   * The map's `mouseout` looks like the answer and is not: it bubbles, so it fires when the
   * pointer crosses a marker *inside* the map, cancelling a drag mid-gesture and re-enabling
   * panning while the button is still down — the rest of the gesture then pans the map.
   * Measured, not reasoned: dragging a vertex across a mark 75px away restored panning at that
   * exact point and dropped the remaining half of the moves.
   *
   * A document listener outlives the map that installed it, so the returned unsubscribe is
   * called on **every** path that ends a drag — release, cancellation, `exit()` and `destroy()`
   * — and a missed one leaks silently, since nothing on the map is left pointing at it.
   *
   * `setPointerCapture` on the canvas is the platform's own version of this and would need no
   * teardown discipline, but reaching it means either exposing the renderer's original event
   * through this seam to get a `pointerId`, or attaching a second listener directly to the
   * container alongside the renderer's own. Both are larger than the discipline they replace;
   * recorded as the better shape if this seam ever carries pointer events natively.
   */
  onPointerRelease(listener: () => void): () => void;
  /**
   * Where engine-owned marker elements come from.
   *
   * On the seam rather than reached for as a global, so the accessibility contract those
   * elements carry can be asserted without a browser.
   */
  document: DocumentLike;
  protocolRegistrar: ProtocolRegistrar;
}
