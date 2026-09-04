// SPDX-License-Identifier: Apache-2.0

import { newId } from "@mapatlas/core";
import type {
  Id,
  MapAssetStore,
  OfflineRegion,
  OfflineRegionStore,
  TileSource,
} from "@mapatlas/core";

import { assertOfflineLicensed } from "./offline-license.js";

/**
 * A region named a source whose transport this store cannot download (ADR-0034).
 *
 * Refused rather than skipped: a silently omitted source produces a region that *looks*
 * downloaded and is not, which is ADR-0017's failure in the field.
 */
export class UnsupportedTransportError extends Error {
  readonly sourceId: string;
  readonly transport: string;

  constructor(sourceId: string, transport: string) {
    super(
      `tile source ${JSON.stringify(sourceId)} uses transport ${JSON.stringify(transport)}, which ` +
        `this store cannot download. @mapatlas/offline-pmtiles copies whole PMTiles archives; ` +
        `enumerating a template, WMS or TileJSON source is a different task. Refusing rather than ` +
        `skipping, because a silently omitted source is a region that looks downloaded and fails ` +
        `in the field.`,
    );
    this.name = "UnsupportedTransportError";
    this.sourceId = sourceId;
    this.transport = transport;
  }
}

/**
 * The store's own key namespace inside `MapAssetStore` (ADR-0034 item 4).
 *
 * That seam offers only blob get/put/delete/list, so a region's metadata has to live in it as a
 * blob. `MapAssetStore.clear()` consequently wipes manifests along with archives, which is
 * correct under ADR-0016 — map bytes are replaceable and go together — and is recorded so nobody
 * "fixes" it into leaving orphaned manifests behind.
 */
const MANIFEST_PREFIX = "mapatlas/region/";
const ARCHIVE_PREFIX = "mapatlas/archive/";

const manifestKey = (id: Id): string => `${MANIFEST_PREFIX}${id}.json`;
/** Keyed by region *and* source: no cross-region sharing, which is an optimisation, not T6.1. */
const archiveKey = (id: Id, sourceId: string): string => `${ARCHIVE_PREFIX}${id}/${sourceId}`;

/** What `download()` fetches with, injected so the unit lane needs no network. */
export interface RegionFetch {
  bytes(url: string): Promise<Blob>;
  size(url: string): Promise<number>;
}

const systemFetch: RegionFetch = {
  bytes: async (url) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`fetching ${url} failed with ${String(response.status)}`);
    return response.blob();
  },
  size: async (url) => {
    const response = await fetch(url, { method: "HEAD" });
    if (!response.ok) throw new Error(`sizing ${url} failed with ${String(response.status)}`);
    return Number(response.headers.get("content-length") ?? 0);
  },
};

export function createPMTilesRegionStore(options: {
  sources: TileSource[];
  assets: MapAssetStore;
  fetcher?: RegionFetch;
}): OfflineRegionStore {
  const { sources, assets } = options;
  const fetcher = options.fetcher ?? systemFetch;

  /**
   * The sources a region actually covers, refusing anything it may not or cannot download.
   *
   * One function, reached from `download` and `estimateSize` alike (ADR-0033): a UI able to
   * quote a size for a region the store will then refuse has already misled its user.
   */
  const resolve = (sourceIds: readonly string[] | undefined): TileSource[] => {
    // The published default is "all base+overlay", which excludes terrain and hillshade — a
    // defaulted region omits the DEM. Left as specified (ADR-0034); callers needing terrain name
    // their ids.
    const requested =
      sourceIds ??
      sources
        .filter(
          (source) =>
            (source.role ?? "overlay") === "base" || (source.role ?? "overlay") === "overlay",
        )
        .map((source) => source.id);
    assertOfflineLicensed(sources, requested);
    const resolved: TileSource[] = [];
    for (const id of requested) {
      const source = sources.find((candidate) => candidate.id === id);
      // `assertOfflineLicensed` has already refused an unknown id, so this cannot be undefined.
      if (source === undefined) continue;
      if (source.transport !== "pmtiles") {
        throw new UnsupportedTransportError(source.id, source.transport);
      }
      resolved.push(source);
    }
    return resolved;
  };

  const readManifest = async (key: string): Promise<OfflineRegion | undefined> => {
    const blob = await assets.get(key);
    if (blob === undefined) return undefined;
    return JSON.parse(await blob.text()) as OfflineRegion;
  };

  return {
    async download(region, onProgress) {
      const resolved = resolve(region.sourceIds);
      const id = newId();
      let sizeBytes = 0;
      for (const [index, source] of resolved.entries()) {
        // The whole archive, not a tile selection: §5's "cached whole for offline" (ADR-0034).
        const blob = await fetcher.bytes(source.url);
        await assets.put(archiveKey(id, source.id), blob);
        sizeBytes += blob.size;
        onProgress?.((index + 1) / resolved.length);
      }
      const stored: OfflineRegion = {
        ...region,
        id,
        sizeBytes,
        downloadedAt: Date.now(),
      };
      await assets.put(
        manifestKey(id),
        new Blob([JSON.stringify(stored)], { type: "application/json" }),
      );
      return stored;
    },

    async list() {
      const keys = await assets.list();
      const regions: OfflineRegion[] = [];
      for (const key of keys.filter((candidate) => candidate.startsWith(MANIFEST_PREFIX))) {
        const region = await readManifest(key);
        if (region !== undefined) regions.push(region);
      }
      return regions;
    },

    async delete(id) {
      const keys = await assets.list();
      // Every archive this region wrote, then the manifest — so a failure part-way leaves a
      // region whose manifest still names assets that exist, rather than a manifest pointing at
      // nothing.
      for (const key of keys.filter((candidate) => candidate.startsWith(archiveKey(id, "")))) {
        await assets.delete(key);
      }
      await assets.delete(manifestKey(id));
    },

    async estimateSize(region) {
      const resolved = resolve(region.sourceIds);
      let total = 0;
      for (const source of resolved) total += await fetcher.size(source.url);
      return total;
    },
  };
}
