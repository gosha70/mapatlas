// SPDX-License-Identifier: Apache-2.0

import { Map as MapLibreMap, addProtocol } from "maplibre-gl";
import type { StyleSpecification } from "maplibre-gl";
import { Protocol } from "pmtiles";

import type { MapConstructorOptions, MapEnvironment, MapLike } from "./environment.js";
import type { MapControllerCore, MapControllerOptions } from "./controller.js";
import { createMapControllerInternal } from "./controller.js";

/**
 * The real MapLibre runtime, wired to the controller's seam.
 *
 * This module is the only one in the package that imports `maplibre-gl` and `pmtiles` as
 * **values**; everything else takes types, which erase. That is what keeps the builders and
 * the controller's own logic testable in Node with no DOM and no WebGL.
 */
export function createBrowserMapEnvironment(): MapEnvironment {
  return {
    createMap(options: MapConstructorOptions): MapLike {
      return new MapLibreMap({
        container: options.container,
        style: options.style as StyleSpecification | string,
        ...(options.center === undefined ? {} : { center: options.center }),
        ...(options.zoom === undefined ? {} : { zoom: options.zoom }),
        attributionControl: options.attributionControl,
      });
    },

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
