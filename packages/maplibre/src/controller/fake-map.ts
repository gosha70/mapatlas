// SPDX-License-Identifier: Apache-2.0

import type { LayerSpecification, SourceSpecification, TerrainSpecification } from "maplibre-gl";

import type { EngineFeatureCollection } from "./engine-layers.js";
import type { MapConstructorOptions, MapLike, MarkerHandle } from "./environment.js";

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
}

/** Terrain declared by a base style document, if any. */
function styleTerrain(style: MapConstructorOptions["style"]): TerrainSpecification | null {
  if (typeof style !== "object" || style === null || Array.isArray(style)) return null;
  const declared = (style as Record<string, unknown>)["terrain"];
  if (typeof declared !== "object" || declared === null || Array.isArray(declared)) return null;
  return declared as TerrainSpecification;
}

export function createFakeMap(options: MapConstructorOptions): FakeMap {
  const calls: MapCall[] = [];
  const sources = new Map<string, SourceSpecification>();
  const layers = new Map<string, LayerSpecification>();
  const sourceData = new Map<string, EngineFeatureCollection>();
  /** Layer ids in draw order, which `beforeId` inserts into rather than appends to. */
  let order: string[] = [];
  let loadListeners: (() => void)[] = [];
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
      return loadListeners.length;
    },

    on(_type: "load", listener: () => void): void {
      loadListeners.push(listener);
    },
    off(_type: "load", listener: () => void): void {
      loadListeners = loadListeners.filter((registered) => registered !== listener);
    },
    fireLoad(): void {
      for (const listener of [...loadListeners]) listener();
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
export function createFakeMarker(element: HTMLElement): FakeMarker {
  let lngLat: [number, number] | null = null;
  let attached = false;
  let removed = false;

  return {
    element,
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
