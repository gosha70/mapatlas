// SPDX-License-Identifier: Apache-2.0

import { Map as MapLibreMap, Marker, addProtocol } from "maplibre-gl";
import type {
  GeoJSONSource,
  LayerSpecification,
  MapMouseEvent,
  StyleSpecification,
} from "maplibre-gl";
import { Protocol } from "pmtiles";

import type { EngineFeatureCollection } from "./engine-layers.js";
import type {
  MapConstructorOptions,
  MapEnvironment,
  MapLike,
  MarkerHandle,
  MarkerOptions,
} from "./environment.js";
import type { MapControllerCore, MapControllerOptions } from "./controller.js";
import { createMapControllerInternal } from "./controller.js";

/**
 * The real MapLibre runtime, wired to the controller's seam.
 *
 * This module is the only one in the package that imports `maplibre-gl` and `pmtiles` as
 * **values**; everything else takes types, which erase. That is what keeps the builders and
 * the controller's own logic testable in Node with no DOM and no WebGL.
 *
 * `createMap` returns an adapter rather than the `Map` itself. Most of `MapLike` is a subset
 * of MapLibre's own surface, but `setSourceData` is not: MapLibre spells it
 * `getSource(id).setData(...)`, and a seam shaped around a two-step lookup would push a cast
 * into every caller. The seam says what the engine needs; the adapter says how MapLibre
 * provides it.
 */
/**
 * Which real map is behind each adapter.
 *
 * A marker has to be added *to a map*, and the adapter deliberately does not expose the one
 * it wraps — a seam that leaked its implementation would let anything reach past it. The
 * environment builds both, so it is the one place entitled to know the pairing, and a
 * WeakMap keeps it from holding a destroyed map alive.
 */
const backing = new WeakMap<MapLike, MapLibreMap>();

function adapt(map: MapLibreMap): MapLike {
  const adapter: MapLike = {
    // MapLibre's own event union is far wider than the seam, and its listener types are
    // invariant across it, so the bridge casts once here rather than at every call site.
    on: (type, listener) => {
      map.on(type as "click", listener as unknown as (event: MapMouseEvent) => void);
    },
    off: (type, listener) => {
      map.off(type as "click", listener as unknown as (event: MapMouseEvent) => void);
    },
    queryRenderedFeatures: (point, layerIds) =>
      map
        .queryRenderedFeatures([point.x, point.y], { layers: [...layerIds] })
        .map((feature) => ({ properties: feature.properties })),
    dragPan: map.dragPan,
    addSource: (id, source) => {
      map.addSource(id, source);
    },
    removeSource: (id) => {
      map.removeSource(id);
    },
    addLayer: (layer: LayerSpecification, beforeId?: string) => {
      map.addLayer(layer, beforeId);
    },
    removeLayer: (id) => {
      map.removeLayer(id);
    },
    getLayer: (id) => map.getLayer(id),
    setSourceData: (id: string, data: EngineFeatureCollection) => {
      const source = map.getSource(id) as GeoJSONSource | undefined;
      if (source === undefined) {
        // Engine sources are installed before anything writes to them, so this is a bug in
        // the controller. Swallowing it would produce a map with no track and no error —
        // the failure mode this whole seam exists to make impossible.
        throw new Error(`map controller: no source "${id}" to write to`);
      }
      source.setData(data as unknown as Parameters<GeoJSONSource["setData"]>[0]);
    },
    setTerrain: (terrain) => {
      map.setTerrain(terrain);
    },
    getTerrain: () => map.getTerrain(),
    fitBounds: ([west, south, east, north], paddingPx) => {
      map.fitBounds(
        [
          [west, south],
          [east, north],
        ],
        { padding: paddingPx, animate: false },
      );
    },
    jumpTo: (camera) => {
      map.jumpTo(camera.zoom === undefined ? { center: camera.center } : camera);
    },
    remove: () => {
      map.remove();
    },
  };
  backing.set(adapter, map);
  return adapter;
}

export function createBrowserMapEnvironment(): MapEnvironment {
  return {
    createMap(options: MapConstructorOptions): MapLike {
      return adapt(
        new MapLibreMap({
          container: options.container,
          style: options.style as StyleSpecification | string,
          ...(options.center === undefined ? {} : { center: options.center }),
          ...(options.zoom === undefined ? {} : { zoom: options.zoom }),
          attributionControl: options.attributionControl,
        }),
      );
    },

    createMarker(element: HTMLElement, options: MarkerOptions): MarkerHandle {
      // `anchor` has to reach MapLibre's constructor: without it every mark is centred on
      // its coordinate, so a pin sits half above the place it points at.
      const marker = new Marker({ element, anchor: options.anchor });
      return {
        setLngLat: (lng, lat) => {
          marker.setLngLat([lng, lat]);
        },
        addTo: (map) => {
          const underlying = backing.get(map);
          if (underlying !== undefined) marker.addTo(underlying);
        },
        remove: () => {
          marker.remove();
        },
      };
    },

    document: globalThis.document,

    protocolRegistrar: {
      addProtocol(scheme: string, handler: unknown): void {
        addProtocol(scheme, handler as Parameters<typeof addProtocol>[1]);
      },
      createProtocol(): { tile: unknown } {
        return new Protocol();
      },
    },
  };
}

/** Mount a MapLibre GL map over the real runtime. */
export function createMapController(options: MapControllerOptions): MapControllerCore {
  return createMapControllerInternal(options, createBrowserMapEnvironment());
}
