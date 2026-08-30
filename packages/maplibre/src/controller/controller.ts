// SPDX-License-Identifier: Apache-2.0

import type {
  BBox,
  DraftTrackPoint,
  Id,
  JSONValue,
  LatLng,
  MapEvent,
  TerrainOptions,
  TileSource,
  TileSourceKind,
  Track,
  TrackPoint,
} from "@mapatlas/core";

import type { BuiltTileSource } from "../builders/tile-source.js";
import { TileSourceError, buildTileSources, usesPmtiles } from "../builders/tile-source.js";
import type { PointFeature, Position2D } from "../builders/track-geojson.js";
import {
  buildLapFeatures,
  buildTrackEndpointFeatures,
  buildTrackLineFeatures,
} from "../builders/track-geojson.js";
import { applyMarkerStyle, createMarkerElement } from "../marks/marker-element.js";
import type { EventPresentation, TrackLineStyle } from "../marks/presentation.js";
import { snapshotLineStyle, snapshotMarkerStyle } from "../marks/presentation.js";
import type { MarkerStyle } from "../marks/marker-style.js";
import { builtInMark } from "../marks/marker-style.js";
import type { DrawModeHandlers, DrawSession } from "./draw-mode.js";
import { MapDrawModeError, startDrawMode } from "./draw-mode.js";
import type { EngineFeature, EngineFeatureCollection } from "./engine-layers.js";
import {
  ENGINE_ID_PREFIX,
  ENGINE_LAYERS,
  ENGINE_LAYER_ANCHOR,
  ENGINE_SOURCE,
  ENGINE_SOURCES,
  emptyCollection,
  isEngineId,
} from "./engine-layers.js";
import { ensurePmtilesProtocol } from "../protocols/pmtiles.js";
import type { MapEnvironment, MapLike, MapPointerEvent, MarkerHandle } from "./environment.js";

/**
 * The map controller's source stack and terrain (T4.1, T4.2).
 *
 * Three ideas carry the whole file.
 *
 * **The controller models desired state, not a command log.** `setSources` records what the
 * map should show and reconciles if it can; it never queues work. Calling it three times
 * before the style loads installs the third stack once, not three stacks in sequence — the
 * first two describe a map nobody ever saw.
 *
 * **Desired state is *prepared* state, translated and validated at the call.** Storing raw
 * `TileSource[]` would make rejection asynchronous: an invalid stack handed over before the
 * style loaded would return successfully and then throw from inside MapLibre's `load`
 * callback, where no caller can catch it and where the previous valid stack has already been
 * abandoned. Translating up front means `setSources` either throws to the caller or is
 * guaranteed installable, whether the map is ready or not.
 *
 * **Installation waits for `load`.** MapLibre rejects `addSource` and `addLayer` until the
 * style is ready, so construction is synchronous for the consumer while the install path
 * hangs off that event.
 *
 * Terrain is not an exception to any of that; it is another **consumer of the source stack**,
 * exactly as layers are. So a stack replacement is atomic with respect to it: compatibility
 * is checked before anything is mutated, applied terrain is released before any old source
 * goes, and it is restored only once the new sources and layers are in. When T4.3 adds track
 * and event sources, they join the same ordering rather than becoming a second exception.
 */

/**
 * An empty MapLibre style, used when the consumer supplies none.
 *
 * Not an arbitrary default: MapLibre documents that a map built without `style` needs
 * `setStyle()` before it renders at all, so omitting it would hand the consumer a map that
 * silently does nothing. An empty v8 document is the smallest thing the engine's own source
 * stack can composite onto, and it ships no basemap the consumer did not ask for.
 */
export const EMPTY_STYLE: JSONValue = Object.freeze({
  version: 8,
  sources: {},
  layers: [],
}) as JSONValue;

/**
 * Attribution when the consumer names no prefix: none.
 *
 * Explicitly none, rather than absent. MapLibre's default attribution control carries
 * MapLibre's own attribution, and ADR-0008 says the engine does not put a library's
 * branding in a consumer's app. Each `TileSource` still contributes its own
 * `attribution` — that is a licence obligation and is rendered regardless.
 */
const NO_CUSTOM_ATTRIBUTION: readonly string[] = Object.freeze([]);

/**
 * Terrain that the controller will not install, refused at the call.
 *
 * MapLibre 6.6 validates a `TerrainSpecification` and rejects a source the style does not
 * hold — but only when `setTerrain` reaches it, which for this controller is at `load`, long
 * after the call that introduced the fault. What it does not check at all is whether the
 * source is an *elevation* raster: terrain over ordinary imagery renders a silently flat
 * map, indistinguishable from a DEM whose tiles failed.
 */
export class MapTerrainError extends Error {
  constructor(detail: string) {
    super(`map terrain: ${detail}`);
    this.name = "MapTerrainError";
  }
}

/**
 * A reserved id already in the style, put there by something other than this controller.
 *
 * Only reachable from a base style **URL**: a style document is checked at the call, and a
 * consumer `TileSource` is rejected during preparation. The renderer fetches a URL itself,
 * so this is the one collision that cannot be caught before the style loads.
 */
export class MapNamespaceCollisionError extends Error {
  readonly id: string;

  constructor(id: string) {
    super(
      `map controller: "${id}" is reserved for the engine but the base style already ` +
        `declares it; rename it in the style, or supply a style that leaves ` +
        `"${ENGINE_ID_PREFIX}" alone`,
    );
    this.name = "MapNamespaceCollisionError";
    this.id = id;
  }
}

export class MapControllerDestroyedError extends Error {
  constructor(operation: string) {
    super(`map controller: ${operation} was called after destroy()`);
    this.name = "MapControllerDestroyedError";
  }
}

/**
 * A stack that has already been translated and validated, so installing it cannot fail on
 * anything the engine is able to check.
 *
 * `needsPmtiles` and `kinds` are captured here rather than recomputed at install time
 * because they are properties of the sources, and the sources are no longer around by then.
 * `kinds` is a snapshot of what terrain needs to know, so terrain is validated against
 * *desired* state rather than against whatever the map currently holds — which is the
 * difference that matters before `load`, when the map holds nothing at all.
 */
interface PreparedSources {
  readonly built: BuiltTileSource[];
  readonly needsPmtiles: boolean;
  readonly kinds: ReadonlyMap<string, TileSourceKind>;
}

/**
 * Reject a base style that declares reserved ids.
 *
 * Only a style *document* can be checked: a style URL is fetched by the renderer, so a
 * collision there surfaces as a duplicate-id error at load rather than here. Checking what
 * can be checked still removes the case a consumer is most likely to hit — pasting a style
 * that happens to name something under `mapatlas:`.
 */
function assertStyleLeavesTheNamespaceAlone(style: string | JSONValue | undefined): void {
  if (typeof style !== "object" || style === null || Array.isArray(style)) return;
  const document = style as Record<string, unknown>;

  const sources = document["sources"];
  if (typeof sources === "object" && sources !== null && !Array.isArray(sources)) {
    for (const id of Object.keys(sources)) {
      if (isEngineId(id)) {
        throw new TileSourceError(
          id,
          `"${ENGINE_ID_PREFIX}" is reserved for the engine; a base style may not declare it`,
        );
      }
    }
  }

  const layers = document["layers"];
  if (Array.isArray(layers)) {
    for (const layer of layers) {
      const id =
        typeof layer === "object" && layer !== null
          ? (layer as Record<string, unknown>)["id"]
          : undefined;
      if (typeof id === "string" && isEngineId(id)) {
        throw new TileSourceError(
          id,
          `"${ENGINE_ID_PREFIX}" is reserved for the engine; a base style may not declare it`,
        );
      }
    }
  }
}

function prepareSources(sources: readonly TileSource[]): PreparedSources {
  for (const source of sources) {
    if (isEngineId(source.id)) {
      // Rejected during preparation, before any desired state changes — the same treatment a
      // duplicate id gets, and for the same reason: MapLibre keys by id, so a collision means
      // one of them silently wins, and here the loser would be the user's own track.
      throw new TileSourceError(
        source.id,
        `"${ENGINE_ID_PREFIX}" is reserved for engine-owned sources and layers`,
      );
    }
  }
  return {
    built: buildTileSources(sources),
    needsPmtiles: sources.some(usesPmtiles),
    kinds: new Map(sources.map((source) => [source.id, source.kind])),
  };
}

/** Terrain the controller has accepted. `null` is prepared state meaning "no terrain". */
interface PreparedTerrain {
  readonly source: string;
  readonly exaggeration: number;
}

/** MapLibre's default, and the style spec's. */
const DEFAULT_EXAGGERATION = 1;

/**
 * Check terrain against a source stack and normalise it, or throw.
 *
 * Two different kinds of check. MapLibre does reject a missing source and does validate a
 * `TerrainSpecification`, so the value here is *when*: synchronously, at this package's own
 * public boundary, rather than from inside a `load` callback no caller can catch. The source
 * *kind* cross-check is the one MapLibre does not make at all — terrain over ordinary
 * imagery renders flat, with nothing to say why.
 *
 * `role` is deliberately not checked. `kind` states what a source *is* — an elevation
 * raster — while `role` states how it participates in the stack, and a DEM can legitimately
 * drive terrain while also carrying a hillshade layer.
 */
function prepareTerrain(
  terrain: TerrainOptions | null,
  sources: PreparedSources,
): PreparedTerrain | null {
  if (terrain === null) return null;

  const kind = sources.kinds.get(terrain.sourceId);
  if (kind === undefined) {
    throw new MapTerrainError(`no source "${terrain.sourceId}" in the stack`);
  }
  if (kind !== "raster-dem") {
    throw new MapTerrainError(
      `source "${terrain.sourceId}" is kind "${kind}", not "raster-dem" — terrain over a ` +
        `non-elevation source renders flat, with nothing to say why`,
    );
  }

  const exaggeration = terrain.exaggeration ?? DEFAULT_EXAGGERATION;
  if (!Number.isFinite(exaggeration) || exaggeration < 0) {
    // The style spec defines exaggeration as >= 0. Zero is legitimate — flat terrain that is
    // still terrain — so it is accepted; NaN and Infinity are not. Checked here so the
    // rejection lands on the caller rather than at load.
    throw new MapTerrainError(`exaggeration must be a finite number >= 0, got ${exaggeration}`);
  }

  return { source: terrain.sourceId, exaggeration };
}

/**
 * Everything the engine draws, translated at the call and applied when the map can take it.
 *
 * Same discipline as sources and terrain: `renderTrack` builds its features immediately, so
 * a track handed over before the style loads is already GeoJSON by the time `load` fires,
 * and nothing has to be remembered about *how* to build it later.
 *
 * Lines live in GeoJSON sources; marks are DOM markers. That split is not stylistic —
 * `MarkerStyle.html` is inserted verbatim and every mark has to be keyboard-reachable, and a
 * symbol layer is neither.
 */
interface PreparedRender {
  readonly trackLines: EngineFeatureCollection;
  readonly draft: EngineFeatureCollection;
  /** Marks the track contributes, kept apart from the events' so neither strands the other. */
  readonly trackMarks: readonly PreparedMark[];
  readonly eventMarks: readonly PreparedMark[];
  /** A copy of the coordinate, never the caller's fix. */
  readonly live: Position2D | null;
}

interface PreparedMark {
  readonly key: string;
  readonly lngLat: Position2D;
  readonly style: MarkerStyle;
  readonly eventId?: Id;
}

function emptyRender(): PreparedRender {
  return {
    trackLines: emptyCollection(),
    draft: emptyCollection(),
    trackMarks: [],
    eventMarks: [],
    live: null,
  };
}

/**
 * Start, finish and lap marks for a track, in the order they occur along it.
 *
 * Every consumer callback runs here, before a single marker is touched. A presentation that
 * throws half way through therefore throws before anything was reconciled — which is a
 * stronger guarantee than transactional stored state, and the one the DOM needs: a mark that
 * had already been rebuilt would have lost its focus whatever the stored state then said.
 *
 * A callback returning `null` suppresses the mark. That is a decision, not an absence: a
 * consumer saying "no start mark on this track" gets no start mark, rather than the engine's.
 */
function trackMarks(track: Track | null, presentation: EventPresentation | null): PreparedMark[] {
  if (track === null) return [];
  const marks: PreparedMark[] = [];

  for (const feature of buildTrackEndpointFeatures(track).features) {
    const start = feature.properties.kind === "track-start";
    const supplied = start ? presentation?.startMarker : presentation?.finishMarker;
    const style = supplied === undefined ? undefined : supplied.call(presentation, track);
    if (style === null) continue;
    marks.push(pointMark(feature, start ? "start" : "finish", style));
  }

  for (const [index, feature] of buildLapFeatures(track).features.entries()) {
    const lap = track.laps?.[index];
    const supplied = presentation?.lapMarker;
    const style =
      supplied === undefined || lap === undefined
        ? undefined
        : supplied.call(presentation, lap, track);
    if (style === null) continue;
    // Keyed by the lap's own id, not its position: inserting or removing an earlier lap
    // would otherwise hand a focused element to a different lap and move it there.
    marks.push({
      ...pointMark(feature, "lap", style),
      key: `lap:${track.id}:${feature.properties.lapId ?? "unidentified"}`,
    });
  }
  return marks;
}

function pointMark(
  feature: PointFeature,
  kind: "start" | "finish" | "lap",
  supplied: MarkerStyle | undefined,
): PreparedMark {
  return {
    key: `${feature.properties.kind}:${feature.properties.trackId}`,
    lngLat: feature.geometry.coordinates,
    style:
      supplied === undefined
        ? builtInMark(kind, feature.properties.label)
        : snapshotMarkerStyle(supplied),
  };
}

/** A mark per event, keyed by event id so a re-render of the same events is stable. */
function eventMarks(
  events: readonly MapEvent[],
  presentation: EventPresentation | null,
): PreparedMark[] {
  return events.map((event) => ({
    key: `event:${event.id}`,
    eventId: event.id,
    lngLat: [event.position.lng, event.position.lat] as Position2D,
    style:
      presentation === null
        ? builtInMark("event")
        : snapshotMarkerStyle(presentation.marker(event)),
  }));
}

/** Consumer line styling, folded into each segment feature so one layer can read it. */
function styledTrackLines(
  track: Track | null,
  presentation: EventPresentation | null,
): EngineFeatureCollection {
  if (track === null) return emptyCollection();
  const built = buildTrackLineFeatures(track);
  const supplied = presentation?.trackLine;
  if (supplied === undefined) return built;

  return {
    type: "FeatureCollection",
    features: built.features.map((feature) => {
      const style: TrackLineStyle = snapshotLineStyle(
        supplied.call(presentation, track, feature.properties.segmentIndex),
      );
      return {
        ...feature,
        properties: {
          ...feature.properties,
          ...(style.color === undefined ? {} : { lineColor: style.color }),
          ...(style.widthPx === undefined ? {} : { lineWidthPx: style.widthPx }),
          ...(style.opacity === undefined ? {} : { lineOpacity: style.opacity }),
          ...(style.dashed === undefined ? {} : { lineDashed: style.dashed }),
        },
      };
    }),
  };
}

/**
 * The draft as a line plus its vertices, from one source.
 *
 * A single point is a vertex and no line, for the same reason a singleton segment is: a
 * `LineString` needs two positions, and an invalid one is either rejected or drawn as
 * nothing.
 */
function draftFeatures(points: readonly DraftTrackPoint[] | null): EngineFeatureCollection {
  if (points === null || points.length === 0) return emptyCollection();

  const coordinates: Position2D[] = points.map((point) => [point.lng, point.lat]);
  const features: EngineFeature[] = coordinates.map((coordinate, index) => ({
    type: "Feature",
    geometry: { type: "Point", coordinates: coordinate },
    properties: { kind: "draft-vertex", index },
  }));

  if (coordinates.length > 1) {
    features.unshift({
      type: "Feature",
      geometry: { type: "LineString", coordinates },
      properties: { kind: "draft-line" },
    });
  }
  return { type: "FeatureCollection", features };
}

/** The bounding box of every point in a track, or `null` for a track with none. */
export function trackBounds(track: Track): BBox | null {
  const first = track.points[0];
  if (first === undefined) return null;

  let west = first.lng;
  let east = first.lng;
  let south = first.lat;
  let north = first.lat;
  for (const point of track.points) {
    if (point.lng < west) west = point.lng;
    if (point.lng > east) east = point.lng;
    if (point.lat < south) south = point.lat;
    if (point.lat > north) north = point.lat;
  }
  return [west, south, east, north];
}

/**
 * A mark on the map: the renderer's marker, the element it wraps, and the anchor it was
 * built with — which cannot be changed afterwards, so it decides whether reuse is possible.
 */
interface PlacedMarker {
  readonly marker: MarkerHandle;
  readonly element: HTMLElement;
  readonly anchor: "center" | "bottom";
  readonly activation: { eventId: Id | null; lngLat: Position2D };
}

/**
 * Freeze a snapshot all the way down, before any consumer callback can see it.
 *
 * The canonical snapshot is what every later `setPresentation` re-derives from, and it is
 * handed to consumer callbacks as their `track` argument. A callback that mutates it would
 * corrupt two things at once: the map it is currently producing — geometry read before the
 * callback disagreeing with marks read after — and every future presentation change, which
 * would re-derive from the mutation.
 *
 * Frozen rather than cloned per call. A second clone would isolate each pass at O(points)
 * each time, while freezing costs that once and makes the mutation *loud*: assigning to a
 * frozen property throws in strict mode, which module code always is. The engine never
 * mutates these, so nothing legitimate is constrained.
 */
function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

/** Padding used when framing a track, so its endpoints are not flush against the edge. */
const FIT_PADDING_PX = 40;

/** The complete renderer contract published by `@mapatlas/maplibre`. */
export interface MapController {
  setSources(sources: TileSource[]): void;
  setTerrain(terrain: TerrainOptions | null): void;
  setPresentation(presentation: EventPresentation | null): void;
  renderTrack(track: Track | null): void;
  renderEvents(events: MapEvent[]): void;
  renderDraft(points: DraftTrackPoint[] | null): void;
  showLivePosition(point: TrackPoint | null): void;
  fitTrack(track: Track): void;
  fitBounds(bbox: BBox, paddingPx?: number): void;
  recenter(to: LatLng, zoom?: number): void;
  onMapTap(cb: (at: LatLng) => void): () => void;
  onEventClick(cb: (id: Id) => void): () => void;
  /** Enter vertex-editing interaction; the returned fn exits it, and is idempotent. */
  enterDrawMode(handlers: DrawModeHandlers): () => void;
  destroy(): void;
}

export interface MapControllerOptions {
  container: HTMLElement;
  /** Ordered base → overlays. Draw order is this order. */
  sources: TileSource[];
  style?: string | JSONValue;
  terrain?: TerrainOptions | null;
  presentation?: EventPresentation;
  center?: LatLng;
  zoom?: number;
  /** Engine-owned and neutral; never a library default. (ADR-0008) */
  attributionPrefix?: string;
}

export function createMapControllerInternal(
  options: MapControllerOptions,
  environment: MapEnvironment,
): MapController {
  // Before the map exists. A stack that cannot be translated is rejected without leaving a
  // WebGL context behind for a controller the caller never receives.
  assertStyleLeavesTheNamespaceAlone(options.style);
  let preparedSources = prepareSources(options.sources);
  let desiredTerrain = prepareTerrain(options.terrain ?? null, preparedSources);

  const map: MapLike = environment.createMap({
    container: options.container,
    style: options.style ?? EMPTY_STYLE,
    ...(options.center === undefined
      ? {}
      : { center: [options.center.lng, options.center.lat] as [number, number] }),
    ...(options.zoom === undefined ? {} : { zoom: options.zoom }),
    attributionControl: {
      customAttribution:
        options.attributionPrefix === undefined
          ? [...NO_CUSTOM_ATTRIBUTION]
          : [options.attributionPrefix],
    },
  });

  /**
   * What the map shows for the **consumer's** stack, so teardown removes exactly what was
   * added. Engine sources and layers are tracked nowhere: they are installed once, never
   * removed, and their presence is asked of the map.
   */
  let installed: BuiltTileSource[] = [];

  /**
   * Track geometry, marks and draft, translated at the call.
   *
   * Nothing the caller owns is kept. `renderTrack` stores the marks it derived rather than
   * the track, so a later `renderEvents` rebuilds nothing from a `Track` the caller may have
   * mutated in between — which would move a mark, or make it disagree with the line already
   * prepared from the same track.
   */
  /**
   * Snapshots of what the engine was last asked to draw, so a presentation change can be
   * applied to it without rereading anything the caller still holds.
   *
   * Deep copies, taken at the call. Retaining the caller's `Track` would reintroduce the
   * aliasing T4.3 removed — a mutation between `renderTrack` and `setPresentation` would
   * silently move marks — and the presentation callbacks need these objects, so a projection
   * is not enough here.
   */
  let trackSnapshot: Track | null = null;
  let eventsSnapshot: readonly MapEvent[] = [];
  let draftSnapshot: readonly DraftTrackPoint[] | null = null;
  let presentation: EventPresentation | null = options.presentation ?? null;

  let render: PreparedRender = emptyRender();
  /** Placed markers by key, so a re-render updates the ones that stayed rather than churning. */
  let markers = new Map<string, PlacedMarker>();
  let liveMarker: PlacedMarker | null = null;

  /**
   * The one draw-mode session, if any.
   *
   * One at a time. Two would leave two sets of listeners and two claims on the map's pan
   * behaviour, and whichever exited last would decide what panning ends up as — ownership
   * nobody could reason about, so a second entry is refused instead.
   */
  let drawSession: DrawSession | null = null;
  const mapTapListeners = new Set<(at: LatLng) => void>();
  const eventClickListeners = new Set<(id: Id) => void>();
  let loaded = false;
  let destroyed = false;

  function reconcile(): void {
    // Nothing here can fail on the sources or the terrain: both were validated when the
    // caller handed them over. This function only applies what was already prepared.
    const { built, needsPmtiles } = preparedSources;

    // Before adding, and only when something actually needs it: a consumer with no PMTiles
    // source never constructs a Protocol and never touches the MapLibre global.
    if (needsPmtiles) ensurePmtilesProtocol(environment.protocolRegistrar);

    // 1. Release terrain first. It references a DEM source that is about to be removed, and
    //    MAP-ATLAS treats terrain as a dependency of the sources it names.
    //
    //    Asked of the map rather than remembered. Applied terrain is not always terrain this
    //    controller applied: a base `style` may declare its own, which MapLibre honours as
    //    the style loads. A mirrored flag would start wrong in that case and stay wrong,
    //    leaving style terrain running under a controller that believes it has none.
    if (map.getTerrain() !== null) map.setTerrain(null);

    // 2. Engine state, once. Before the consumer layers, because they are inserted *below*
    //    its first layer and MapLibre rejects a `beforeId` that is not in the style yet.
    installEngineState();

    // 3. Layers before sources, for the same reason one step down. The reverse order would
    //    leave the map with layers pointing at nothing.
    for (const entry of installed) for (const layer of entry.layers) map.removeLayer(layer.id);
    for (const entry of installed) map.removeSource(entry.id);
    installed = [];

    // 4. Declared order, because MapLibre draws layers in the order they are added: the
    //    stack a consumer describes is the stack they get. Every one goes *below* the engine
    //    anchor, so a replaced basemap cannot land on top of the track it sits beneath.
    for (const entry of built) {
      map.addSource(entry.id, entry.source);
      for (const layer of entry.layers) map.addLayer(layer, ENGINE_LAYER_ANCHOR);
      installed.push(entry);
    }

    // 5. Terrain last, once the DEM it names is back in the style.
    applyTerrain();

    // 6. And whatever the engine was asked to draw, which survives every stack replacement.
    applyRender();
  }

  /**
   * Install the engine's own sources and layers, once per style.
   *
   * Asked of the map rather than remembered, for the reason the terrain fix established: a
   * flag records what this controller did, while the map records what is true.
   *
   * Each id is checked separately, and deliberately so. Gating the whole install on the
   * anchor's presence reads "the anchor exists" as "the engine owns this map" — and a base
   * style that happens to declare one reserved id would then skip *every* source and layer,
   * leaving a map with no track and nothing to say why. Per-id installation degrades into a
   * loud duplicate-id error from the renderer instead, which is the correct outcome for a
   * collision this controller cannot prevent.
   */
  function installEngineState(): void {
    for (const [id, source] of ENGINE_SOURCES) {
      if (installedSources.has(id)) continue;
      // A style that brought this id makes the renderer throw a duplicate-source error here,
      // which is the right outcome: loud, and attributable.
      map.addSource(id, source);
      installedSources.add(id);
    }
    for (const layer of ENGINE_LAYERS) {
      if (installedLayers.has(layer.id)) continue;
      if (map.getLayer(layer.id) !== undefined) {
        // Present, but not ours. Skipping would *adopt* it: the reserved id would count as
        // installed while the layer behind it draws something else entirely, and the engine
        // would write track geometry to a source nothing renders — a blank map, reported by
        // nobody. A collision the controller cannot prevent is one it must not hide.
        throw new MapNamespaceCollisionError(layer.id);
      }
      map.addLayer(layer);
      installedLayers.add(layer.id);
    }
  }

  /**
   * What this controller installed.
   *
   * Ownership is tracked rather than inferred from presence. `getLayer` answers "is there a
   * layer with this id", which is not the same question as "is this layer mine", and reading
   * one as the other is what let a remote style's layer be adopted.
   */
  const installedSources = new Set<string>();
  const installedLayers = new Set<string>();

  /** Push prepared geometry into the persistent sources, and reconcile the marker set. */
  function applyRender(): void {
    map.setSourceData(ENGINE_SOURCE.track, render.trackLines);
    map.setSourceData(ENGINE_SOURCE.draft, render.draft);

    const next = new Map<string, PlacedMarker>();
    for (const mark of [...render.trackMarks, ...render.eventMarks]) {
      const existing = markers.get(mark.key);
      if (existing !== undefined) markers.delete(mark.key);
      next.set(mark.key, place(mark, existing));
    }
    for (const stale of markers.values()) stale.marker.remove();
    markers = next;

    applyLivePosition();
  }

  /**
   * Put one mark on the map, reusing the element behind it where that is safe.
   *
   * Reuse keeps focus: recreating the element would drop it, and a keyboard user is exactly
   * who would be holding it when a track updates underneath them. But keeping the element
   * must not mean keeping what it says — a lap renamed between renders would announce its
   * old name indefinitely — so the style is reapplied every time.
   *
   * `anchor` is the one thing a refresh cannot change: MapLibre fixes it when the marker is
   * constructed. So reuse turns on **identity and anchor together** — same key and same
   * anchor reuses; same key with a different anchor rebuilds, because there is nothing to
   * update. That is the only property treated this way: a changed class, colour, size, name
   * or markup is a refresh, not a rebuild, and rebuilding for those would throw away focus
   * for no reason.
   *
   * T4.3 could not reach this branch — every built-in mark's anchor follows from its kind, so
   * a key that reused an element always described the same kind of mark. A consumer-supplied
   * presentation ends that guarantee, which is why the branch belongs here and not there.
   */
  function place(mark: PreparedMark, existing: PlacedMarker | undefined): PlacedMarker {
    const [lng, lat] = mark.lngLat;
    const anchor = mark.style.anchor ?? "bottom";

    if (existing !== undefined && existing.anchor === anchor) {
      applyMarkerStyle(existing.element, mark.style);
      existing.marker.setLngLat(lng, lat);
      existing.activation.eventId = mark.eventId ?? null;
      existing.activation.lngLat = [lng, lat];
      return existing;
    }
    existing?.marker.remove();

    const activation = { eventId: mark.eventId ?? null, lngLat: [lng, lat] as Position2D };
    const element = createMarkerElement(
      environment.document,
      mark.style,
      mark.eventId === undefined
        ? undefined
        : (event) => {
            // Pointer taps obey one priority order. An overlapping draft vertex claims the
            // activation first; otherwise this event mark claims it. The wrapper stops the
            // native click before MapLibre can also synthesize a map tap from it.
            if (
              event.type === "click" &&
              drawSession?.activateVertexAt({
                lat: activation.lngLat[1],
                lng: activation.lngLat[0],
              }) === true
            ) {
              return;
            }
            if (activation.eventId === null) return;
            for (const listener of eventClickListeners) listener(activation.eventId);
          },
    );
    const marker = environment.createMarker(element, { anchor });
    marker.setLngLat(lng, lat);
    marker.addTo(map);
    const placed: PlacedMarker = {
      marker,
      element,
      anchor,
      activation,
    };
    return placed;
  }

  function applyLivePosition(): void {
    if (render.live === null) {
      liveMarker?.marker.remove();
      liveMarker = null;
      return;
    }
    const [lng, lat] = render.live;
    liveMarker = place(
      { key: "live", lngLat: [lng, lat], style: builtInMark("live") },
      liveMarker ?? undefined,
    );
  }

  /** Re-translate everything the engine draws, then apply it if the map can take it. */
  function prepareRender(next: Partial<PreparedRender>): void {
    render = { ...render, ...next };
    if (loaded) applyRender();
  }

  function applyTerrain(): void {
    if (desiredTerrain === null) {
      // Only if something is actually applied: `setTerrain(null)` on a map with no terrain
      // is a call that says nothing, and it would show up in every operation log. Asking the
      // map rather than a remembered flag is what makes "no terrain" authoritative — it
      // clears a base style's terrain too, which the controller never applied but does own.
      if (map.getTerrain() !== null) map.setTerrain(null);
      return;
    }
    // Replacing terrain needs no `null` between: MapLibre takes a new definition directly.
    // The explicit release in `reconcile` exists for the other case — the DEM disappearing.
    map.setTerrain({ source: desiredTerrain.source, exaggeration: desiredTerrain.exaggeration });
  }

  function onLoad(): void {
    // Once. `preparedSources` and `desiredTerrain` are read here rather than captured
    // anywhere earlier, so whatever the consumer last asked for is what gets installed.
    if (loaded || destroyed) return;
    loaded = true;
    reconcile();
  }

  function onMapClick(event: MapPointerEvent): void {
    // Draw mode owns every canvas tap while active: a vertex click or an add is one action,
    // never also a general map tap. Event markers do not reach this listener at all because
    // their native wrapper activation stops before MapLibre synthesizes a map click.
    if (drawSession !== null) return;
    for (const listener of mapTapListeners) {
      // Each subscriber gets its own boundary value. One callback mutating a mutable LatLng
      // must not change what a later callback observes from the same renderer event.
      listener({ lat: event.lngLat.lat, lng: event.lngLat.lng });
    }
  }

  function frameBounds(bounds: BBox, paddingPx: number): void {
    map.fitBounds(bounds, paddingPx, !environment.prefersReducedMotion());
  }

  map.on("load", onLoad);
  map.on("click", onMapClick);

  return {
    setSources(sources: TileSource[]): void {
      if (destroyed) throw new MapControllerDestroyedError("setSources");
      // Translate *and* re-check the standing terrain against the prospective stack before
      // storing either. A stack that would orphan terrain is rejected here rather than
      // silently dropping it, so "either throws or is guaranteed installable" stays true of
      // the pair, not just of the sources. Nothing is assigned until both pass.
      const nextSources = prepareSources(sources);
      const nextTerrain = prepareTerrain(
        desiredTerrain === null
          ? null
          : { sourceId: desiredTerrain.source, exaggeration: desiredTerrain.exaggeration },
        nextSources,
      );

      preparedSources = nextSources;
      desiredTerrain = nextTerrain;
      if (loaded) reconcile();
    },

    setTerrain(terrain: TerrainOptions | null): void {
      if (destroyed) throw new MapControllerDestroyedError("setTerrain");
      // Validated against desired sources, not against what the map currently holds — which
      // before `load` is nothing at all.
      desiredTerrain = prepareTerrain(terrain, preparedSources);
      if (loaded) applyTerrain();
    },

    renderTrack(track: Track | null): void {
      if (destroyed) throw new MapControllerDestroyedError("renderTrack");
      // Snapshot first, then prepare from the snapshot — so what the presentation sees, and
      // what a later `setPresentation` re-derives from, is the same immutable thing.
      const snapshot = track === null ? null : deepFreeze(structuredClone(track) as Track);
      // Prepared before either is committed: a presentation callback that throws leaves the
      // previous track and its marks exactly as they were.
      const lines = styledTrackLines(snapshot, presentation);
      const marks = trackMarks(snapshot, presentation);

      trackSnapshot = snapshot;
      prepareRender({ trackLines: lines, trackMarks: marks });
    },

    renderEvents(events: MapEvent[]): void {
      if (destroyed) throw new MapControllerDestroyedError("renderEvents");
      const snapshot = deepFreeze(structuredClone(events) as MapEvent[]);
      const marks = eventMarks(snapshot, presentation);

      eventsSnapshot = snapshot;
      prepareRender({ eventMarks: marks });
    },

    setPresentation(next: EventPresentation | null): void {
      if (destroyed) throw new MapControllerDestroyedError("setPresentation");
      // Every callback runs here, against what is already desired, and **all of it completes
      // before anything is committed or reconciled**. Transactional stored state would not be
      // enough: a marker rebuilt before a later callback threw has already lost its focus,
      // whatever the stored state says afterwards.
      const lines = styledTrackLines(trackSnapshot, next);
      const marks = trackMarks(trackSnapshot, next);
      const events = eventMarks(eventsSnapshot, next);

      presentation = next;
      prepareRender({ trackLines: lines, trackMarks: marks, eventMarks: events });
    },

    renderDraft(points: DraftTrackPoint[] | null): void {
      if (destroyed) throw new MapControllerDestroyedError("renderDraft");
      const snapshot = points === null ? null : points.map((point) => ({ ...point }));
      draftSnapshot = snapshot;
      prepareRender({ draft: draftFeatures(snapshot) });
      drawSession?.renderDraft(snapshot);
    },

    showLivePosition(point: TrackPoint | null): void {
      if (destroyed) throw new MapControllerDestroyedError("showLivePosition");
      // The coordinate, copied — not the fix. A recorder that reuses one point object per
      // update would otherwise move a mark that was never asked to move.
      prepareRender({ live: point === null ? null : [point.lng, point.lat] });
    },

    fitTrack(track: Track): void {
      if (destroyed) throw new MapControllerDestroyedError("fitTrack");
      // A track with no points has no extent to frame. Moving the camera to an invented one
      // would be worse than leaving it where the user put it.
      const bounds = trackBounds(track);
      if (bounds !== null) frameBounds(bounds, FIT_PADDING_PX);
    },

    fitBounds(bbox: BBox, paddingPx?: number): void {
      if (destroyed) throw new MapControllerDestroyedError("fitBounds");
      frameBounds(bbox, paddingPx ?? FIT_PADDING_PX);
    },

    recenter(to: LatLng, zoom?: number): void {
      if (destroyed) throw new MapControllerDestroyedError("recenter");
      // Camera moves apply immediately rather than waiting for `load`: a map has a transform
      // from the moment it exists, and a consumer who recenters before the style resolves
      // means it now, not eventually.
      const camera =
        zoom === undefined
          ? { center: [to.lng, to.lat] as [number, number] }
          : { center: [to.lng, to.lat] as [number, number], zoom };
      if (environment.prefersReducedMotion()) map.jumpTo(camera);
      else map.easeTo(camera);
    },

    onMapTap(cb: (at: LatLng) => void): () => void {
      if (destroyed) throw new MapControllerDestroyedError("onMapTap");
      mapTapListeners.add(cb);
      return () => mapTapListeners.delete(cb);
    },

    onEventClick(cb: (id: Id) => void): () => void {
      if (destroyed) throw new MapControllerDestroyedError("onEventClick");
      eventClickListeners.add(cb);
      return () => eventClickListeners.delete(cb);
    },

    enterDrawMode(handlers: DrawModeHandlers): () => void {
      if (destroyed) throw new MapControllerDestroyedError("enterDrawMode");
      if (drawSession !== null) {
        throw new MapDrawModeError(
          "a session is already active; exit it before entering again, or two sets of " +
            "listeners would each claim the map's pan behaviour",
        );
      }
      const session = startDrawMode(map, environment, options.container, draftSnapshot, handlers);
      drawSession = session;
      return () => {
        session.exit();
        // Only clears the slot if this session still owns it, so an exit called late cannot
        // silently retire a session someone else started afterwards.
        if (drawSession === session) drawSession = null;
      };
    },

    destroy(): void {
      // Idempotent, and deliberately silent about the PMTiles protocol: `addProtocol`
      // installs on the MapLibre runtime rather than on this map, so unregistering it would
      // break every other controller in the realm. (ADR-0023, and the T4.1b bootstrap.)
      if (destroyed) return;
      destroyed = true;
      // The same idempotent cleanup an explicit exit runs: interaction is borrowed, and a
      // destroyed controller must not leave listeners or a disabled pan behind it.
      drawSession?.exit();
      drawSession = null;
      map.off("load", onLoad);
      map.off("click", onMapClick);
      mapTapListeners.clear();
      eventClickListeners.clear();
      installed = [];
      // Markers live in the DOM outside MapLibre's container-emptying, so they are removed
      // explicitly rather than left behind as orphaned nodes holding listeners.
      for (const placed of markers.values()) placed.marker.remove();
      markers = new Map();
      liveMarker?.marker.remove();
      liveMarker = null;
      map.remove();
    },
  };
}
