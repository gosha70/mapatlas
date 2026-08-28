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
 *
 * It also **infers nothing**. `kind` says what the tiles contain and `transport` says how to
 * fetch them, so the translation is a lookup on two stated axes rather than a guess about
 * one conflated one. (ADR-0023)
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
   * only `source` and a namespaced `id` filled in — the engine has no opinion about how
   * contours or bathymetry should look, which is the point of the passthrough. (ADR-0011)
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

/**
 * MapLibre reads PMTiles through a protocol handler registered against this scheme, so the
 * archive's location is prefixed with it on the way in.
 *
 * The scheme is **this renderer's**, not the engine's: Leaflet's PMTiles integration
 * constructs `PMTiles(url)` from the plain location and OpenLayers has its own source
 * abstraction, neither of which knows what `pmtiles://` means. A `TileSource` therefore
 * carries the archive location and `transport: "pmtiles"`, and the translation to a
 * MapLibre pseudo-scheme happens here, at the only boundary that owns it. (ADR-0023)
 */
export const PMTILES_SCHEME = "pmtiles://";

/** Separates a source's id from a layer's own id, so two sources cannot collide. */
const LAYER_ID_SEPARATOR = "__";

const DEFAULT_RASTER_TILE_SIZE = 256;
const DEFAULT_DEM_TILE_SIZE = 512;

export function usesPmtiles(source: TileSource): boolean {
  return source.transport === "pmtiles";
}

/**
 * The role a source plays, defaulting the way `api.md` describes: the first source is the
 * base map, everything after it an overlay.
 */
export function resolveRole(source: TileSource, index: number): TileSourceRole {
  return source.role ?? (index === 0 ? "base" : "overlay");
}

function rasterLayer(source: TileSource, role: TileSourceRole): LayerSpecification {
  return {
    id: `${source.id}${LAYER_ID_SEPARATOR}raster`,
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
 * `source` is filled in and **every** id is namespaced — the one the consumer supplied as
 * well as the one they omitted — so two sources carrying a layer called `labels` produce
 * `a__labels` and `b__labels` rather than one silently replacing the other. Nothing else is
 * touched: paint, filter and layout are the consumer's business.
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
    const localId = typeof spec["id"] === "string" ? spec["id"] : `layer-${String(index)}`;
    return {
      ...spec,
      id: `${source.id}${LAYER_ID_SEPARATOR}${localId}`,
      source: source.id,
    } as LayerSpecification;
  });
}

/** MapLibre's own `type`, which is exactly the engine's content kind. */
const SOURCE_TYPE = {
  raster: "raster",
  vector: "vector",
  "raster-dem": "raster-dem",
} as const;

/**
 * How the url reaches MapLibre.
 *
 * `template` and `wms` name individual tiles, so they go in `tiles`; `tilejson` and
 * `pmtiles` name a document or archive that describes the tile set, so they go in `url`.
 * PMTiles is `url` for **all three content kinds** — the protocol handler resolves the
 * archive and serves tiles out of it, so appending `/{z}/{x}/{y}` would ask for a path that
 * does not exist.
 */
function urlFields(source: TileSource): Record<string, unknown> {
  switch (source.transport) {
    case "template":
    case "wms":
      return { tiles: [source.url] };
    case "tilejson":
      return { url: source.url };
    case "pmtiles":
      // The one renderer-specific rewrite in the translation, and the reason it belongs
      // here rather than in the contract.
      return { url: `${PMTILES_SCHEME}${source.url}` };
  }
}

/**
 * Reject the combinations the renderer cannot express, and the urls that would load
 * nothing while reporting nothing.
 */
function validate(source: TileSource): void {
  if (source.attribution.trim() === "") {
    // Attribution is a licence obligation, not decoration: OSM and OpenSeaMap both require
    // it, and a source that cannot state its own is one we must not silently render.
    throw new TileSourceError(source.id, "attribution is required and must not be empty");
  }

  if (source.transport === "wms") {
    if (source.kind !== "raster") {
      // WMS GetMap returns an image. There is no vector or DEM tile behind it to fetch.
      throw new TileSourceError(
        source.id,
        `transport "wms" carries raster tiles, not ${source.kind}`,
      );
    }
    if (!BBOX_PLACEHOLDERS.some((placeholder) => source.url.includes(placeholder))) {
      // Without it every request asks for the same extent, so the map renders one tile's
      // worth of imagery everywhere and looks broken in a way nothing reports.
      throw new TileSourceError(
        source.id,
        `a WMS url must contain a bbox placeholder (${BBOX_PLACEHOLDERS.join(" or ")})`,
      );
    }
  }

  if (source.url.startsWith(PMTILES_SCHEME)) {
    // Under any transport. `transport: "pmtiles"` already says the source is an archive, so
    // a prefixed url is a second representation of the same fact — and it is a MapLibre
    // pseudo-scheme in a renderer-neutral type, which no other renderer can read. Accepting
    // it would also mean guessing whether to prefix again.
    throw new TileSourceError(
      source.id,
      `url must be the archive location; "${PMTILES_SCHEME}" is the renderer's to add`,
    );
  }
}

/**
 * Which layers a source contributes.
 *
 * Raster imagery is the one thing the engine knows how to draw unaided. A vector source is
 * unrenderable without the consumer's layers, so it gets theirs. An elevation source in a
 * terrain role draws nothing at all — `TerrainOptions` points at it, and a hillshade layer
 * is the consumer's to add.
 */
function layersFor(source: TileSource, role: TileSourceRole): LayerSpecification[] {
  switch (source.kind) {
    case "raster":
      return [rasterLayer(source, role)];
    case "vector":
      return consumerLayers(source);
    case "raster-dem":
      return NON_DRAWING_ROLES.has(role) ? [] : consumerLayers(source);
  }
}

/**
 * Two layers cannot share a final id.
 *
 * Namespacing stops one source's `labels` from overwriting another's, but it does not stop a
 * source from supplying `labels` twice, and it does not stop a source called `a__b` carrying
 * `c` from colliding with a source called `a` carrying `b__c`. MapLibre refuses the second
 * `addLayer`, which would surface *after* a replacement had begun tearing the old stack
 * down — so the translation rejects it while nothing has been touched.
 */
function assertUniqueLayerIds(layers: readonly LayerSpecification[], sourceId: string): void {
  const seen = new Set<string>();
  for (const layer of layers) {
    if (seen.has(layer.id)) {
      throw new TileSourceError(sourceId, `two style layers resolve to the id "${layer.id}"`);
    }
    seen.add(layer.id);
  }
}

/** Translate one `TileSource` into the source and layers MapLibre needs. */
export function buildTileSource(source: TileSource, index: number): BuiltTileSource {
  validate(source);

  const role = resolveRole(source, index);
  const bounds = {
    ...(source.minZoom === undefined ? {} : { minzoom: source.minZoom }),
    ...(source.maxZoom === undefined ? {} : { maxzoom: source.maxZoom }),
  };

  const kindFields: Record<string, unknown> =
    source.kind === "raster"
      ? { tileSize: source.tileSize ?? DEFAULT_RASTER_TILE_SIZE }
      : source.kind === "raster-dem"
        ? {
            tileSize: source.tileSize ?? DEFAULT_DEM_TILE_SIZE,
            encoding: source.encoding ?? "mapbox",
          }
        : {};

  const layers = layersFor(source, role);
  assertUniqueLayerIds(layers, source.id);

  return {
    id: source.id,
    role,
    source: {
      type: SOURCE_TYPE[source.kind],
      ...urlFields(source),
      ...kindFields,
      attribution: source.attribution,
      ...bounds,
    } as SourceSpecification,
    layers,
  };
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

  const built = sources.map((source, index) => buildTileSource(source, index));

  // Across the whole stack, not just within a source: namespacing makes a collision
  // unlikely, not impossible — `a__b` carrying `c` and `a` carrying `b__c` both resolve to
  // `a__b__c`.
  const owners = new Map<string, string>();
  for (const entry of built) {
    for (const layer of entry.layers) {
      const owner = owners.get(layer.id);
      if (owner !== undefined) {
        throw new TileSourceError(
          entry.id,
          `layer id "${layer.id}" collides with the one from source "${owner}"`,
        );
      }
      owners.set(layer.id, entry.id);
    }
  }

  return built;
}
