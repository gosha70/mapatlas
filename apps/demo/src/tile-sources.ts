// SPDX-License-Identifier: Apache-2.0

/**
 * Demo basemap sources. These point at OpenStreetMap's public tile server for
 * *local demo use only* — production consumers must self-host or use PMTiles
 * offline regions and honor OSM's ODbL attribution (see architecture.md §8).
 */
import type { TileSource } from "@mapatlas/core";

export const OSM_BASE: TileSource = {
  id: "osm",
  kind: "xyz",
  url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  attribution: "© OpenStreetMap contributors",
  maxZoom: 19,
};

/** OpenSeaMap seamark overlay (ODbL, share-alike) — overlay only. */
export const SEAMARK_OVERLAY: TileSource = {
  id: "openseamap-seamark",
  kind: "xyz",
  url: "https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png",
  attribution: "© OpenSeaMap contributors",
  opacity: 0.9,
};

export const DEMO_SOURCES: TileSource[] = [OSM_BASE];
