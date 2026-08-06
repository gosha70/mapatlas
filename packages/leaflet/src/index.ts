// SPDX-License-Identifier: Apache-2.0

/**
 * @mapatlas/leaflet — Leaflet renderer for MAP-ATLAS.
 *
 * Mounts a Leaflet map with a layered {@link TileSource} stack and renders the
 * live position, track polyline, and event markers. Depends on Leaflet and the
 * DOM; never on React (isolation scan enforced).
 */
export const VERSION = "0.1.0";

export type { MapController, MapControllerOptions } from "./map-controller.js";
export { createMapController } from "./map-controller.js";
export {
  buildLayer,
  setPmtilesRasterFactory,
  type PmtilesRasterFactory,
} from "./tile-layers.js";
