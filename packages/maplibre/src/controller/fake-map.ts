// SPDX-License-Identifier: Apache-2.0

import type { LayerSpecification, SourceSpecification, TerrainSpecification } from "maplibre-gl";

import type { MapConstructorOptions, MapLike } from "./environment.js";

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
  /** How the controller constructed this map. */
  /** The terrain currently applied, which is what MapLibre's own `getTerrain()` reports. */
  readonly terrain: TerrainSpecification | null;
  readonly options: MapConstructorOptions;
  readonly loadListenerCount: number;
  fireLoad(): void;
}

export function createFakeMap(options: MapConstructorOptions): FakeMap {
  const calls: MapCall[] = [];
  const sources = new Map<string, SourceSpecification>();
  const layers = new Map<string, LayerSpecification>();
  let loadListeners: (() => void)[] = [];
  let terrain: TerrainSpecification | null = null;
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
      return [...layers.keys()];
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
      calls.push({ op: "removeSource", id });
    },

    addLayer(layer: LayerSpecification): void {
      assertLive("addLayer");
      if (layers.has(layer.id)) throw new FakeMapError(`layer "${layer.id}" already exists`);
      const source = "source" in layer ? layer.source : undefined;
      if (typeof source !== "string" || !sources.has(source)) {
        throw new FakeMapError(`layer "${layer.id}" names no installed source`);
      }
      layers.set(layer.id, layer);
      calls.push({ op: "addLayer", id: layer.id, source });
    },

    removeLayer(id: string): void {
      assertLive("removeLayer");
      if (!layers.has(id)) throw new FakeMapError(`no layer "${id}"`);
      layers.delete(id);
      calls.push({ op: "removeLayer", id });
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

    remove(): void {
      removed = true;
      calls.push({ op: "remove" });
    },
  };
}
