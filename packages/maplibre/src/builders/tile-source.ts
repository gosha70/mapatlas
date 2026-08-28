// SPDX-License-Identifier: Apache-2.0

import type { TileSource, TileSourceRole } from "@mapatlas/core";
import type { LayerSpecification, SourceSpecification } from "maplibre-gl";

/**
 * `TileSource` → MapLibre sources and layers.
 *
 * A deterministic translation over data, with **no side effects at all**. Whether a PMTiles
 * protocol has been registered, whether a map exists, whether anything will ever render —
 * none of it changes what this returns. That is what makes it testable without a browser,
 * and what keeps the runtime capability at the controller boundary where its lifecycle is.
 */

/** What the renderer needs to add one `TileSource` to a style. */
export interface BuiltTileSource {
  id: string;
  source: SourceSpecification;
  /**
   * Layers to add for this source, in order.
   *
   * For a raster source this is the one raster layer the engine generates. For a vector or
   * elevation source it is the consumer's own `styleLayers`, passed through verbatim with
   * only `source` filled in — the engine has no opinion about how contours or bathymetry
   * should look, which is the point of the passthrough. (ADR-0011)
   */
  layers: LayerSpecification[];
  role: TileSourceRole;
}

/** A source that carries no drawable layers of its own — terrain and hillshade inputs. */
const NON_DRAWING_ROLES: ReadonlySet<TileSourceRole> = new Set<TileSourceRole>(["terrain"]);

export class TileSourceError extends Error {
  readonly sourceId: string;

  constructor(sourceId: string, detail: string) {
    super(`tile source "${sourceId}": ${detail}`);
    this.name = "TileSourceError";
    this.sourceId = sourceId;
  }
}

/** A WMS endpoint MapLibre can actually request tiles from needs a bbox placeholder. */
const BBOX_PLACEHOLDERS = ["{bbox-epsg-3857}"];

/** MapLibre reads `pmtiles://` through a registered protocol handler, not over HTTP. */
export const PMTILES_SCHEME = "pmtiles://";

export function usesPmtiles(source: TileSource): boolean {
  return source.kind === "pmtiles" || source.url.startsWith(PMTILES_SCHEME);
}

/**
 * The role a source plays, defaulting the way `api.md` describes: the first source is the
 * base map, everything after it an overlay.
 */
export function resolveRole(source: TileSource, index: number): TileSourceRole {
  return source.role ?? (index === 0 ? "base" : "overlay");
}

/**
 * PMTiles is a *transport*, not a content type: an archive holds either raster or vector
 * tiles, and `kind: "pmtiles"` alone does not say which.
 *
 * Presence of `styleLayers` decides it, because vector tiles are unrenderable without
 * layers to style them and raster tiles need none. See the note in the T4.1 task: this
 * inference exists because the contract conflates transport with content, and it is the
 * one place in the builders that guesses.
 */
function pmtilesIsVector(source: TileSource): boolean {
  return (source.styleLayers?.length ?? 0) > 0;
}

function rasterLayer(source: TileSource, role: TileSourceRole): LayerSpecification {
  return {
    id: `${source.id}__raster`,
    type: "raster",
    source: source.id,
    ...(source.minZoom === undefined ? {} : { minzoom: source.minZoom }),
    ...(source.maxZoom === undefined ? {} : { maxzoom: source.maxZoom }),
    paint: {
      "raster-opacity": source.opacity ?? 1,
      // A hillshade input rendered as flat imagery would bury the map under grey; it is
      // consumed by a hillshade layer instead, which the consumer supplies via styleLayers.
      ...(role === "hillshade" ? { "raster-opacity": 0 } : {}),
    },
  } as LayerSpecification;
}

/**
 * Consumer style layers, bound to this source.
 *
 * `source` is filled in and `id` is namespaced so two sources carrying similarly-named
 * layers cannot collide, but nothing else is touched: paint, filter and layout are the
 * consumer's business.
 */
function consumerLayers(source: TileSource): LayerSpecification[] {
  return (source.styleLayers ?? []).map((layer, index) => {
    if (typeof layer !== "object" || layer === null || Array.isArray(layer)) {
      throw new TileSourceError(source.id, `styleLayers[${index}] is not an object`);
    }
    const spec = layer as Record<string, unknown>;
    if (typeof spec["type"] !== "string") {
      throw new TileSourceError(source.id, `styleLayers[${index}] has no "type"`);
    }
    return {
      ...spec,
      id: typeof spec["id"] === "string" ? spec["id"] : `${source.id}__layer-${String(index)}`,
      source: source.id,
    } as LayerSpecification;
  });
}

/** Translate one `TileSource` into the source and layers MapLibre needs. */
export function buildTileSource(source: TileSource, index: number): BuiltTileSource {
  const role = resolveRole(source, index);
  const attribution = source.attribution;

  if (attribution.trim() === "") {
    // Attribution is a licence obligation, not decoration: OSM and OpenSeaMap both require
    // it, and a source that cannot state its own is one we must not silently render.
    throw new TileSourceError(source.id, "attribution is required and must not be empty");
  }

  const bounds = {
    ...(source.minZoom === undefined ? {} : { minzoom: source.minZoom }),
    ...(source.maxZoom === undefined ? {} : { maxzoom: source.maxZoom }),
  };

  switch (source.kind) {
    case "xyz":
      return {
        id: source.id,
        role,
        source: {
          type: "raster",
          tiles: [source.url],
          tileSize: source.tileSize ?? 256,
          attribution,
          ...bounds,
        } as SourceSpecification,
        layers: [rasterLayer(source, role)],
      };

    case "wms": {
      if (!BBOX_PLACEHOLDERS.some((placeholder) => source.url.includes(placeholder))) {
        // Without it every request asks for the same extent, so the map renders one tile's
        // worth of imagery everywhere and looks broken in a way nothing reports.
        throw new TileSourceError(
          source.id,
          `a WMS url must contain a bbox placeholder (${BBOX_PLACEHOLDERS.join(" or ")})`,
        );
      }
      return {
        id: source.id,
        role,
        source: {
          type: "raster",
          tiles: [source.url],
          tileSize: source.tileSize ?? 256,
          attribution,
          ...bounds,
        } as SourceSpecification,
        layers: [rasterLayer(source, role)],
      };
    }

    case "vector":
      return {
        id: source.id,
        role,
        source: {
          type: "vector",
          url: source.url,
          attribution,
          ...bounds,
        } as SourceSpecification,
        layers: consumerLayers(source),
      };

    case "raster-dem":
      return {
        id: source.id,
        role,
        source: {
          type: "raster-dem",
          url: source.url,
          tileSize: source.tileSize ?? 512,
          encoding: source.encoding ?? "mapbox",
          attribution,
          ...bounds,
        } as SourceSpecification,
        // A terrain source draws nothing itself; `TerrainOptions` points at it and the
        // consumer adds a hillshade layer if they want one visible.
        layers: NON_DRAWING_ROLES.has(role) ? [] : consumerLayers(source),
      };

    case "pmtiles": {
      const vector = pmtilesIsVector(source);
      return {
        id: source.id,
        role,
        source: (vector
          ? { type: "vector", url: source.url, attribution, ...bounds }
          : {
              type: "raster",
              tiles: [`${source.url}/{z}/{x}/{y}`],
              tileSize: source.tileSize ?? 256,
              attribution,
              ...bounds,
            }) as SourceSpecification,
        layers: vector ? consumerLayers(source) : [rasterLayer(source, role)],
      };
    }
  }
}

/**
 * Translate an ordered stack, preserving that order.
 *
 * Order is the contract — base first, then overlays — and MapLibre draws layers in the
 * order they are added, so the stack a consumer describes is the stack they get.
 */
export function buildTileSources(sources: readonly TileSource[]): BuiltTileSource[] {
  const seen = new Set<string>();
  for (const source of sources) {
    if (seen.has(source.id)) {
      throw new TileSourceError(source.id, "two sources share this id");
    }
    seen.add(source.id);
  }
  return sources.map((source, index) => buildTileSource(source, index));
}
