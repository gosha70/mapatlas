// SPDX-License-Identifier: Apache-2.0

/**
 * `/lab` — the vertical fixture, human-openable (T4.6).
 *
 * **Assembled only from package entry points.** `createMapController`, `createWebTrackRecorder`
 * and the core types are imported by bare package name, so this exercises what a consumer gets
 * from `npm install`. `e2e/harness` reaches deeper on purpose, for probes that need the injected
 * environment; a `/lab` built on those would show that the harness works.
 *
 * The map's sources come from the query string rather than being hard-coded, so the same route
 * serves a human opening it with archives built by `npm run fixture:build` and a scenario
 * pointing at archives it cut into a temporary directory. With neither, the track still renders
 * over a blank style — useful on its own, and it keeps the route from depending on a build step.
 */

// `TileSource` is a core type — the renderer consumes it, it does not define it. Importing it
// from `@mapatlas/maplibre` would tie the demo's source declarations to the renderer, which is
// the coupling the seam exists to avoid.
import type { MapEvent, TileSource, Track } from "@mapatlas/core";
import type { MapController } from "@mapatlas/maplibre";
import { createMapController } from "@mapatlas/maplibre";
import { createWebTrackRecorder } from "@mapatlas/recorder-web";

import { FIXTURE_REGION, generateFixtureEvents, generateFixtureTrack } from "./fixture-track.js";
import { LAB_SAMPLING, createReplayGeolocation } from "./simulated-geolocation.js";

/** A style with no sources of its own, so an empty map needs no network. */
const BLANK_STYLE = {
  version: 8,
  sources: {},
  layers: [{ id: "background", type: "background", paint: { "background-color": "#eceff1" } }],
};

export interface LabHandles {
  readonly controller: MapController;
  /** The track the recorder produced, once the replay has finished. */
  readonly track: Track;
  readonly events: MapEvent[];
  destroy(): void;
}

/** Archive locations, if the caller has any. Absent means "render the track over a blank map". */
export interface LabSources {
  terrainUrl?: string | undefined;
  contourUrl?: string | undefined;
}

/**
 * Read archive locations from a URL's query string.
 *
 * Exported so a scenario builds the same object the browser would, rather than duplicating the
 * parameter names on both sides — a mismatch there would silently render a blank map.
 */
export function readLabSources(from: URL): LabSources {
  return {
    terrainUrl: from.searchParams.get("terrain") ?? undefined,
    contourUrl: from.searchParams.get("contours") ?? undefined,
  };
}

/** The sources `/lab` shows for a given set of archive locations. */
export function labTileSources(sources: LabSources): TileSource[] {
  const tiles: TileSource[] = [];
  if (sources.terrainUrl !== undefined) {
    tiles.push({
      id: "fixture-terrain",
      kind: "raster-dem",
      transport: "pmtiles",
      url: sources.terrainUrl,
      // Rendered verbatim, and required: the archive is a derived work of Copernicus DEM
      // GLO-30 Public, whose licence the build already checks into every archive.
      attribution:
        "Contains modified Copernicus DEM GLO-30 Public data © DLR e.V. and Airbus DS GmbH",
      // **Hillshade, not terrain, is the role that draws.** A `terrain` source contributes no
      // drawable layer at all — `TerrainOptions` points at it — so declaring only that would
      // leave the DEM unrequested and the required terrain-plus-hillshade stack absent. One DEM
      // source drives both: this role supplies the hillshade layer below, and `terrain` on the
      // controller points at the same source id.
      role: "hillshade",
      encoding: "terrarium",
      styleLayers: [
        {
          id: "fixture-hillshade",
          type: "hillshade",
          source: "fixture-terrain",
          paint: { "hillshade-exaggeration": 0.5 },
        },
      ],
    });
  }
  if (sources.contourUrl !== undefined) {
    tiles.push({
      id: "fixture-contours",
      kind: "vector",
      transport: "pmtiles",
      url: sources.contourUrl,
      attribution:
        "Contains modified Copernicus DEM GLO-30 Public data © DLR e.V. and Airbus DS GmbH",
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

/**
 * Mount the lab: replay the fixture through the recorder, then render what it produced.
 *
 * **The rendered track is the recorder's output, not the fixture.** Handing the generated track
 * straight to the renderer would skip the seam the demo exists to exercise, and would render
 * something no recording ever produced.
 */
export async function mountLab(
  container: HTMLElement,
  sources: LabSources = {},
): Promise<LabHandles> {
  const fixture = generateFixtureTrack();
  const replay = createReplayGeolocation(fixture);

  const original = Object.getOwnPropertyDescriptor(navigator, "geolocation");
  Object.defineProperty(navigator, "geolocation", {
    value: replay.geolocation,
    configurable: true,
  });
  const restoreGeolocation = (): void => {
    if (original === undefined) delete (navigator as { geolocation?: unknown }).geolocation;
    else Object.defineProperty(navigator, "geolocation", original);
  };

  let track: Track;
  try {
    const recorder = createWebTrackRecorder({ sampling: LAB_SAMPLING });
    await recorder.start();
    for (let i = 0; i < replay.total; i += 1) {
      if (i === replay.pauseAfter + 1) {
        // The pause the fixture declares, taken through the recorder's own seam so the two
        // segments are the recorder's, not the fixture's copied over.
        recorder.pause();
        recorder.resume();
      }
      replay.advance();
    }
    track = await recorder.stop();
  } finally {
    restoreGeolocation();
  }

  const events = generateFixtureEvents(track);
  const controller = createMapController({
    container,
    sources: labTileSources(sources),
    style: BLANK_STYLE,
    // Only when there is a DEM to raise: `TerrainOptions` naming a source that does not exist
    // is a broken style, not a map without terrain.
    ...(sources.terrainUrl === undefined
      ? {}
      : { terrain: { sourceId: "fixture-terrain", exaggeration: 1 } }),
    center: {
      lat: (FIXTURE_REGION.south + FIXTURE_REGION.north) / 2,
      lng: (FIXTURE_REGION.west + FIXTURE_REGION.east) / 2,
    },
    zoom: 12,
  });
  controller.renderTrack(track);
  controller.renderEvents(events);
  controller.fitTrack(track);

  return {
    controller,
    track,
    events,
    destroy() {
      controller.destroy();
    },
  };
}
