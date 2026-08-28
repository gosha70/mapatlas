// SPDX-License-Identifier: Apache-2.0

import type { BBox } from "./geo.js";
import type { Id } from "./ids.js";
import type { JSONValue } from "./json.js";

/**
 * What a source *contains*: image tiles, vector tiles, or an elevation raster whose pixels
 * encode height.
 *
 * Content is orthogonal to transport (ADR-0023). A `.pmtiles` archive holds raster or
 * vector tiles and the container does not say which; a TileJSON document describes either.
 * Conflating the two forces the renderer to guess, and a wrong guess renders nothing with
 * no error to explain it.
 */
export type TileSourceKind = "raster" | "vector" | "raster-dem";

/**
 * How the renderer *fetches* the tiles named by {@link TileSource.url}.
 *
 * - `template` — the url is a tile url template (`.../{z}/{x}/{y}.png`).
 * - `wms` — the url is a WMS GetMap request containing a bbox placeholder.
 * - `tilejson` — the url points at a TileJSON document describing the tile set.
 * - `pmtiles` — the url is the location of a `.pmtiles` archive.
 *
 * A transport names *how the tiles are obtained*, not how one particular renderer obtains
 * them. Adapters translate it: MapLibre reads PMTiles through a protocol it registers
 * against a `pmtiles://` pseudo-scheme, Leaflet's integration constructs a `PMTiles` object
 * from the plain location, OpenLayers has its own source. None of that belongs here — `url`
 * is always the underlying location, and the adapter adds whatever its mechanism needs.
 */
export type TileSourceTransport = "template" | "wms" | "tilejson" | "pmtiles";

export type TileSourceRole = "base" | "overlay" | "terrain" | "hillshade";

/**
 * Any layer the renderer composites: raster, vector, or an elevation raster driving
 * hillshade and 3D terrain.
 *
 * `kind` and `transport` are independent axes — `kind` says what the tiles are, `transport`
 * says how to fetch them — so every combination the renderer can express is stated rather
 * than inferred. (ADR-0023)
 *
 * `styleLayers` is an opaque JSON passthrough, which is how `core` can describe contours or
 * bathymetry **without importing a renderer's style types** — the property that keeps the
 * renderer swappable. (ADR-0011)
 */
export interface TileSource {
  id: string;
  /** What the tiles contain. */
  kind: TileSourceKind;
  /** How to fetch them. */
  transport: TileSourceTransport;
  /**
   * The transport's underlying location or template: a tile url template, a WMS request, a
   * TileJSON url, or a `.pmtiles` archive location. Never a renderer-specific scheme.
   */
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
