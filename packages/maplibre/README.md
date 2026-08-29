<!-- SPDX-License-Identifier: Apache-2.0 -->

# `@mapatlas/maplibre`

The MapLibre GL renderer for [MAP-ATLAS](https://github.com/gosha70/mapatlas): the tile-source
stack, terrain, and the track, event and draft geometry the engine draws.

## Install

```sh
npm install @mapatlas/maplibre maplibre-gl
```

`maplibre-gl` is a **peer dependency**, not a bundled one. Two copies of MapLibre in one
application do not merely waste bytes — `addProtocol` registers a handler on a MapLibre
*module instance*, so a second copy would register PMTiles on a runtime that is not the one
drawing your map, and the archive would silently fail to load. Declaring it as a peer means
your application resolves exactly one.

## Load the stylesheet

```ts
import "maplibre-gl/dist/maplibre-gl.css";
```

This package does **not** import it for you. Injecting global CSS is a decision about your
document rather than ours, and it breaks any application that bundles CSS itself. Without it
MapLibre's own controls are unstyled and — the part that looks like an engine bug rather than a
missing import — map marks lose their absolute positioning and render outside the map.

The peer dependency above is what makes that import resolvable from your application under
strict resolvers (pnpm, Yarn PnP) as well as under npm's hoisting.

## Status

Phase 4 of the build. `createMapController` is not yet on this package's public surface: it is
exported only once it satisfies the whole `MapController` contract in
[`specs/api.md`](https://github.com/gosha70/mapatlas/blob/main/specs/api.md). A method that
exists and throws "not supported yet" is worse than one that is absent, because you would find
the gap at runtime instead of at compile time.

## License

Apache-2.0. Downstream tile and data licences (OSM/OpenSeaMap ODbL, NOAA public domain) are
obligations you inherit when you point the renderer at those sources — see
[`SECURITY.md`](https://github.com/gosha70/mapatlas/blob/main/SECURITY.md) and the licensing
rule in `specs/architecture.md`.
