// SPDX-License-Identifier: Apache-2.0

import type { BBox } from "./geo.js";
import type { Id } from "./ids.js";
import type { JSONValue } from "./json.js";

export type TileSourceKind = "xyz" | "wms" | "pmtiles" | "vector" | "raster-dem";
export type TileSourceRole = "base" | "overlay" | "terrain" | "hillshade";

/**
 * Any layer the renderer composites: raster, vector, or an elevation raster driving
 * hillshade and 3D terrain.
 *
 * `styleLayers` is an opaque JSON passthrough, which is how `core` can describe contours or
 * bathymetry **without importing a renderer's style types** — the property that keeps the
 * renderer swappable. (ADR-0011)
 */
export interface TileSource {
  id: string;
  kind: TileSourceKind;
  /** Template, WMS endpoint, style URL, or .pmtiles location. */
  url: string;
  /** Rendered verbatim. License compliance is not optional. */
  attribution: string;
  role?: TileSourceRole;
  opacity?: number;
  minZoom?: number;
  maxZoom?: number;
  tileSize?: number;
  /** `raster-dem` only. */
  encoding?: "mapbox" | "terrarium";
  /** Renderer style layers applied to this source, verbatim. Opaque to `core`. */
  styleLayers?: JSONValue[];
}

export interface TerrainOptions {
  /** Id of a {@link TileSource} with kind `raster-dem`. */
  sourceId: string;
  exaggeration?: number;
}

export interface OfflineRegion {
  id: Id;
  name: string;
  bbox: BBox;
  minZoom: number;
  maxZoom: number;
  /** Which sources this region covers. Defaults to every base and overlay source. */
  sourceIds?: string[];
  sizeBytes?: number;
  downloadedAt?: number;
}

/**
 * Download, list and delete map regions for offline use.
 *
 * **`download()` copies bytes into a {@link MapAssetStore}** and resolves from local storage
 * thereafter. A `.pmtiles` URL served by range requests is *remote* PMTiles, not an offline
 * region: a region that still needs the network to draw has not been downloaded. It must
 * also honor the source's terms — region download must never run against a community tile
 * service. (ADR-0017)
 */
export interface OfflineRegionStore {
  download(
    region: Omit<OfflineRegion, "id" | "sizeBytes" | "downloadedAt">,
    onProgress?: (fraction: number) => void,
  ): Promise<OfflineRegion>;
  list(): Promise<OfflineRegion[]>;
  delete(id: Id): Promise<void>;
  estimateSize(
    region: Pick<OfflineRegion, "bbox" | "minZoom" | "maxZoom" | "sourceIds">,
  ): Promise<number>;
}
