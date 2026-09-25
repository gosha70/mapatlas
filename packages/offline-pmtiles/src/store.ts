// SPDX-License-Identifier: Apache-2.0

/**
 * A PMTiles-backed {@link OfflineRegionStore} (specs/api.md §5). It downloads
 * every tile covering a bbox × zoom range from a {@link TileByteSource} into a
 * {@link TileCache}, so the region renders with the network disabled. Both the
 * source and the cache are seams: production wires a PMTiles archive + an
 * IndexedDB-backed cache, tests wire fakes.
 */
import {
  newId,
  type Id,
  type OfflineRegion,
  type OfflineRegionStore,
} from "@mapatlas/core";
import { PMTiles } from "pmtiles";
import { tilesForRegion, type TileCoord } from "./tiles";

/** Persistence for downloaded tile bytes and region metadata. */
export interface TileCache {
  put(key: string, bytes: ArrayBuffer): Promise<void>;
  get(key: string): Promise<ArrayBuffer | undefined>;
  delete(key: string): Promise<void>;
  /** All keys beginning with `prefix` (for delete-by-region and listing). */
  keys(prefix: string): Promise<string[]>;
}

/** Yields raw tile bytes for (z, x, y) while online. */
export interface TileByteSource {
  getTile(z: number, x: number, y: number): Promise<ArrayBuffer | undefined>;
}

/** A {@link TileByteSource} reading a raster PMTiles archive by (z, x, y). */
export function pmtilesTileByteSource(url: string): TileByteSource {
  const archive = new PMTiles(url);
  return {
    async getTile(z, x, y) {
      const tile = await archive.getZxy(z, x, y);
      return tile?.data;
    },
  };
}

/** A simple in-memory {@link TileCache} (a fake for tests / ephemeral use). */
export function createMemoryTileCache(): TileCache {
  const store = new Map<string, ArrayBuffer>();
  return {
    put(key, bytes) {
      store.set(key, bytes);
      return Promise.resolve();
    },
    get(key) {
      return Promise.resolve(store.get(key));
    },
    delete(key) {
      store.delete(key);
      return Promise.resolve();
    },
    keys(prefix) {
      return Promise.resolve(
        [...store.keys()].filter((k) => k.startsWith(prefix)),
      );
    },
  };
}

/**
 * The concrete store adds `readTile` — the offline read path a renderer uses to
 * serve a downloaded region's tiles from the cache (see
 * `@mapatlas/maplibre`'s `createOfflineTileLayer`).
 */
export interface PMTilesOfflineRegionStore extends OfflineRegionStore {
  readTile(
    regionId: Id,
    z: number,
    x: number,
    y: number,
  ): Promise<ArrayBuffer | undefined>;
}

export interface PMTilesOfflineOptions {
  source: TileByteSource;
  cache: TileCache;
  /** Estimated bytes per tile, used by `estimateSize`. */
  avgTileBytes?: number;
  /** Injectable clock (defaults to `Date.now`) for deterministic tests. */
  now?: () => number;
}

const META_PREFIX = "region:meta:";
const DEFAULT_AVG_TILE_BYTES = 15_000;

const metaKey = (id: Id): string => `${META_PREFIX}${id}`;
const tileKey = (id: Id, t: TileCoord): string =>
  `region:tile:${id}:${t.z}/${t.x}/${t.y}`;

function encodeMeta(region: OfflineRegion): ArrayBuffer {
  const bytes = new TextEncoder().encode(JSON.stringify(region));
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  );
}
function decodeMeta(bytes: ArrayBuffer): OfflineRegion {
  return JSON.parse(new TextDecoder().decode(bytes)) as OfflineRegion;
}

export function createPMTilesOfflineRegionStore(
  opts: PMTilesOfflineOptions,
): PMTilesOfflineRegionStore {
  const { source, cache } = opts;
  const avgTileBytes = opts.avgTileBytes ?? DEFAULT_AVG_TILE_BYTES;
  const now = opts.now ?? (() => Date.now());

  return {
    async download(region, onProgress) {
      const id = newId();
      const tiles = tilesForRegion(region.bbox, region.minZoom, region.maxZoom);
      let sizeBytes = 0;
      for (let i = 0; i < tiles.length; i++) {
        const t = tiles[i]!;
        const data = await source.getTile(t.z, t.x, t.y);
        if (data) {
          await cache.put(tileKey(id, t), data);
          sizeBytes += data.byteLength;
        }
        onProgress?.((i + 1) / tiles.length);
      }
      const meta: OfflineRegion = {
        ...region,
        id,
        sizeBytes,
        downloadedAt: now(),
      };
      await cache.put(metaKey(id), encodeMeta(meta));
      return meta;
    },

    async list() {
      const keys = await cache.keys(META_PREFIX);
      const regions: OfflineRegion[] = [];
      for (const key of keys) {
        const bytes = await cache.get(key);
        if (bytes) regions.push(decodeMeta(bytes));
      }
      return regions;
    },

    async delete(id) {
      const tileKeys = await cache.keys(`region:tile:${id}:`);
      for (const key of tileKeys) await cache.delete(key);
      await cache.delete(metaKey(id));
    },

    estimateSize(region) {
      const n = tilesForRegion(
        region.bbox,
        region.minZoom,
        region.maxZoom,
      ).length;
      return Promise.resolve(n * avgTileBytes);
    },

    readTile(regionId, z, x, y) {
      return cache.get(tileKey(regionId, { z, x, y }));
    },
  };
}
