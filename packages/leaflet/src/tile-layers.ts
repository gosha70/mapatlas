// SPDX-License-Identifier: Apache-2.0

/**
 * Build a Leaflet layer for each {@link TileSource} kind (api.md §5).
 *
 * `xyz` and `wms` are handled directly. `pmtiles` rendering is provided by
 * `@mapatlas/leaflet`'s offline layer (registered via
 * {@link setPmtilesRasterFactory}) so the renderer core stays free of the
 * PMTiles dependency until offline regions are used (Phase 6).
 */
import L from "leaflet";
import type { TileSource } from "@mapatlas/core";

export type PmtilesRasterFactory = (source: TileSource) => L.Layer;

let pmtilesFactory: PmtilesRasterFactory | undefined;

/** Register the factory that turns a `pmtiles` {@link TileSource} into a layer. */
export function setPmtilesRasterFactory(
  factory: PmtilesRasterFactory | undefined,
): void {
  pmtilesFactory = factory;
}

/** Common Leaflet layer options derived from a source, omitting absent fields. */
function commonOptions(source: TileSource): L.TileLayerOptions {
  const opts: L.TileLayerOptions = { attribution: source.attribution };
  if (source.opacity !== undefined) opts.opacity = source.opacity;
  if (source.minZoom !== undefined) opts.minZoom = source.minZoom;
  if (source.maxZoom !== undefined) opts.maxZoom = source.maxZoom;
  return opts;
}

/**
 * Turn one {@link TileSource} into a Leaflet layer, or `undefined` if it cannot
 * be rendered (e.g. a `pmtiles` source with no factory registered).
 */
export function buildLayer(source: TileSource): L.Layer | undefined {
  switch (source.kind) {
    case "xyz":
      return L.tileLayer(source.url, commonOptions(source));
    case "wms":
      return L.tileLayer.wms(source.url, commonOptions(source));
    case "pmtiles":
      if (!pmtilesFactory) {
        console.warn(
          `@mapatlas/leaflet: no PMTiles factory registered; source "${source.id}" not rendered. Import @mapatlas/leaflet's offline support.`,
        );
        return undefined;
      }
      return pmtilesFactory(source);
    default: {
      const never: never = source.kind;
      throw new Error(`Unknown TileSource kind: ${String(never)}`);
    }
  }
}
