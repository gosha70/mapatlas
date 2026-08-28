// SPDX-License-Identifier: Apache-2.0

/**
 * `@mapatlas/maplibre` — the MapLibre GL renderer.
 *
 * The translation from engine types to MapLibre style objects is **pure**: a `TileSource`
 * becomes a source descriptor and a `Track` becomes GeoJSON whether or not a map exists,
 * a browser exists, or a PMTiles protocol has been registered. Runtime capability lives at
 * the controller boundary, which is where its lifecycle is.
 */

export type { BuiltTileSource } from "./builders/tile-source.js";
export {
  PMTILES_SCHEME,
  TileSourceError,
  buildTileSource,
  buildTileSources,
  resolveRole,
  usesPmtiles,
} from "./builders/tile-source.js";

export type {
  FeatureCollection,
  LineStringFeature,
  PointFeature,
  Position2D,
} from "./builders/track-geojson.js";
export {
  buildLapFeatures,
  buildTrackEndpointFeatures,
  buildTrackLineFeatures,
  segmentGeometry,
} from "./builders/track-geojson.js";

/** Package identity, so a consumer can report which engine build it embeds. */
export const PACKAGE_NAME = "@mapatlas/maplibre";
