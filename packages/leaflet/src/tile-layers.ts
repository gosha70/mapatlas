// SPDX-License-Identifier: Apache-2.0

/**
 * Translate a domain-neutral {@link TileSource} into a Leaflet layer. Three
 * kinds are supported: `xyz` slippy templates, `wms` endpoints, and `pmtiles`
 * single-file raster archives (read via HTTP range requests — the basis for the
 * offline regions in Phase 6). Attribution rides on the layer verbatim so the
 * map's attribution control renders exactly what the source declared.
 */
import * as L from "leaflet";
import { PMTiles } from "pmtiles";
import type { TileSource } from "@mapatlas/core";

function baseOptions(source: TileSource): L.TileLayerOptions {
  const opts: L.TileLayerOptions = { attribution: source.attribution };
  if (source.opacity !== undefined) opts.opacity = source.opacity;
  if (source.minZoom !== undefined) opts.minZoom = source.minZoom;
  if (source.maxZoom !== undefined) opts.maxZoom = source.maxZoom;
  return opts;
}

/** A raster PMTiles layer: each tile is read from the archive by (z, x, y). */
class PMTilesRasterLayer extends L.GridLayer {
  readonly #archive: PMTiles;
  readonly #mime: string;

  constructor(url: string, mime: string, options: L.GridLayerOptions) {
    super(options);
    this.#archive = new PMTiles(url);
    this.#mime = mime;
  }

  protected override createTile(
    coords: L.Coords,
    done: L.DoneCallback,
  ): HTMLElement {
    const img = document.createElement("img");
    img.setAttribute("role", "presentation");
    img.alt = "";
    this.#archive
      .getZxy(coords.z, coords.x, coords.y)
      .then((tile) => {
        if (!tile) {
          done(undefined, img);
          return;
        }
        const blob = new Blob([tile.data], { type: this.#mime });
        img.src = URL.createObjectURL(blob);
        img.addEventListener("load", () => URL.revokeObjectURL(img.src));
        done(undefined, img);
      })
      .catch((err: unknown) => {
        done(err instanceof Error ? err : new Error(String(err)), img);
      });
    return img;
  }
}

/**
 * Build the Leaflet layer for `source`. `pmtiles` sources render raster tiles
 * from the archive at `source.url`; `mime` controls the tile image type.
 */
export function createTileLayer(
  source: TileSource,
  mime = "image/png",
): L.Layer {
  switch (source.kind) {
    case "wms":
      return L.tileLayer.wms(source.url, baseOptions(source));
    case "pmtiles":
      return new PMTilesRasterLayer(source.url, mime, baseOptions(source));
    case "xyz":
    default:
      return L.tileLayer(source.url, baseOptions(source));
  }
}
