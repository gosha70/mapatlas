// SPDX-License-Identifier: Apache-2.0

import type { JSONValue } from "@mapatlas/core";
import type { LayerSpecification, SourceSpecification, TerrainSpecification } from "maplibre-gl";

import type { ProtocolRegistrar } from "../protocols/pmtiles.js";

/**
 * Everything the controller needs from MapLibre, in one injectable place.
 *
 * Deliberately **not** part of `MapControllerOptions`: how a map is constructed and how a
 * protocol is registered are implementation machinery, and putting them in `api.md` would
 * mean owning their shapes indefinitely for the benefit of nobody who consumes the engine.
 * The internal factory takes one of these; the exported one supplies the real MapLibre.
 *
 * The same seam is what makes the source-stack lifecycle testable at all. A real map needs
 * a WebGL context and only tells you it is ready by firing `load`; a fake tells you exactly
 * which calls arrived, in what order, and lets a test choose when `load` happens.
 */

/**
 * The part of MapLibre's `Map` the controller actually uses.
 *
 * `load` is in the seam because it is not optional detail: MapLibre rejects `addSource` and
 * `addLayer` before the style is ready, so the controller's whole install path hangs off
 * that one event. A fake without it could only test the easy half.
 */
export interface MapLike {
  on(type: "load", listener: () => void): void;
  off(type: "load", listener: () => void): void;
  addSource(id: string, source: SourceSpecification): void;
  removeSource(id: string): void;
  /** Draw order is add order, which is why the controller installs in declared order. */
  addLayer(layer: LayerSpecification): void;
  removeLayer(id: string): void;
  /**
   * Terrain is another consumer of the source stack, exactly as layers are, so it appears
   * on the same seam. `null` disables it — and must be sent before the DEM source it names
   * is removed, or MapLibre refuses the removal.
   */
  setTerrain(terrain: TerrainSpecification | null): void;
  remove(): void;
}

/**
 * What the controller hands MapLibre's constructor.
 *
 * `style` and `attributionControl` are **required** here even though MapLibre makes both
 * optional, because leaving either to the library is a decision the engine has already
 * made differently: a map with no style needs `setStyle()` before it renders anything, and
 * the default attribution control ships MapLibre's own attribution, which ADR-0008 says the
 * engine does not put in a consumer's app.
 */
export interface MapConstructorOptions {
  container: HTMLElement;
  style: string | JSONValue;
  center?: [lng: number, lat: number];
  zoom?: number;
  attributionControl: { customAttribution: string[] };
}

export interface MapEnvironment {
  createMap(options: MapConstructorOptions): MapLike;
  protocolRegistrar: ProtocolRegistrar;
}
