// SPDX-License-Identifier: Apache-2.0

import type { LayerSpecification, SourceSpecification } from "maplibre-gl";

import type {
  FeatureCollection,
  LineStringFeature,
  PointFeature,
} from "../builders/track-geojson.js";

/**
 * The map state the engine owns, as opposed to the state a consumer describes.
 *
 * Two registries, not one. Consumer sources come and go with `setSources`; engine sources —
 * the track line, the draft being authored — are installed once and then updated in place.
 * Keeping them apart is what lets a stack replacement tear down everything it added without
 * touching a track that has nothing to do with which basemap is showing.
 */

/**
 * Reserved for engine-owned ids. A consumer source claiming it is rejected during
 * preparation, before any desired state changes — the same treatment a duplicate id gets,
 * and for the same reason: MapLibre keys sources and layers by id, so a collision means one
 * of them silently wins.
 */
export const ENGINE_ID_PREFIX = "mapatlas:";

export const ENGINE_SOURCE = {
  track: `${ENGINE_ID_PREFIX}track`,
  draft: `${ENGINE_ID_PREFIX}draft`,
} as const;

export const ENGINE_LAYER = {
  trackLine: `${ENGINE_ID_PREFIX}track-line`,
  trackLineDashed: `${ENGINE_ID_PREFIX}track-line-dashed`,
  draftLine: `${ENGINE_ID_PREFIX}draft-line`,
  draftVertex: `${ENGINE_ID_PREFIX}draft-vertex`,
} as const;

/**
 * Where consumer layers are inserted.
 *
 * Ordering belongs to layers, not sources: MapLibre draws in add order, so consumer layers
 * added after a persistent track layer would land *above* it and hide the track. Inserting
 * them before the first engine layer keeps every engine overlay on top without those
 * overlays being removed and rebuilt on each stack replacement.
 */
export const ENGINE_LAYER_ANCHOR: string = ENGINE_LAYER.trackLine;

/**
 * A vertex or line of the draft being authored.
 *
 * Its own type rather than a reuse of `PointFeature`: a draft vertex is not a lap, and
 * borrowing that `kind` to get the shape right would put a false statement in the data for
 * the sake of a type. The draft layers filter on geometry, so nothing depends on the value —
 * which is exactly why it would have gone unnoticed.
 */
export interface DraftFeature {
  type: "Feature";
  geometry:
    | { type: "Point"; coordinates: [lng: number, lat: number] }
    | { type: "LineString"; coordinates: [lng: number, lat: number][] };
  properties: { kind: "draft-vertex" | "draft-line"; index?: number };
}

export type EngineFeature = LineStringFeature | PointFeature | DraftFeature;
export type EngineFeatureCollection = FeatureCollection<EngineFeature>;

/** What an engine source holds when there is nothing to show. */
export function emptyCollection(): EngineFeatureCollection {
  return { type: "FeatureCollection", features: [] };
}

/**
 * Engine sources start empty and are never removed.
 *
 * `renderTrack(null)` applies an empty collection rather than removing the source, so live
 * position and draft edits cause no layer-order drift and no teardown churn — and a track
 * that comes back does not have to reinstate anything.
 */
export const ENGINE_SOURCES: readonly (readonly [id: string, source: SourceSpecification])[] = [
  [ENGINE_SOURCE.track, { type: "geojson", data: emptyCollection() } as SourceSpecification],
  [ENGINE_SOURCE.draft, { type: "geojson", data: emptyCollection() } as SourceSpecification],
];

/**
 * Engine layers, in draw order.
 *
 * The track sits below the draft, because the draft is what the user is actively editing and
 * has to stay legible over whatever it crosses. Marks are **not** here: they are DOM markers,
 * since `MarkerStyle.html` is inserted verbatim and has to be keyboard-reachable.
 */
/**
 * Per-segment line styling, read from each feature.
 *
 * Data-driven rather than one layer per segment: a track with a hundred pauses would
 * otherwise mean a hundred layers, and MapLibre's draw cost is per layer. Defaults live in
 * the expression's fallback, so a segment the consumer said nothing about renders as the
 * engine's neutral line.
 */
const LINE_PAINT = {
  "line-color": ["coalesce", ["get", "lineColor"], "#0969da"],
  "line-width": ["coalesce", ["get", "lineWidthPx"], 3],
  "line-opacity": ["coalesce", ["get", "lineOpacity"], 1],
};

/** `dashed` is the one property MapLibre will not data-drive, so it gets its own layer. */
const DASH_PATTERN: readonly [number, number] = [2, 2];

export const ENGINE_LAYERS: readonly LayerSpecification[] = [
  {
    id: ENGINE_LAYER.trackLine,
    type: "line",
    source: ENGINE_SOURCE.track,
    filter: ["!=", ["get", "lineDashed"], true],
    layout: { "line-join": "round", "line-cap": "round" },
    paint: LINE_PAINT,
  },
  {
    id: ENGINE_LAYER.trackLineDashed,
    type: "line",
    source: ENGINE_SOURCE.track,
    filter: ["==", ["get", "lineDashed"], true],
    layout: { "line-join": "round", "line-cap": "round" },
    paint: { ...LINE_PAINT, "line-dasharray": [...DASH_PATTERN] },
  },
  {
    id: ENGINE_LAYER.draftLine,
    type: "line",
    source: ENGINE_SOURCE.draft,
    filter: ["==", ["geometry-type"], "LineString"],
    layout: { "line-join": "round", "line-cap": "round" },
    paint: { "line-color": "#bf8700", "line-width": 2, "line-dasharray": [2, 2] },
  },
  {
    id: ENGINE_LAYER.draftVertex,
    type: "circle",
    source: ENGINE_SOURCE.draft,
    filter: ["==", ["geometry-type"], "Point"],
    paint: {
      "circle-radius": 5,
      "circle-color": "#ffffff",
      "circle-stroke-color": "#bf8700",
      "circle-stroke-width": 2,
    },
  },
] as LayerSpecification[];

/** Whether an id belongs to the engine's reserved namespace. */
export function isEngineId(id: string): boolean {
  return id.startsWith(ENGINE_ID_PREFIX);
}
