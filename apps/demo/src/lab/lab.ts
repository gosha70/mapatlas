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
import type { MapEvent, TileSource, Track, TrackPoint } from "@mapatlas/core";
import { finalizeTrack } from "@mapatlas/core";
import type { EventPresentation, MapController } from "@mapatlas/maplibre";
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

/** Vertices the `draw=on` view authors, as offsets in degrees from the recording's first point. */
const DRAFT_OFFSETS: readonly (readonly [number, number])[] = [
  [0, 0],
  [0.0006, 0.0004],
  [0.0012, 0.0002],
];

export interface LabHandles {
  readonly controller: MapController;
  /** The track the recorder produced, once the replay has finished. */
  readonly track: Track;
  /**
   * What was actually handed to `renderTrack` — the selection, not the recording.
   *
   * Reported so a scenario can tell "this capture drew one segment" from "this capture drew
   * the whole track and the parameter did nothing", which is a difference the pixels alone
   * cannot express: a view rendering everything looks like a correct `both` capture.
   */
  readonly rendered: Track;
  readonly events: MapEvent[];
  destroy(): void;
}

/** Archive locations, if the caller has any. Absent means "render the track over a blank map". */
export interface LabSources {
  terrainUrl?: string | undefined;
  contourUrl?: string | undefined;
  /**
   * Whether the DEM gets its hillshade layer. The **source** is unaffected either way.
   *
   * This is the one knob that separates a layer from the source that feeds it. Terrain and
   * hillshade are driven by the same archive, so removing the archive removes both and proves
   * nothing about either; leaving the source and terrain in place while dropping the layer is
   * what isolates the hillshade's own pixels.
   */
  hillshade?: boolean | undefined;
  /**
   * Whether the map carries its marks — the two event marks, and the start and finish pins
   * `renderTrack` places at the ends of whatever it is given.
   *
   * Off for a differential, and the reason is a measured one. Those pins are **DOM overlays
   * anchored to the rendered track's own endpoints**, so they move when the selection moves:
   * rendering segment one alone puts a finish pin at the pause, which the two-segment render
   * has nowhere near. Measured at 176 pixels of purple sitting exactly where the pause proof
   * looks. That is `renderTrack` behaving correctly, and it makes the pixels of a marked map
   * the wrong subject for a claim about the *line*.
   */
  marks?: boolean | undefined;
  /**
   * Whether the map enters draw mode over a small draft.
   *
   * `/lab` exists so the *composition* can be checked, and the draft-vertex accessibility
   * contract could not be checked here at all while nothing on the route ever rendered one:
   * the engine proves that contract in isolation on the browser harness page, and this is what
   * lets the same check run against a consumer app assembled from package entry points
   * (`specs/tasks.md`, T4.7 clause 10).
   */
  draw?: boolean | undefined;
}

/**
 * Which of the recorded track a view draws.
 *
 * `"one"` and `"two"` render a single segment; `"both"` renders the recording as it happened,
 * pause and all. `"bridge"` renders the two points either side of the pause as one two-point
 * segment — a track the renderer must draw *across*, which is how the scenario locates the
 * corridor the real render has to leave empty. Without it the corridor would have to be
 * computed from a projection no consumer can reach, and a corridor in the wrong place is a
 * negative assertion about empty space.
 */
export type LabSegments = "both" | "one" | "two" | "bridge";

/**
 * Where the camera sits.
 *
 * `"track"` frames the whole recording. `"pause"` frames the gap, and it exists because the
 * differential cannot see one otherwise: at the whole-track zoom the 94.6 m pause is about 13
 * pixels, so a line drawn straight across it lands entirely inside the antialiased ends of the
 * two segments and leaves **no** ink of its own. Measured — the bridged control's strictly-new
 * pixels came to zero. A corridor that cannot hold a bridge cannot show its absence either.
 */
export type LabFocus = "track" | "pause";

/**
 * The zoom `focus=pause` uses.
 *
 * 17 puts the 94.6 m gap at roughly 105 px at this latitude — wide enough that a bridge is
 * unmistakable, and close enough to the archive's z12 that the basemap is still recognisable
 * rather than a smear. Nothing asserts on the basemap here: it is identical in every capture
 * of the comparison and cancels.
 */
const PAUSE_FOCUS_ZOOM = 17;

/** Close enough that the three draft vertices are separate, reachable hit targets. */
const DRAW_FOCUS_ZOOM = 16;

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
    // Present and "off" is the only way to lose the layer; anything else keeps it, so a
    // mistyped parameter renders the normal map rather than a quietly different one.
    hillshade: from.searchParams.get("hillshade") !== "off",
    marks: from.searchParams.get("marks") !== "off",
    // Opt-in, unlike the others: a route that entered draw mode by default would put a hand
    // authoring surface in front of anyone opening `/lab` to look at the fixture.
    draw: from.searchParams.get("draw") === "on",
  };
}

const SEGMENT_VIEWS: readonly LabSegments[] = ["both", "one", "two", "bridge"];
const FOCUS_VIEWS: readonly LabFocus[] = ["track", "pause"];

/** Where the URL asks the camera to sit, defaulting to the whole recording. */
export function readLabFocus(from: URL): LabFocus {
  const asked = from.searchParams.get("focus");
  if (asked === null) return "track";
  const found = FOCUS_VIEWS.find((view) => view === asked);
  if (found === undefined) {
    throw new Error(`/lab: focus=${asked} is not one of ${FOCUS_VIEWS.join(", ")}`);
  }
  return found;
}

/** The two points either side of the pause — a property of the input, read from the input. */
export function pauseEndpoints(track: Track): { from: TrackPoint; to: TrackPoint } {
  const first = track.segments[0];
  const second = track.segments[1];
  if (first === undefined || second === undefined) {
    throw new Error("/lab: a pause needs a two-segment recording");
  }
  const from = track.points[first.endIndex];
  const to = track.points[second.startIndex];
  if (from === undefined || to === undefined) {
    throw new Error("/lab: the recording's segments do not index its own points");
  }
  return { from, to };
}

/** Which segments a URL asks for, defaulting to the whole recording. */
export function readLabSegments(from: URL): LabSegments {
  const asked = from.searchParams.get("segments");
  if (asked === null) return "both";
  const found = SEGMENT_VIEWS.find((view) => view === asked);
  if (found === undefined) {
    // Refused rather than defaulted. A capture that silently rendered the whole track when it
    // was asked for one segment would make the differential compare a thing with itself.
    throw new Error(`/lab: segments=${asked} is not one of ${SEGMENT_VIEWS.join(", ")}`);
  }
  return found;
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
      // **256, not the renderer's 512 default for a DEM.** The fixture archives are cut at
      // `TILE_SIZE = 256`, so this is what a tile actually is.
      //
      // *What it does not do, corrected against a measurement.* An earlier note here claimed
      // the default would make MapLibre ask for a zoom the archive does not contain and shade
      // from nothing. It does not: with the line removed the hillshade still draws — 99.6% of
      // pixels differ from a no-hillshade render, against 95.9% with it — because the request
      // lands on a zoom the archive has, at the wrong scale. So the cost is fidelity, not
      // presence, and nothing in the suite yet says which of the two maps is the right one.
      tileSize: 256,
      // Dropped, not emptied of content: with `hillshade: false` the source is declared and
      // terrain still reads it, and the only thing missing from the map is this layer's ink.
      ...(sources.hillshade === false
        ? {}
        : {
            styleLayers: [
              {
                id: "fixture-hillshade",
                type: "hillshade",
                source: "fixture-terrain",
                paint: { "hillshade-exaggeration": 0.5 },
              },
            ],
          }),
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
/**
 * The part of a recording a view draws, as a track in its own right.
 *
 * Rebuilt through `finalizeTrack` rather than assembled by hand: the renderer reads
 * `simplifiedSegments`, so a track carrying the whole recording's cache under one segment's
 * points would draw geometry the caller never selected.
 *
 * The two pause endpoints are `points[segments[0].endIndex]` and `points[segments[1].startIndex]`
 * — a property of the input, asserted from the input, which is the only thing about this
 * geometry a consumer can honestly claim without reaching into the renderer.
 */
export function selectSegments(track: Track, view: LabSegments): Track {
  if (view === "both") return track;

  const first = track.segments[0];
  const second = track.segments[1];
  if (first === undefined || second === undefined) {
    throw new Error(`/lab: segments=${view} needs a two-segment recording`);
  }

  if (view === "bridge") {
    const from = track.points[first.endIndex];
    const to = track.points[second.startIndex];
    if (from === undefined || to === undefined) {
      throw new Error("/lab: the recording's segments do not index its own points");
    }
    return finalizeTrack({
      ...track,
      points: [from, to],
      segments: [{ ...first, startIndex: 0, endIndex: 1 }],
    });
  }

  const segment = view === "one" ? first : second;
  return finalizeTrack({
    ...track,
    points: track.points.slice(segment.startIndex, segment.endIndex + 1),
    segments: [{ ...segment, startIndex: 0, endIndex: segment.endIndex - segment.startIndex }],
  });
}

export async function mountLab(
  container: HTMLElement,
  sources: LabSources = {},
  view: LabSegments = "both",
  focus: LabFocus = "track",
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
  const withoutMarks: EventPresentation = {
    // Never reached: `renderEvents` is not called in this view. Throwing rather than returning
    // a placeholder, so "no marks" cannot quietly become "marks nobody chose".
    marker: () => {
      throw new Error("/lab: marks=off renders no events, so no event marker is ever asked for");
    },
    // `null` suppresses the mark — a documented consumer decision, not a gap in the engine.
    startMarker: () => null,
    finishMarker: () => null,
  };
  const controller = createMapController({
    container,
    sources: labTileSources(sources),
    style: BLANK_STYLE,
    ...(sources.marks === false ? { presentation: withoutMarks } : {}),
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
  const rendered = selectSegments(track, view);
  controller.renderTrack(rendered);
  if (sources.marks !== false) controller.renderEvents(events);
  // **Framed on the whole recording, whatever is drawn.** Fitting the selection would give each
  // capture its own camera, and every pixel would then differ for a reason that has nothing to
  // do with the geometry — which is the one thing a differential must not allow. The pause
  // framing is derived from the full recording for exactly the same reason.
  if (focus === "pause") {
    const { from, to } = pauseEndpoints(track);
    controller.recenter(
      { lat: (from.lat + to.lat) / 2, lng: (from.lng + to.lng) / 2 },
      PAUSE_FOCUS_ZOOM,
    );
  } else {
    controller.fitTrack(track);
  }

  // Draw mode last, so it is entered over a map that already has everything else on it — which
  // is the composition the check is about. The handlers are the ones a consumer writes: a move
  // updates the draft it owns and re-renders it.
  let exitDraw: (() => void) | undefined;
  if (sources.draw === true) {
    const origin = track.points[0];
    if (origin === undefined) throw new Error("/lab: draw=on needs a recording with a point");
    const draft = DRAFT_OFFSETS.map(([dLat, dLng]) => ({
      lat: origin.lat + dLat,
      lng: origin.lng + dLng,
    }));
    controller.renderDraft(draft);
    controller.recenter({ lat: draft[1]!.lat, lng: draft[1]!.lng }, DRAW_FOCUS_ZOOM);
    exitDraw = controller.enterDrawMode({
      onVertexAdd: () => undefined,
      onVertexMove: (index, to) => {
        draft[index] = to;
        controller.renderDraft(draft);
      },
    });
  }

  return {
    controller,
    track,
    rendered,
    events,
    destroy() {
      exitDraw?.();
      controller.destroy();
    },
  };
}
