// SPDX-License-Identifier: Apache-2.0

import { Map as MapLibreMap, Marker, addProtocol } from "maplibre-gl";
import type {
  GeoJSONSource,
  LayerSpecification,
  MapMouseEvent,
  StyleSpecification,
} from "maplibre-gl";
import { Protocol } from "pmtiles";
import type { PMTiles } from "pmtiles";

import type { EngineFeatureCollection } from "./engine-layers.js";
import type {
  MapConstructorOptions,
  MapEnvironment,
  MapLike,
  MarkerHandle,
  MarkerOptions,
} from "./environment.js";
import type { MapController, MapControllerOptions } from "./controller.js";
import { createMapControllerInternal } from "./controller.js";
import type { PmtilesProtocol, ProtocolRegistrar } from "../protocols/pmtiles.js";
import { ensurePmtilesProtocol } from "../protocols/pmtiles.js";

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
        // `?? {}` because the seam promises a record and the renderer's type does not: it
        // normalises in practice, and "in practice" is not what the seam says.
        .map((feature) => ({ properties: feature.properties ?? {} })),
    dragPan: map.dragPan,
    project: ([lng, lat]) => map.project([lng, lat]),
    unproject: (point) => map.unproject([point.x, point.y]),
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
    fitBounds: ([west, south, east, north], paddingPx, animate) => {
      map.fitBounds(
        [
          [west, south],
          [east, north],
        ],
        { padding: paddingPx, animate },
      );
    },
    easeTo: (camera) => {
      map.easeTo(camera.zoom === undefined ? { center: camera.center } : camera);
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

    onPointerRelease(listener: () => void): () => void {
      // On the document, so a release outside the map still ends the gesture it started.
      // `touchcancel` stays on the map, where it is genuine: the system taking a touch away
      // is a cancellation, not a release.
      //
      // In the **capture** phase, which is the whole point. A bubble-phase listener sits at
      // the end of the chain, so anything in front of it — the renderer's own handlers, or
      // consumer code on the container — calling `stopPropagation` on a `mouseup` means the
      // release never arrives, the drag never ends, and panning never comes back. That is
      // exactly the failure `mouseout` used to mask, reachable again by another route.
      // Capture runs before anything can suppress it.
      const forward = (): void => {
        listener();
      };
      const options = { capture: true } as const;
      globalThis.document.addEventListener("mouseup", forward, options);
      globalThis.document.addEventListener("touchend", forward, options);
      return () => {
        globalThis.document.removeEventListener("mouseup", forward, options);
        globalThis.document.removeEventListener("touchend", forward, options);
      };
    },

    prefersReducedMotion(): boolean {
      return globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches;
    },

    document: globalThis.document,

    protocolRegistrar: browserProtocolRegistrar,
  };
}

/**
 * The real MapLibre protocol registry, named once because two call sites now need it — the
 * controller's environment and `pmtilesArchiveRegistrar`.
 *
 * Sharing the object changes **nothing** observable, and the comment says so rather than
 * implying otherwise: `ensurePmtilesProtocol` keys "already registered" off its own retained
 * instance, so a fresh literal per call would register exactly once too. What single-instancing
 * buys is one copy of the `addProtocol` cast and the `new Protocol()` call, which is a
 * readability claim, not a correctness one.
 */
const browserProtocolRegistrar: ProtocolRegistrar = {
  addProtocol(scheme: string, handler: unknown): void {
    addProtocol(scheme, handler as Parameters<typeof addProtocol>[1]);
  },
  createProtocol(): PmtilesProtocol {
    return new Protocol();
  },
};

/**
 * Somewhere to register a downloaded PMTiles archive, so MapLibre reads it from local bytes.
 *
 * The realm's one `Protocol`, registered **eagerly** — unlike the controller's own lazy path,
 * which constructs it only when a source stack first needs it. An offline consumer calls this
 * before adding any `pmtiles` source, precisely because at that moment no controller has
 * created a protocol yet and there would be nothing to hand back (ADR-0036).
 *
 * Idempotent, and it returns the instance MapLibre actually resolves through: the realm flag
 * already guarantees a single registration, and a second call returns that same object. An
 * archive added to any other `Protocol` would be consulted by nothing, which fails as a map
 * that silently goes to the network — or, offline, does not render at all.
 *
 * The return type is stated in this package's own vocabulary. It is structurally what
 * `@mapatlas/offline-pmtiles`'s `installOfflineArchives` asks for, and deliberately not that
 * type by name: neither package may depend on the other, and both already depend on `pmtiles`,
 * which is where the `PMTiles` they exchange comes from.
 */
export function pmtilesArchiveRegistrar(): PmtilesArchiveRegistrar {
  return ensurePmtilesProtocol(browserProtocolRegistrar);
}

/** Where a downloaded archive is registered. Satisfied by `pmtiles`'s own `Protocol`. */
export interface PmtilesArchiveRegistrar {
  add(archive: PMTiles): void;
}

/** Mount a MapLibre GL map over the real runtime. */
export function createMapController(options: MapControllerOptions): MapController {
  return createMapControllerInternal(options, createBrowserMapEnvironment());
}
