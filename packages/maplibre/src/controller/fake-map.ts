// SPDX-License-Identifier: Apache-2.0

import type { LayerSpecification, SourceSpecification, TerrainSpecification } from "maplibre-gl";

import type { EngineFeatureCollection } from "./engine-layers.js";
import type {
  MapConstructorOptions,
  MapEventName,
  MapLike,
  MapPointerEvent,
  MarkerHandle,
  MarkerOptions,
  RenderedFeature,
} from "./environment.js";

/**
 * A MapLibre stand-in that **enforces MapLibre's rules** rather than merely recording calls.
 *
 * A fake that accepts anything can only prove the controller made some calls; this one
 * fails the same way the real map does, so an ordering mistake is a test failure rather
 * than a passing test and a broken map. It rejects a duplicate source id, a layer naming a
 * source that is not installed, removing a source a layer still references, and removing
 * anything that was never added.
 *
 * Kept out of `@mapatlas/core/testing` and out of the barrel: it exists to test this
 * package's own controller, not to be a fixture consumers build on.
 */

export type MapCall =
  | { readonly op: "addSource"; readonly id: string }
  | { readonly op: "removeSource"; readonly id: string }
  | { readonly op: "addLayer"; readonly id: string; readonly source: string }
  | { readonly op: "removeLayer"; readonly id: string }
  | { readonly op: "setTerrain"; readonly source: string | null }
  | { readonly op: "setSourceData"; readonly id: string; readonly featureCount: number }
  | {
      readonly op: "fitBounds";
      readonly bounds: readonly [number, number, number, number];
      readonly paddingPx: number;
    }
  | { readonly op: "jumpTo"; readonly center: readonly [number, number] }
  | { readonly op: "remove" };

export class FakeMapError extends Error {}

/** Both shapes the seam's overloads accept, since one store holds listeners for each. */
type AnyListener = ((event: MapPointerEvent) => void) & (() => void);

/**
 * How far a gesture may travel and still produce a click.
 *
 * MapLibre's own threshold: past it the gesture is a drag and no `click` is dispatched.
 */
const CLICK_TOLERANCE_PX = 3;

export interface FakeMap extends MapLike {
  /** Every call in the order it arrived. */
  readonly calls: readonly MapCall[];
  /** What the map currently holds, in installation order. */
  readonly sourceIds: readonly string[];
  readonly layerIds: readonly string[];
  /** The layer definitions as installed, so a test can assert on what MapLibre received. */
  readonly layerSpecs: readonly LayerSpecification[];
  /** What each GeoJSON source currently holds, after every `setSourceData`. */
  data(id: string): EngineFeatureCollection | undefined;
  /** How the controller constructed this map. */
  /** The terrain currently applied, matching what MapLibre's own `getTerrain()` reports. */
  readonly terrain: TerrainSpecification | null;
  readonly options: MapConstructorOptions;
  readonly loadListenerCount: number;
  fireLoad(): void;

  /** Listener counts by event, so a test can prove every one was detached. */
  listenerCount(type?: MapEventName): number;
  /** What a hit test finds; a test sets what is under the pointer. */
  featuresUnderPointer: RenderedFeature[];
  /** Points the map was asked about, so a test can check *where* it looked. */
  readonly queriedPoints: readonly { x: number; y: number }[];
  /** Layers the map was asked about, so a test can check *what* it looked at. */
  readonly queriedLayers: readonly (readonly string[])[];
  /** Drive a gesture. Returns whether a listener called `preventDefault`. */
  firePointer(type: MapEventName, at?: { x: number; y: number; lng: number; lat: number }): boolean;
  /** Whether panning is currently enabled, and how many times it changed. */
  readonly dragPanEnabled: boolean;
  readonly dragPanChanges: readonly boolean[];
}

/** Terrain declared by a base style document, if any. */
function styleTerrain(style: MapConstructorOptions["style"]): TerrainSpecification | null {
  if (typeof style !== "object" || style === null || Array.isArray(style)) return null;
  const declared = (style as Record<string, unknown>)["terrain"];
  if (typeof declared !== "object" || declared === null || Array.isArray(declared)) return null;
  return declared as TerrainSpecification;
}

/**
 * State a base style brought with it.
 *
 * Modelled separately from `options.style` because the case that matters is a style **URL**:
 * the renderer fetches it, so nothing can inspect it beforehand, and whatever it declares is
 * simply present by the time the controller runs.
 */
export interface PreinstalledStyleState {
  readonly sources?: readonly string[];
  readonly layers?: readonly LayerSpecification[];
}

export function createFakeMap(
  options: MapConstructorOptions,
  preinstalled: PreinstalledStyleState = {},
): FakeMap {
  const calls: MapCall[] = [];
  const sources = new Map<string, SourceSpecification>(
    (preinstalled.sources ?? []).map((id) => [id, { type: "geojson" } as SourceSpecification]),
  );
  const layers = new Map<string, LayerSpecification>(
    (preinstalled.layers ?? []).map((layer) => [layer.id, layer]),
  );
  const sourceData = new Map<string, EngineFeatureCollection>();
  /** Layer ids in draw order, which `beforeId` inserts into rather than appends to. */
  let order: string[] = (preinstalled.layers ?? []).map((layer) => layer.id);
  const listeners = new Map<MapEventName, AnyListener[]>();
  const queriedPoints: { x: number; y: number }[] = [];
  const queriedLayers: string[][] = [];
  const dragPanChanges: boolean[] = [];
  let dragPanEnabled = true;
  /** Where the pointer went down, and how far it has travelled since. */
  let gestureStart: { x: number; y: number } | null = null;
  let gestureTravel = 0;
  // A style document may declare terrain, and MapLibre applies it without the controller
  // asking. Starting from the style rather than from `null` is what lets a test show that
  // the controller owns terrain it did not itself set.
  let terrain: TerrainSpecification | null = styleTerrain(options.style);
  let removed = false;

  function assertLive(operation: string): void {
    if (removed) throw new FakeMapError(`${operation} after remove()`);
  }

  return {
    options,
    get calls() {
      return calls;
    },
    get sourceIds() {
      return [...sources.keys()];
    },
    get layerIds() {
      return [...order];
    },
    data(id: string) {
      return sourceData.get(id);
    },
    get layerSpecs() {
      return [...layers.values()];
    },
    get terrain() {
      return terrain;
    },
    get loadListenerCount() {
      return (listeners.get("load") ?? []).length;
    },
    listenerCount(type?: MapEventName) {
      if (type !== undefined) return (listeners.get(type) ?? []).length;
      return [...listeners.values()].reduce((total, group) => total + group.length, 0);
    },
    featuresUnderPointer: [],
    get queriedPoints() {
      return queriedPoints;
    },
    get queriedLayers() {
      return queriedLayers;
    },
    get dragPanEnabled() {
      return dragPanEnabled;
    },
    get dragPanChanges() {
      return dragPanChanges;
    },

    // Implements both overloads. A `load` listener takes no argument and a pointer listener
    // takes one, so the store holds the shape that satisfies both and each caller gets back
    // exactly what it registered.
    on(type: MapEventName, listener: AnyListener): void {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    off(type: MapEventName, listener: AnyListener): void {
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter((registered) => registered !== listener),
      );
    },
    fireLoad(): void {
      for (const listener of [...(listeners.get("load") ?? [])]) listener();
    },

    firePointer(
      type: MapEventName,
      at: { x: number; y: number; lng: number; lat: number } = { x: 0, y: 0, lng: 0, lat: 0 },
    ): boolean {
      // MapLibre suppresses `click` once a gesture passes its movement tolerance, so a
      // completed drag is followed by no click at all. A fake that let a test fire one anyway
      // would hide the bug where a gesture kept past that point swallows the next unrelated
      // click — which is exactly the bug it did hide.
      if (type === "mousedown" || type === "touchstart") {
        gestureStart = { x: at.x, y: at.y };
        gestureTravel = 0;
      }
      if (gestureStart !== null && (type === "mousemove" || type === "touchmove")) {
        gestureTravel = Math.max(
          gestureTravel,
          Math.hypot(at.x - gestureStart.x, at.y - gestureStart.y),
        );
      }
      if (type === "touchcancel") {
        // A cancelled touch is not a finished one: the platform has stopped tracking it, and
        // no click is dispatched for the sequence it belonged to. Modelling that here is what
        // makes "nothing is waiting for a click after a cancel" a fact about the renderer
        // rather than a claim in a comment.
        gestureStart = null;
        gestureTravel = 0;
      }
      if (type === "click" && gestureTravel > CLICK_TOLERANCE_PX) {
        throw new FakeMapError(
          `the renderer would not fire "click" after a gesture that travelled ` +
            `${gestureTravel.toFixed(1)}px — its tolerance is ${String(CLICK_TOLERANCE_PX)}px`,
        );
      }
      if (type === "click") {
        if (gestureStart === null) {
          // The renderer never sends a click without its own press first, so a test firing a
          // bare one is modelling something that cannot happen — and would be exercising the
          // controller against an input it will never see.
          throw new FakeMapError(
            `the renderer would not fire "click" without a preceding press — fire mousedown ` +
              `and mouseup first, or the gesture this click belongs to does not exist`,
          );
        }
        gestureStart = null;
        gestureTravel = 0;
      }

      let prevented = false;
      const event: MapPointerEvent = {
        point: { x: at.x, y: at.y },
        lngLat: { lng: at.lng, lat: at.lat },
        preventDefault: () => {
          prevented = true;
        },
      };
      for (const listener of [...(listeners.get(type) ?? [])]) listener(event);
      return prevented;
    },

    queryRenderedFeatures(
      point: { x: number; y: number },
      layerIds: readonly string[],
    ): readonly RenderedFeature[] {
      queriedPoints.push(point);
      // Recorded, so a test can assert *which* layers were asked about. Answering the same
      // way whatever was asked would leave the layer id unguarded here, and its only other
      // guard is a browser test — one duplicated string away from silently passing.
      queriedLayers.push([...layerIds]);
      return this.featuresUnderPointer;
    },

    dragPan: {
      enable(): void {
        dragPanEnabled = true;
        dragPanChanges.push(true);
      },
      disable(): void {
        dragPanEnabled = false;
        dragPanChanges.push(false);
      },
      isEnabled(): boolean {
        return dragPanEnabled;
      },
    },

    addSource(id: string, source: SourceSpecification): void {
      assertLive("addSource");
      if (sources.has(id)) throw new FakeMapError(`source "${id}" already exists`);
      sources.set(id, source);
      calls.push({ op: "addSource", id });
    },

    removeSource(id: string): void {
      assertLive("removeSource");
      if (!sources.has(id)) throw new FakeMapError(`no source "${id}"`);
      const dependent = [...layers.entries()].find(
        ([, spec]) => "source" in spec && spec.source === id,
      );
      if (dependent !== undefined) {
        throw new FakeMapError(`source "${id}" is still used by layer "${dependent[0]}"`);
      }
      if (terrain !== null && terrain.source === id) {
        throw new FakeMapError(`source "${id}" is still used by terrain`);
      }
      sources.delete(id);
      sourceData.delete(id);
      calls.push({ op: "removeSource", id });
    },

    addLayer(layer: LayerSpecification, beforeId?: string): void {
      assertLive("addLayer");
      if (layers.has(layer.id)) throw new FakeMapError(`layer "${layer.id}" already exists`);
      const source = "source" in layer ? layer.source : undefined;
      if (typeof source !== "string" || !sources.has(source)) {
        throw new FakeMapError(`layer "${layer.id}" names no installed source`);
      }
      // MapLibre throws on an unknown `beforeId`, which is what makes the engine anchor a
      // real ordering constraint rather than a hint.
      if (beforeId !== undefined && !layers.has(beforeId)) {
        throw new FakeMapError(`layer "${layer.id}" names no existing beforeId "${beforeId}"`);
      }
      layers.set(layer.id, layer);
      const at = beforeId === undefined ? order.length : order.indexOf(beforeId);
      order.splice(at, 0, layer.id);
      calls.push({ op: "addLayer", id: layer.id, source });
    },

    removeLayer(id: string): void {
      assertLive("removeLayer");
      if (!layers.has(id)) throw new FakeMapError(`no layer "${id}"`);
      layers.delete(id);
      order = order.filter((layerId) => layerId !== id);
      calls.push({ op: "removeLayer", id });
    },

    getLayer(id: string): unknown {
      return layers.get(id);
    },

    setSourceData(id: string, data: EngineFeatureCollection): void {
      assertLive("setSourceData");
      if (!sources.has(id)) throw new FakeMapError(`no source "${id}" to set data on`);
      sourceData.set(id, data);
      calls.push({ op: "setSourceData", id, featureCount: data.features.length });
    },

    fitBounds(bounds: [number, number, number, number], paddingPx: number): void {
      assertLive("fitBounds");
      calls.push({ op: "fitBounds", bounds, paddingPx });
    },

    jumpTo(camera: { center: [number, number]; zoom?: number }): void {
      assertLive("jumpTo");
      calls.push({ op: "jumpTo", center: camera.center });
    },

    setTerrain(next: TerrainSpecification | null): void {
      assertLive("setTerrain");
      if (next !== null && !sources.has(next.source)) {
        // MapLibre rejects terrain naming a source the style does not hold.
        throw new FakeMapError(`terrain names no installed source "${next.source}"`);
      }
      terrain = next;
      calls.push({ op: "setTerrain", source: next === null ? null : next.source });
    },

    getTerrain(): TerrainSpecification | null {
      return terrain;
    },

    remove(): void {
      removed = true;
      calls.push({ op: "remove" });
    },
  };
}

/** A marker the environment handed out, with what was done to it. */
export interface FakeMarker extends MarkerHandle {
  readonly element: HTMLElement;
  /** Fixed at construction by the renderer, which is why an anchor change forces a rebuild. */
  readonly anchor: "center" | "bottom";
  readonly lngLat: readonly [number, number] | null;
  readonly attached: boolean;
  readonly removed: boolean;
}

/**
 * Records placement rather than rendering it.
 *
 * The element is the real thing — built by the controller from a real `Document` — so a test
 * can assert the whole accessibility contract on it: the name, the role, the tab stop, and
 * that activating it by keyboard does what clicking it does.
 */
export function createFakeMarker(element: HTMLElement, options: MarkerOptions): FakeMarker {
  let lngLat: [number, number] | null = null;
  let attached = false;
  let removed = false;

  return {
    element,
    anchor: options.anchor,
    get lngLat() {
      return lngLat;
    },
    get attached() {
      return attached;
    },
    get removed() {
      return removed;
    },
    setLngLat(lng: number, lat: number): void {
      lngLat = [lng, lat];
    },
    addTo(): void {
      attached = true;
    },
    remove(): void {
      removed = true;
      attached = false;
    },
  };
}
