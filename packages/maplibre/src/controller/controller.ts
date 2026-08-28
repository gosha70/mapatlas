// SPDX-License-Identifier: Apache-2.0

import type { JSONValue, LatLng, TileSource } from "@mapatlas/core";

import type { BuiltTileSource } from "../builders/tile-source.js";
import { buildTileSources, usesPmtiles } from "../builders/tile-source.js";
import { ensurePmtilesProtocol } from "../protocols/pmtiles.js";
import type { MapEnvironment, MapLike } from "./environment.js";

/**
 * The map controller's source-stack half (T4.1).
 *
 * Two ideas carry the whole file.
 *
 * **The controller models desired state, not a command log.** `setSources` records what the
 * map should show and reconciles if it can; it never queues work. Calling it three times
 * before the style loads installs the third stack once, not three stacks in sequence — the
 * first two describe a map nobody ever saw.
 *
 * **Installation waits for `load`.** MapLibre rejects `addSource` and `addLayer` until the
 * style is ready, so construction is synchronous for the consumer while the install path
 * hangs off that event.
 */

/**
 * An empty MapLibre style, used when the consumer supplies none.
 *
 * Not an arbitrary default: MapLibre documents that a map built without `style` needs
 * `setStyle()` before it renders at all, so omitting it would hand the consumer a map that
 * silently does nothing. An empty v8 document is the smallest thing the engine's own source
 * stack can composite onto, and it ships no basemap the consumer did not ask for.
 */
export const EMPTY_STYLE: JSONValue = Object.freeze({
  version: 8,
  sources: {},
  layers: [],
}) as JSONValue;

/**
 * Attribution when the consumer names no prefix: none.
 *
 * Explicitly none, rather than absent. MapLibre's default attribution control carries
 * MapLibre's own attribution, and ADR-0008 says the engine does not put a library's
 * branding in a consumer's app. Each `TileSource` still contributes its own
 * `attribution` — that is a licence obligation and is rendered regardless.
 */
const NO_CUSTOM_ATTRIBUTION: readonly string[] = Object.freeze([]);

export class MapControllerDestroyedError extends Error {
  constructor(operation: string) {
    super(`map controller: ${operation} was called after destroy()`);
    this.name = "MapControllerDestroyedError";
  }
}

/** The part of `MapController` T4.1 delivers. Widened by T4.2 (terrain) and T4.3 (track). */
export interface MapSourceController {
  setSources(sources: TileSource[]): void;
  destroy(): void;
}

export interface MapControllerOptions {
  container: HTMLElement;
  /** Ordered base → overlays. Draw order is this order. */
  sources: TileSource[];
  style?: string | JSONValue;
  center?: LatLng;
  zoom?: number;
  /** Engine-owned and neutral; never a library default. (ADR-0008) */
  attributionPrefix?: string;
}

export function createMapControllerInternal(
  options: MapControllerOptions,
  environment: MapEnvironment,
): MapSourceController {
  const map: MapLike = environment.createMap({
    container: options.container,
    style: options.style ?? EMPTY_STYLE,
    ...(options.center === undefined
      ? {}
      : { center: [options.center.lng, options.center.lat] as [number, number] }),
    ...(options.zoom === undefined ? {} : { zoom: options.zoom }),
    attributionControl: {
      customAttribution:
        options.attributionPrefix === undefined
          ? [...NO_CUSTOM_ATTRIBUTION]
          : [options.attributionPrefix],
    },
  });

  /** What the map should show. The latest call wins, whether or not it has been applied. */
  let desired: readonly TileSource[] = options.sources;
  /** What the map does show, so teardown removes exactly what was added. */
  let installed: BuiltTileSource[] = [];
  let loaded = false;
  let destroyed = false;

  function install(): void {
    // Translate first. `buildTileSources` validates, so an unrenderable stack throws before
    // a single source is removed — a rejected `setSources` leaves the visible map intact
    // rather than half torn down.
    const built = buildTileSources(desired);

    // Before adding, and only when something actually needs it: a consumer with no PMTiles
    // source never constructs a Protocol and never touches the MapLibre global.
    if (desired.some(usesPmtiles)) ensurePmtilesProtocol(environment.protocolRegistrar);

    // Layers before sources, in that order. MapLibre refuses to remove a source that a
    // layer still references, and the reverse order would leave the map with layers
    // pointing at nothing.
    for (const entry of installed) for (const layer of entry.layers) map.removeLayer(layer.id);
    for (const entry of installed) map.removeSource(entry.id);
    installed = [];

    // Declared order, because MapLibre draws layers in the order they are added: the stack
    // a consumer describes is the stack they get.
    for (const entry of built) {
      map.addSource(entry.id, entry.source);
      for (const layer of entry.layers) map.addLayer(layer);
      installed.push(entry);
    }
  }

  function onLoad(): void {
    // Once. `desired` is read here rather than captured anywhere earlier, so whatever the
    // consumer last asked for is what gets installed.
    if (loaded || destroyed) return;
    loaded = true;
    install();
  }

  map.on("load", onLoad);

  return {
    setSources(sources: TileSource[]): void {
      if (destroyed) throw new MapControllerDestroyedError("setSources");
      desired = sources;
      if (loaded) install();
    },

    destroy(): void {
      // Idempotent, and deliberately silent about the PMTiles protocol: `addProtocol`
      // installs on the MapLibre runtime rather than on this map, so unregistering it would
      // break every other controller in the realm. (ADR-0023, and the T4.1b bootstrap.)
      if (destroyed) return;
      destroyed = true;
      map.off("load", onLoad);
      installed = [];
      map.remove();
    },
  };
}
