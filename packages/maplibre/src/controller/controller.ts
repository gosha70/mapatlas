// SPDX-License-Identifier: Apache-2.0

import type { JSONValue, LatLng, TerrainOptions, TileSource, TileSourceKind } from "@mapatlas/core";

import type { BuiltTileSource } from "../builders/tile-source.js";
import { buildTileSources, usesPmtiles } from "../builders/tile-source.js";
import { ensurePmtilesProtocol } from "../protocols/pmtiles.js";
import type { MapEnvironment, MapLike } from "./environment.js";

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

function prepareSources(sources: readonly TileSource[]): PreparedSources {
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

/** The part of `MapController` delivered so far. Widened by T4.3 (track and events). */
export interface MapControllerCore {
  setSources(sources: TileSource[]): void;
  setTerrain(terrain: TerrainOptions | null): void;
  destroy(): void;
}

export interface MapControllerOptions {
  container: HTMLElement;
  /** Ordered base → overlays. Draw order is this order. */
  sources: TileSource[];
  style?: string | JSONValue;
  terrain?: TerrainOptions | null;
  center?: LatLng;
  zoom?: number;
  /** Engine-owned and neutral; never a library default. (ADR-0008) */
  attributionPrefix?: string;
}

export function createMapControllerInternal(
  options: MapControllerOptions,
  environment: MapEnvironment,
): MapControllerCore {
  // Before the map exists. A stack that cannot be translated is rejected without leaving a
  // WebGL context behind for a controller the caller never receives.
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

  /** What the map does show, so teardown removes exactly what was added. */
  let installed: BuiltTileSource[] = [];
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

    // 2. Layers before sources, for the same reason one step down. The reverse order would
    //    leave the map with layers pointing at nothing.
    for (const entry of installed) for (const layer of entry.layers) map.removeLayer(layer.id);
    for (const entry of installed) map.removeSource(entry.id);
    installed = [];

    // 3. Declared order, because MapLibre draws layers in the order they are added: the
    //    stack a consumer describes is the stack they get.
    for (const entry of built) {
      map.addSource(entry.id, entry.source);
      for (const layer of entry.layers) map.addLayer(layer);
      installed.push(entry);
    }

    // 4. Terrain last, once the DEM it names is back in the style.
    applyTerrain();
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

  map.on("load", onLoad);

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

    destroy(): void {
      // Idempotent, and deliberately silent about the PMTiles protocol: `addProtocol`
      // installs on the MapLibre runtime rather than on this map, so unregistering it would
      // break every other controller in the realm. (ADR-0023, and the T4.1b bootstrap.)
      if (destroyed) return;
      destroyed = true;
      map.off("load", onLoad);
      installed = [];
      map.remove();
    },
  };
}
