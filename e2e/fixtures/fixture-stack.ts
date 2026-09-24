// SPDX-License-Identifier: Apache-2.0
import type { TileSource } from "@mapatlas/core";

import { FIXTURE_ATTRIBUTION } from "../../apps/demo/src/attribution.js";

/**
 * The fixture archives as a source stack for the renderer proofs (`map-controller.e2e.ts`).
 *
 * This was `/lab`'s stack until T8.3 retired that route. The proofs need what the route needed:
 * the terrain archive as a DEM that both raises terrain and draws a hillshade layer, and the
 * contour archive as lines — with the hillshade **layer** removable on its own, which is the
 * knob the hillshade proof turns.
 */
export interface FixtureStack {
  terrainUrl?: string | undefined;
  contourUrl?: string | undefined;
  /**
   * Whether the DEM gets its hillshade layer. The **source** is unaffected either way: terrain
   * still reads it, and the only thing missing from the map is this layer's ink. That is what
   * isolates the hillshade's own pixels — removing the archive would remove terrain with it.
   */
  hillshade?: boolean | undefined;
}

export const FIXTURE_TERRAIN_SOURCE = "fixture-terrain";

export function fixtureTileSources(stack: FixtureStack): TileSource[] {
  const tiles: TileSource[] = [];
  if (stack.terrainUrl !== undefined) {
    tiles.push({
      id: FIXTURE_TERRAIN_SOURCE,
      kind: "raster-dem",
      transport: "pmtiles",
      url: stack.terrainUrl,
      // True by construction: this archive is cut locally by `npm run fixture:build` from a
      // source whose terms permit redistribution, so it is self-hosted in the sense §8 means
      // (ADR-0033). Absence would refuse it.
      offlineLicensed: true,
      // Rendered verbatim, and required: the archive is a derived work of Copernicus DEM GLO-30
      // Public, whose licence the build already checks into every archive.
      attribution: FIXTURE_ATTRIBUTION,
      // **Hillshade, not terrain, is the role that draws.** A `terrain` source contributes no
      // drawable layer at all — `TerrainOptions` points at it — so declaring only that would
      // leave the DEM unrequested. One DEM source drives both: this role supplies the hillshade
      // layer below, and `terrain` on the controller points at the same source id.
      role: "hillshade",
      encoding: "terrarium",
      // **256, not the renderer's 512 default for a DEM.** The fixture archives are cut at
      // `TILE_SIZE = 256`, so this is what a tile actually is. Measured on the route this came
      // from: with the line removed the hillshade still draws, at the wrong scale — the cost is
      // fidelity, not presence.
      tileSize: 256,
      // Dropped, not emptied of content: with `hillshade: false` the source is declared and
      // terrain still reads it, and the only thing missing from the map is this layer's ink.
      ...(stack.hillshade === false
        ? {}
        : {
            styleLayers: [
              {
                id: "fixture-hillshade",
                type: "hillshade",
                source: FIXTURE_TERRAIN_SOURCE,
                paint: { "hillshade-exaggeration": 0.5 },
              },
            ],
          }),
    });
  }
  if (stack.contourUrl !== undefined) {
    tiles.push({
      id: "fixture-contours",
      kind: "vector",
      transport: "pmtiles",
      url: stack.contourUrl,
      // True by construction, as above (ADR-0033).
      offlineLicensed: true,
      attribution: FIXTURE_ATTRIBUTION,
      styleLayers: [
        {
          id: "fixture-contour-lines",
          type: "line",
          source: "fixture-contours",
          "source-layer": "contours",
          paint: { "line-color": "#795548", "line-width": 0.8 },
        },
      ],
    });
  }
  return tiles;
}
