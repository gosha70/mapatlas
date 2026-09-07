// SPDX-License-Identifier: Apache-2.0

/**
 * The demo app's tile stack.
 *
 * **Deliberately its own, not `/lab`'s.** The two declare archives that look identical today and
 * are about to diverge: `/lab`'s are cut for a pixel differential and are pinned to that
 * scenario, while these are the *demo's* stack, which T7.1's basemap increment replaces with a
 * self-hosted extract. Sharing them now would couple the app to a fixture harness and then have
 * to be unpicked; duplication that is scheduled to diverge is not drift.
 *
 * **Absent archives are not an error.** With no `?terrain=` or `?contours=`, the app renders the
 * track over a blank style — which is what a consumer sees before they have downloaded anything,
 * and it keeps the route from depending on a build step.
 */

import type { JSONValue, LatLng, TileSource } from "@mapatlas/core";

import { FIXTURE_ATTRIBUTION } from "../attribution.js";

/** A style with no sources of its own, so an empty map needs no network. */
export const BLANK_STYLE: JSONValue = {
  version: 8,
  sources: {},
  layers: [{ id: "background", type: "background", paint: { "background-color": "#eceff1" } }],
};

/** Where the demo's archives are, if the caller has any. */
export interface DemoSources {
  terrainUrl?: string | undefined;
  contourUrl?: string | undefined;
}

/**
 * Read archive locations from a URL.
 *
 * The same parameter names `/lab` uses, so one set of fixture archives serves both without a
 * second convention to remember. Exported so a scenario builds the object the browser would
 * rather than duplicating the names on both sides — a mismatch there renders a blank map and
 * looks like a broken app.
 */
export function readDemoSources(from: URL): DemoSources {
  return {
    terrainUrl: from.searchParams.get("terrain") ?? undefined,
    contourUrl: from.searchParams.get("contours") ?? undefined,
  };
}

/**
 * The ground the demo's archives cover.
 *
 * **The demo's own copy, not `/lab`'s.** The bounds are the same today because the same fixture
 * archives serve both, and the app must not import from the fixture harness — the dependency
 * would survive the basemap increment, which cuts its own extract and leaves `/lab`'s archives
 * where they are. Same category as the stack above: scheduled to diverge, so duplicated now.
 *
 * Both this and `/lab`'s copy are checked against `fixtures/vertical/region.json` by their own
 * tests, so neither can drift out of the archives' coverage without a test going red. That check
 * is the whole reason a copy is safe: without it, widening this would move the camera off the
 * archives and the map would render blank with everything green.
 */
export const DEMO_REGION = Object.freeze({
  west: 6.825,
  south: 45.815,
  east: 6.905,
  north: 45.865,
});

/**
 * Where the map opens.
 *
 * **Not optional decoration.** `MapCanvas` has no camera of its own to fall back on that means
 * anything here: without this the map opens at MapLibre's world view, the archives cover 0.08°
 * of one massif, and every tile MapLibre asks for is outside them. The observable failure is a
 * flat grey box with a correct attribution line and a correct source count — which is exactly
 * how it shipped for review, and exactly what "a canvas exists" cannot see.
 *
 * Zoom 12 because that is the archives' `maxZoom`; z11 is the floor. A camera outside that range
 * is a camera over no tiles.
 */
export const DEMO_CAMERA: { center: LatLng; zoom: number } = {
  center: {
    lat: (DEMO_REGION.south + DEMO_REGION.north) / 2,
    lng: (DEMO_REGION.west + DEMO_REGION.east) / 2,
  },
  zoom: 12,
};

/** The demo's `TileSource` stack for a given set of archive locations. */
export function demoTileSources(sources: DemoSources): TileSource[] {
  const tiles: TileSource[] = [];

  if (sources.terrainUrl !== undefined) {
    tiles.push({
      id: "demo-terrain",
      kind: "raster-dem",
      transport: "pmtiles",
      url: sources.terrainUrl,
      // True by construction: cut locally by `npm run fixture:build` from a source whose terms
      // permit redistribution, so it is self-hosted in the sense `architecture.md` §8 means.
      // Absence would refuse it (ADR-0033).
      offlineLicensed: true,
      attribution: FIXTURE_ATTRIBUTION,
      // `hillshade`, not `terrain`: a `terrain` source contributes no drawable layer — the
      // controller's `terrain` option points at it — so declaring only that would leave the DEM
      // unrequested. One source drives both.
      role: "hillshade",
      encoding: "terrarium",
      // 256, not the renderer's 512 default for a DEM: the fixture archives are cut at that
      // size, and the mismatch costs fidelity rather than presence.
      tileSize: 256,
      styleLayers: [
        {
          id: "demo-hillshade",
          type: "hillshade",
          source: "demo-terrain",
          paint: { "hillshade-exaggeration": 0.5 },
        },
      ],
    } satisfies TileSource);
  }

  if (sources.contourUrl !== undefined) {
    tiles.push({
      id: "demo-contours",
      kind: "vector",
      transport: "pmtiles",
      url: sources.contourUrl,
      offlineLicensed: true,
      attribution: FIXTURE_ATTRIBUTION,
      styleLayers: [
        {
          id: "demo-contour-lines",
          type: "line",
          source: "demo-contours",
          "source-layer": "contours",
          paint: { "line-color": "#795548", "line-width": 0.8 },
        },
      ],
    } satisfies TileSource);
  }

  return tiles;
}

/** Terrain, but only when there is a DEM to raise: naming an absent source is a broken style. */
export const demoTerrain = (
  sources: DemoSources,
): { sourceId: string; exaggeration: number } | null =>
  sources.terrainUrl === undefined ? null : { sourceId: "demo-terrain", exaggeration: 1 };
