// SPDX-License-Identifier: Apache-2.0

/**
 * The one thing this example cannot supply for you: map data.
 *
 * MAP-ATLAS bundles no tiles and points at no tile server. A copyable snippet that named
 * somebody else's host would send every reader's traffic there under terms this project never
 * agreed to, so the archive below is **yours**: a `.pmtiles` file your own application serves.
 * Drop it in `public/` and it is served at the path used here; change the URL if it lives
 * somewhere else.
 *
 * Both values describe your data rather than this example. `CAMERA` has to open inside the
 * ground your archive covers — a map opened over tiles the archive does not have renders as an
 * empty box with a correct attribution line, which is the most confusing way for this to fail.
 */

import type { LatLng, TileSource } from "@mapatlas/core";

export const BASEMAP: TileSource = {
  id: "basemap",
  kind: "vector",
  transport: "pmtiles",
  // Same-origin: whatever is in `public/` is served from the root of your application.
  url: new URL("/basemap.pmtiles", window.location.href).toString(),
  // Rendered verbatim, over the map. This is a licence obligation you inherit with the data,
  // not a caption — replace it with your source's terms.
  attribution: "© your basemap provider",
  // The layer names are your archive's, not the engine's: `source-layer` selects a layer inside
  // the vector tiles, so these have to match what your archive actually contains.
  styleLayers: [
    {
      id: "basemap-earth",
      type: "fill",
      source: "basemap",
      "source-layer": "earth",
      paint: { "fill-color": "#e8e4dc" },
    },
    {
      id: "basemap-water",
      type: "fill",
      source: "basemap",
      "source-layer": "water",
      paint: { "fill-color": "#0f8a7a" },
    },
  ],
};

export const CAMERA: { center: LatLng; zoom: number } = {
  center: { lat: 45.84, lng: 6.865 },
  zoom: 12,
};
