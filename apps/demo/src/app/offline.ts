// SPDX-License-Identifier: Apache-2.0

/**
 * The demo's offline regions — T7.1 increment 5.
 *
 * **Assembled only from package entry points**, like the rest of the app:
 * `createPMTilesRegionStore` and `installOfflineArchives` from `@mapatlas/offline-pmtiles`,
 * `pmtilesArchiveRegistrar` from `@mapatlas/maplibre`, `createIdbMapAssetStore` from
 * `@mapatlas/storage-idb`.
 *
 * **Map bytes live in `MapAssetStore`, never with the trips** (ADR-0016). An archive is large,
 * replaceable and the right thing to discard under pressure; a trip and its photos are none of
 * those. They are separate databases so that clearing one cannot reach the other.
 *
 * **The archives must be installed before any `pmtiles` source is added** (ADR-0036). The
 * renderer registers its protocol lazily, so before a source stack exists there is no registrar
 * to hand back — and an archive installed after MapLibre has already asked for a tile from that
 * url is not retroactively served. That ordering is the whole reason this runs ahead of the map
 * rather than beside it.
 */

import type { MapAssetStore, OfflineRegion, TileSource } from "@mapatlas/core";
import { pmtilesArchiveRegistrar } from "@mapatlas/maplibre";
import { createPMTilesRegionStore, installOfflineArchives } from "@mapatlas/offline-pmtiles";
import { createIdbMapAssetStore } from "@mapatlas/storage-idb";

import { DEMO_REGION } from "./sources.js";

/**
 * What the demo can say about its offline state, for a person and for a test.
 *
 * **Every field here is about persistent storage, and none is about this realm.** An earlier
 * version reported `served` — the ids `installOfflineArchives` returned — and cleared it on
 * delete, which said "this document no longer serves those archives". That is false: the PMTiles
 * registrations survive until the document is replaced, cached data may still answer, and only an
 * *uncached* read fails. A scenario reading `served: []` would have passed while the realm was
 * still answering from cache — the right assertion against the wrong fact.
 *
 * The realm's own state is deliberately not modelled: nothing in this demo consumes it, and a
 * field nobody reads is a claim nobody checks. What a reload resets is said in words, next to the
 * button that makes it necessary.
 */
export interface OfflineStatus {
  /** How many regions the store holds. */
  readonly regions: number;
  /** The source ids the **stored regions name**. Empty once they are deleted, which is true. */
  readonly storedSourceIds: readonly string[];
  /** Bytes the manifests record, or 0 when there is no region. */
  readonly bytes: number;
}

export interface DemoOffline {
  readonly store: ReturnType<typeof createPMTilesRegionStore>;
  readonly assets: MapAssetStore;
}

/**
 * Build the region store for a declared stack.
 *
 * Taking `sources` rather than reading them back from a region: what a region *contains* is a
 * record of one download, while what the app can *serve* is a property of the stack it is
 * rendering now. A store built from the region's own list would silently stop serving a source
 * the app had since added.
 */
export function createDemoOffline(
  sources: TileSource[],
  assets: MapAssetStore = createIdbMapAssetStore(),
): DemoOffline {
  return { store: createPMTilesRegionStore({ sources, assets }), assets };
}

/** The region this demo downloads: the ground its archives cover, at the zooms they carry. */
export const demoRegionRequest = (sources: TileSource[]) => ({
  name: "demo-region",
  bbox: [DEMO_REGION.west, DEMO_REGION.south, DEMO_REGION.east, DEMO_REGION.north] as [
    number,
    number,
    number,
    number,
  ],
  minZoom: 8,
  maxZoom: 14,
  /**
   * **Named, never defaulted.** The published default is "all base and overlay sources", which
   * excludes the `hillshade` role — so a defaulted region would download the basemap and contours
   * and quietly omit the DEM (ADR-0034). Derived from the declared stack rather than written out
   * again: two lists of ids agree until the day one of them changes.
   */
  sourceIds: sources.map((source) => source.id),
});

/**
 * Install every downloaded archive, and report which sources are now served locally.
 *
 * Returns the ids so the caller can say what happened. An empty list is a valid state — it is
 * what a first visit looks like — and is not an error.
 */
export async function installDownloadedRegions(
  offline: DemoOffline,
  sources: TileSource[],
): Promise<OfflineStatus> {
  const regions: OfflineRegion[] = await offline.store.list();
  if (regions.length === 0) return { regions: 0, storedSourceIds: [], bytes: 0 };

  /**
   * The install still happens — it is the whole point of running before the map mounts. Its
   * return is deliberately **not** reported: those are this realm's registrations, and reporting
   * them alongside storage counts invites a reader to treat one as evidence of the other.
   */
  installOfflineArchives({
    regions,
    sources,
    assets: offline.assets,
    protocol: pmtilesArchiveRegistrar(),
  });
  return {
    regions: regions.length,
    // Read from the manifests, so this says what is *stored* rather than what was registered.
    storedSourceIds: [...new Set(regions.flatMap((region) => region.sourceIds ?? []))].sort(),
    // `sizeBytes` is optional on the published type; a manifest without it reports 0 rather
    // than NaN, which would render as a size and mean nothing.
    bytes: regions.reduce((total, region) => total + (region.sizeBytes ?? 0), 0),
  };
}
