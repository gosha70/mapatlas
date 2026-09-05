// SPDX-License-Identifier: Apache-2.0

/**
 * `/lab`'s offline region: download the fixture archives, then read the map back out of them.
 *
 * **What this is evidence for, and what it is not.** T6.1's claim is that the bytes a map draws
 * came from local storage rather than the network. Zero network requests does not say that — a
 * service worker, a warm HTTP cache, or a `blob:` url minted earlier all produce zero requests
 * while proving nothing. Byte identity is asserted in the unit lane, against
 * `createMemoryMapAssetStore`; what this route adds is the other half, which the unit lane
 * cannot reach: a real MapLibre, reading a real archive out of a real IndexedDB, through the
 * protocol a consumer would use.
 *
 * **Assembled only from package entry points**, like the rest of `/lab`: `createIdbMapAssetStore`,
 * `createPMTilesRegionStore`, `installOfflineArchives` and `pmtilesArchiveRegistrar` are all
 * imported by bare package name, so this exercises the wiring a consumer gets from `npm install`
 * — including the fact that the two packages know each other only structurally (ADR-0036).
 */

import type { OfflineRegion, TileSource } from "@mapatlas/core";
import { pmtilesArchiveRegistrar } from "@mapatlas/maplibre";
import { createPMTilesRegionStore, installOfflineArchives } from "@mapatlas/offline-pmtiles";
import { createIdbMapAssetStore } from "@mapatlas/storage-idb";

import { FIXTURE_REGION } from "./fixture-track.js";

/** What `/lab` does about offline regions on this load. */
export type LabOffline = "off" | "download" | "use" | "delete";

const OFFLINE_MODES: readonly LabOffline[] = ["off", "download", "use", "delete"];

/** Which offline step a URL asks for, defaulting to none. */
export function readLabOffline(from: URL): LabOffline {
  const asked = from.searchParams.get("offline");
  if (asked === null) return "off";
  const found = OFFLINE_MODES.find((mode) => mode === asked);
  if (found === undefined) {
    // Refused rather than defaulted, for the same reason `segments` is: a load that silently
    // did nothing when it was asked to download would leave a scenario asserting against a map
    // that was never offline, and the pass would look identical to the real one.
    throw new Error(`/lab: offline=${asked} is not one of ${OFFLINE_MODES.join(", ")}`);
  }
  return found;
}

/**
 * The zoom range the region records.
 *
 * Descriptive, not selective: for `transport: "pmtiles"` the archive is the unit and these
 * bound the region the archive represents (ADR-0034). The fixture archives are cut to this
 * range by `npm run fixture:build`, so the manifest and the bytes agree.
 */
const REGION_ZOOM = Object.freeze({ minZoom: 8, maxZoom: 14 });

const REGION_NAME = "lab fixture region";

/** What a load reports about the offline step it ran, for a scenario and for a human reading it. */
export interface LabOfflineReport {
  /** The step this load ran. Always present, so it doubles as "the offline step is finished". */
  readonly mode: LabOffline;
  /**
   * Regions the store holds *after* this step, so "downloaded" and "deleted" are both visible.
   *
   * **Absent when this load did not consult the store** — which `"off"` does not, deliberately:
   * counting would open IndexedDB on every plain `/lab` load, for a number that load has no use
   * for. Absent and zero are different answers, and reporting zero for "did not look" would be a
   * false statement about the store whenever one *is* held.
   */
  readonly regions?: number;
  readonly regionId?: string;
  /** Bytes the manifest records — the archives as stored, not an estimate. */
  readonly sizeBytes?: number;
  /** The **resolved** source ids the manifest names. */
  readonly sourceIds?: readonly string[];
  /** Urls now served from local bytes. Empty when nothing was installed. */
  readonly served: readonly string[];
}

const storeFor = (
  sources: TileSource[],
): {
  store: ReturnType<typeof createPMTilesRegionStore>;
  assets: ReturnType<typeof createIdbMapAssetStore>;
} => {
  const assets = createIdbMapAssetStore();
  return { store: createPMTilesRegionStore({ sources, assets }), assets };
};

/**
 * Run the offline step this load asked for.
 *
 * Called **before** the map is mounted, and the order inside `"use"` is the one the contract
 * states: obtain the registrar, install the archives, and only then let anything add a `pmtiles`
 * source. The renderer's own registration is lazy, so before a source stack exists there is no
 * `Protocol` to hand back — and an archive registered after MapLibre has already asked for a
 * tile from that url does not retroactively serve it (ADR-0036).
 */
export async function runLabOffline(
  mode: LabOffline,
  sources: TileSource[],
): Promise<LabOfflineReport> {
  if (mode === "off") return { mode, served: [] };

  const { store, assets } = storeFor(sources);
  try {
    if (mode === "download") {
      const region = await store.download({
        name: REGION_NAME,
        bbox: [
          FIXTURE_REGION.west,
          FIXTURE_REGION.south,
          FIXTURE_REGION.east,
          FIXTURE_REGION.north,
        ],
        ...REGION_ZOOM,
        // **Named, not defaulted.** The published default is "all base+overlay", which excludes
        // the `hillshade` role — so a defaulted region here would download the contours and omit
        // the DEM, which is the exact thing T6.1's acceptance criterion is about (ADR-0034).
        // Derived from the declared stack rather than spelled again: two lists of ids would
        // agree until the day one of them changed.
        sourceIds: sources.map((source) => source.id),
      });
      return describe(mode, region, await store.list(), []);
    }

    if (mode === "delete") {
      for (const region of await store.list()) await store.delete(region.id);
      return { mode, regions: (await store.list()).length, served: [] };
    }

    const regions = await store.list();
    const served = installOfflineArchives({
      regions,
      sources,
      assets,
      protocol: pmtilesArchiveRegistrar(),
    });
    return describe(mode, regions[0], regions, served);
  } finally {
    // The connection, not the data. Left open, a later `deleteDatabase` from a consumer or a
    // devtools wipe blocks on it.
    //
    // Safe in the `"use"` path too, which is the one that matters: the archives registered above
    // hold this same store and read from it for the life of the page, and `close()` drops the
    // connection rather than poisoning it — the next read reopens. If that were wrong the
    // offline render would fail outright, which is what the browser scenario would report.
    await assets.close();
  }
}

function describe(
  mode: LabOffline,
  region: OfflineRegion | undefined,
  regions: readonly OfflineRegion[],
  served: readonly string[],
): LabOfflineReport {
  return {
    mode,
    regions: regions.length,
    ...(region === undefined
      ? {}
      : {
          regionId: region.id,
          ...(region.sizeBytes === undefined ? {} : { sizeBytes: region.sizeBytes }),
          ...(region.sourceIds === undefined ? {} : { sourceIds: region.sourceIds }),
        }),
    served,
  };
}
