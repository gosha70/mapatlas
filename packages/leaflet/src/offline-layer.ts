// SPDX-License-Identifier: Apache-2.0

/**
 * A Leaflet raster layer that serves tiles from a local reader instead of the
 * network — the render side of an offline map region. It is decoupled from any
 * particular store: pass a `read(z, x, y)` function (e.g. a PMTiles
 * OfflineRegionStore's `readTile` bound to a region). When the reader has no
 * bytes for a tile, the tile is simply blank, so this works with the network
 * disabled.
 */
import * as L from "leaflet";

export type TileReader = (
  z: number,
  x: number,
  y: number,
) => Promise<ArrayBuffer | undefined>;

export interface OfflineTileLayerOptions {
  attribution?: string;
  /** MIME type of the stored tiles (default `image/png`). */
  mime?: string;
  minZoom?: number;
  maxZoom?: number;
  opacity?: number;
}

class OfflineTileLayer extends L.GridLayer {
  readonly #read: TileReader;
  readonly #mime: string;

  constructor(read: TileReader, options: L.GridLayerOptions, mime: string) {
    super(options);
    this.#read = read;
    this.#mime = mime;
  }

  protected override createTile(
    coords: L.Coords,
    done: L.DoneCallback,
  ): HTMLElement {
    const img = document.createElement("img");
    img.setAttribute("role", "presentation");
    img.alt = "";
    this.#read(coords.z, coords.x, coords.y)
      .then((bytes) => {
        if (!bytes) {
          done(undefined, img);
          return;
        }
        const blob = new Blob([bytes], { type: this.#mime });
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

export function createOfflineTileLayer(
  read: TileReader,
  options: OfflineTileLayerOptions = {},
): L.GridLayer {
  const gridOptions: L.GridLayerOptions = {};
  if (options.attribution !== undefined)
    gridOptions.attribution = options.attribution;
  if (options.minZoom !== undefined) gridOptions.minZoom = options.minZoom;
  if (options.maxZoom !== undefined) gridOptions.maxZoom = options.maxZoom;
  if (options.opacity !== undefined) gridOptions.opacity = options.opacity;
  return new OfflineTileLayer(read, gridOptions, options.mime ?? "image/png");
}
