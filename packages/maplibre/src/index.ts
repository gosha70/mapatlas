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
 * Nothing exported here needs a browser, a map, or a registered PMTiles protocol at import
 * time. Runtime capability lives at the controller boundary, which is where its lifecycle
 * is.
 */

/** Package identity, so a consumer can report which engine build it embeds. */
export const PACKAGE_NAME = "@mapatlas/maplibre";
