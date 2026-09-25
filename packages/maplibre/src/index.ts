// SPDX-License-Identifier: Apache-2.0

/**
 * MAP-ATLAS MapLibre GL renderer — mounts a MapLibre map, composites an
 * ordered TileSource stack, and renders the live position, track line, and
 * event markers. Framework-agnostic below React: this package imports no
 * React.
 */
export { createMapController } from "./map-controller";
export type { MapController, MapControllerOptions } from "./map-controller";
export { createTileLayer } from "./tile-layers";
export type { MapLibreTileLayer } from "./tile-layers";
export { createOfflineTileLayer } from "./offline-layer";
export type {
  TileReader,
  OfflineTileLayerOptions,
  OfflineTileLayer,
} from "./offline-layer";
