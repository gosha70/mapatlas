// SPDX-License-Identifier: Apache-2.0

/**
 * PMTiles-backed {@link OfflineRegionStore} (tasks T6.1).
 *
 * `download()` walks every slippy tile in a bbox across a zoom range, pulls each
 * tile's bytes from a PMTiles archive (via the `pmtiles` library by default, or
 * an injected fetcher in tests), and caches them locally. A region cached this
 * way renders with the network disabled: {@link createOfflineTileLayer} draws
 * tiles straight from the cache — it never calls `fetch`.
 *
 * Renderer-neutral tile math lives here so a future MapLibre renderer can reuse
 * the same store; only {@link createOfflineTileLayer} is Leaflet-specific.
 */
import L from "leaflet";
import type { Id, OfflineRegion, OfflineRegionStore } from "@mapatlas/core";
import { newId } from "@mapatlas/core";
import { PMTiles } from "pmtiles";

/** A z/x/y tile coordinate. */
export interface TileCoord {
  z: number;
  x: number;
  y: number;
}

/** Local cache of raster tile bytes, partitioned by owning region. */
export interface TileCache {
  get(z: number, x: number, y: number): Uint8Array | undefined;
  put(region: Id, z: number, x: number, y: number, bytes: Uint8Array): void;
  deleteRegion(region: Id): void;
  size(region: Id): number;
}

const key = (z: number, x: number, y: number): string => `${z}/${x}/${y}`;

/** In-memory {@link TileCache} (default). Suitable for tests and the demo. */
export class MemoryTileCache implements TileCache {
  private readonly tiles = new Map<string, Uint8Array>();
  private readonly byRegion = new Map<Id, Set<string>>();

  get(z: number, x: number, y: number): Uint8Array | undefined {
    return this.tiles.get(key(z, x, y));
  }

  put(region: Id, z: number, x: number, y: number, bytes: Uint8Array): void {
    const k = key(z, x, y);
    this.tiles.set(k, bytes);
    let set = this.byRegion.get(region);
    if (!set) {
      set = new Set<string>();
      this.byRegion.set(region, set);
    }
    set.add(k);
  }

  deleteRegion(region: Id): void {
    const set = this.byRegion.get(region);
    if (!set) return;
    for (const k of set) this.tiles.delete(k);
    this.byRegion.delete(region);
  }

  size(region: Id): number {
    const set = this.byRegion.get(region);
    if (!set) return 0;
    let total = 0;
    for (const k of set) total += this.tiles.get(k)?.byteLength ?? 0;
    return total;
  }
}

/* --------------------------- slippy tile math ---------------------------- */

const clampLat = (lat: number): number =>
  Math.max(-85.05112878, Math.min(85.05112878, lat));

export function lonToTileX(lon: number, z: number): number {
  return Math.floor(((lon + 180) / 360) * 2 ** z);
}

export function latToTileY(lat: number, z: number): number {
  const rad = (clampLat(lat) * Math.PI) / 180;
  return Math.floor(
    ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** z,
  );
}

/** Count the tiles a region covers (bbox × zoom range), for size estimates. */
export function countTiles(
  bbox: OfflineRegion["bbox"],
  minZoom: number,
  maxZoom: number,
): number {
  const [w, s, e, n] = bbox;
  let total = 0;
  for (let z = minZoom; z <= maxZoom; z++) {
    const max = 2 ** z - 1;
    const clamp = (v: number): number => Math.max(0, Math.min(max, v));
    const x0 = clamp(lonToTileX(w, z));
    const x1 = clamp(lonToTileX(e, z));
    const y0 = clamp(latToTileY(n, z)); // north → smaller y
    const y1 = clamp(latToTileY(s, z));
    total += (Math.abs(x1 - x0) + 1) * (Math.abs(y1 - y0) + 1);
  }
  return total;
}

/** Enumerate every tile coordinate a region covers. */
export function enumerateTiles(
  bbox: OfflineRegion["bbox"],
  minZoom: number,
  maxZoom: number,
): TileCoord[] {
  const [w, s, e, n] = bbox;
  const out: TileCoord[] = [];
  for (let z = minZoom; z <= maxZoom; z++) {
    const max = 2 ** z - 1;
    const clamp = (v: number): number => Math.max(0, Math.min(max, v));
    const x0 = Math.min(clamp(lonToTileX(w, z)), clamp(lonToTileX(e, z)));
    const x1 = Math.max(clamp(lonToTileX(w, z)), clamp(lonToTileX(e, z)));
    const y0 = Math.min(clamp(latToTileY(n, z)), clamp(latToTileY(s, z)));
    const y1 = Math.max(clamp(latToTileY(n, z)), clamp(latToTileY(s, z)));
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) out.push({ z, x, y });
    }
  }
  return out;
}

/* ----------------------------- the store -------------------------------- */

/** Fetch a single tile's raster bytes, or `undefined` if the archive lacks it. */
export type TileFetcher = (
  z: number,
  x: number,
  y: number,
) => Promise<Uint8Array | undefined>;

export interface PmtilesOfflineRegionStoreOptions {
  /** `.pmtiles` archive location; used by the default PMTiles fetcher. */
  archiveUrl?: string;
  /** Override tile retrieval (tests / custom sources). */
  tileFetcher?: TileFetcher;
  /** Tile cache (default {@link MemoryTileCache}). */
  cache?: TileCache;
  /** Average bytes/tile used by {@link estimateSize} (default 40 KiB). */
  avgTileBytes?: number;
  /** Safety cap on tiles per download (default 250 000). */
  maxTiles?: number;
}

export class PmtilesOfflineRegionStore implements OfflineRegionStore {
  readonly cache: TileCache;
  private readonly regions = new Map<Id, OfflineRegion>();
  private readonly avgTileBytes: number;
  private readonly maxTiles: number;
  private readonly archiveUrl: string | undefined;
  private readonly injectedFetcher: TileFetcher | undefined;
  private pmtiles: PMTiles | undefined;

  constructor(opts: PmtilesOfflineRegionStoreOptions = {}) {
    if (!opts.tileFetcher && !opts.archiveUrl) {
      throw new Error(
        "PmtilesOfflineRegionStore requires an archiveUrl or a tileFetcher.",
      );
    }
    this.cache = opts.cache ?? new MemoryTileCache();
    this.avgTileBytes = opts.avgTileBytes ?? 40 * 1024;
    this.maxTiles = opts.maxTiles ?? 250_000;
    this.archiveUrl = opts.archiveUrl;
    this.injectedFetcher = opts.tileFetcher;
  }

  private async fetchTile(
    z: number,
    x: number,
    y: number,
  ): Promise<Uint8Array | undefined> {
    if (this.injectedFetcher) return this.injectedFetcher(z, x, y);
    if (!this.pmtiles) this.pmtiles = new PMTiles(this.archiveUrl!);
    const tile = await this.pmtiles.getZxy(z, x, y);
    return tile ? new Uint8Array(tile.data) : undefined;
  }

  async download(
    region: Omit<OfflineRegion, "id" | "sizeBytes" | "downloadedAt">,
    onProgress?: (fraction: number) => void,
  ): Promise<OfflineRegion> {
    const tiles = enumerateTiles(region.bbox, region.minZoom, region.maxZoom);
    if (tiles.length > this.maxTiles) {
      throw new Error(
        `Region too large: ${tiles.length} tiles exceeds cap of ${this.maxTiles}.`,
      );
    }
    const id = newId();
    let done = 0;
    let sizeBytes = 0;
    for (const { z, x, y } of tiles) {
      const bytes = await this.fetchTile(z, x, y);
      if (bytes) {
        this.cache.put(id, z, x, y, bytes);
        sizeBytes += bytes.byteLength;
      }
      done += 1;
      onProgress?.(done / tiles.length);
    }
    const stored: OfflineRegion = {
      ...region,
      id,
      sizeBytes,
      downloadedAt: Date.now(),
    };
    this.regions.set(id, stored);
    return stored;
  }

  list(): Promise<OfflineRegion[]> {
    return Promise.resolve([...this.regions.values()]);
  }

  delete(id: Id): Promise<void> {
    this.cache.deleteRegion(id);
    this.regions.delete(id);
    return Promise.resolve();
  }

  estimateSize(
    region: Pick<OfflineRegion, "bbox" | "minZoom" | "maxZoom">,
  ): Promise<number> {
    const n = countTiles(region.bbox, region.minZoom, region.maxZoom);
    return Promise.resolve(n * this.avgTileBytes);
  }
}

/* --------------------------- offline renderer --------------------------- */

// 1×1 transparent PNG for tiles missing from the cache.
const TRANSPARENT_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

/**
 * A Leaflet {@link https://leafletjs.com/reference.html#gridlayer GridLayer}
 * that draws raster tiles from a {@link TileCache} instead of the network — the
 * rendering half of offline support. It calls no `fetch`.
 */
export function createOfflineTileLayer(
  cache: TileCache,
  options?: L.GridLayerOptions,
): L.GridLayer {
  const OfflineGrid = L.GridLayer.extend({
    createTile(
      this: L.GridLayer,
      coords: L.Coords,
      done: L.DoneCallback,
    ): HTMLElement {
      const img = document.createElement("img");
      img.setAttribute("role", "presentation");
      img.alt = "";
      const bytes = cache.get(coords.z, coords.x, coords.y);
      if (bytes) {
        const part = bytes as unknown as BlobPart;
        const url = URL.createObjectURL(
          new Blob([part], { type: "image/png" }),
        );
        img.onload = (): void => {
          URL.revokeObjectURL(url);
          done(undefined, img);
        };
        img.onerror = (): void => {
          URL.revokeObjectURL(url);
          done(new Error("offline tile decode failed"), img);
        };
        img.src = url;
      } else {
        img.src = TRANSPARENT_PNG;
        setTimeout(() => done(undefined, img), 0);
      }
      return img;
    },
  }) as unknown as new (o?: L.GridLayerOptions) => L.GridLayer;
  return new OfflineGrid(options);
}
