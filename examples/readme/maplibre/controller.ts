// SPDX-License-Identifier: Apache-2.0
import type { TileSource } from "@mapatlas/core";
import { createMapController, type MapController } from "@mapatlas/maplibre";

// Your archive, served by your application: the engine bundles no map data.
const basemap: TileSource = {
  id: "basemap",
  kind: "vector",
  transport: "pmtiles",
  url: new URL("/basemap.pmtiles", window.location.href).toString(),
  attribution: "© your basemap provider",
};

const container = document.getElementById("map");
if (container === null) throw new Error("no #map element");

export const controller: MapController = createMapController({
  container,
  sources: [basemap],
});
