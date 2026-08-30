// SPDX-License-Identifier: Apache-2.0

/**
 * `@mapatlas/maplibre` — the MapLibre GL renderer.
 *
 * The **translation** from engine types to MapLibre style objects lives in `./builders`,
 * and it is deliberately *not* exported. It is an implementation detail of the controller:
 * a `TileSource` is the contract a consumer writes against, and MapLibre's own source and
 * layer specifications are what the controller does with it. Publishing the builders would
 * put MapLibre's style types on this package's public surface, where every change to them
 * becomes a breaking change here — and would invite consumers to hand-assemble a style the
 * controller is responsible for.
 *
 * Runtime capability lives at the controller boundary, which is where its lifecycle is — but
 * note what publishing `createMapController` here changed: importing this module now
 * **evaluates the renderer**, because `./controller/browser.js` imports `maplibre-gl` and
 * `pmtiles` as values at module scope. Two things follow for a consumer. A server-side import
 * of the package root evaluates MapLibre in an environment with no `window`; `maplibre-gl`
 * 6.6.0 tolerates that — `index.test.ts` imports this module in Node with no DOM and passes,
 * which is the assertion holding the claim up — but the evaluation is real, and a future
 * version need not tolerate it. And a consumer who wants only the *types* pays nothing extra
 * only if tree-shaking honours this package's `sideEffects: false`, which is accurate: no
 * module here runs anything at import time beyond declaring bindings.
 */

export type { MapController, MapControllerOptions } from "./controller/controller.js";
export { createMapController } from "./controller/browser.js";
export type { DrawModeHandlers } from "./controller/draw-mode.js";
export type { MarkerStyle } from "./marks/marker-style.js";
export type { EventPresentation, TrackLineStyle } from "./marks/presentation.js";

/** Package identity, so a consumer can report which engine build it embeds. */
export const PACKAGE_NAME = "@mapatlas/maplibre";
