<!-- SPDX-License-Identifier: Apache-2.0 -->

# `@mapatlas/maplibre`

The MapLibre GL renderer for [MAP-ATLAS](https://github.com/gosha70/mapatlas): the tile-source
stack, terrain, and the track, event and draft geometry the engine draws.

## Install

```sh
npm install @mapatlas/maplibre maplibre-gl@6.6.0
```

`maplibre-gl` is a **peer dependency**, and the range is a single exact version rather than
`^6.6.0`. Every browser test in this repository runs against exactly 6.6.0; a caret would let a
fresh install resolve a 6.x release nothing here has exercised, which is the drift the pin
exists to prevent. Renderer dependencies in MAP-ATLAS carry no ranges — the packaging gate
enforces it.

Two MapLibre copies in one application would be worse than wasteful: `addProtocol` registers a handler on a MapLibre
*module instance*, so a second copy would register PMTiles on a runtime that is not the one
drawing your map, and the archive would silently fail to load. Declaring it as a peer means
your application resolves exactly one.

## Load the stylesheet, and point MapLibre at its worker

```ts
import "maplibre-gl/dist/maplibre-gl.css";

import { setWorkerUrl } from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url"; // Vite

setWorkerUrl(workerUrl);
```

MapLibre loads its worker as a separate module, resolved relative to the **importing chunk**.
Under a bundler that rewrites imports — Vite's optimised dependency chunks, for instance — that
resolution lands beside the rewritten chunk rather than beside the package, and the request
404s. Nothing errors: the map is constructed, the style parses, sources emit `sourcedata`, and
then **nothing is ever painted**, because no tile is ever built.

The engine cannot do this for you: the correct URL depends on your bundler. The syntax above is
Vite's; other bundlers have their own. If your map shows controls and markers but no map, this
is the first thing to check.

This package does **not** import it for you. Injecting global CSS is a decision about your
document rather than ours, and it breaks any application that bundles CSS itself. Without it
MapLibre's own controls are unstyled and — the part that looks like an engine bug rather than a
missing import — map marks lose their absolute positioning and render outside the map.

The peer dependency above is what makes that import resolvable from your application under
strict resolvers (pnpm, Yarn PnP) as well as under npm's hoisting.

## Status

The complete `MapController` contract is available from this package's public surface:

```ts
import { createMapController, type MapController } from "@mapatlas/maplibre";
```

Its event marks and draft vertices are keyboard-operable, camera motion follows
`prefers-reduced-motion`, and draw-mode vertices keep pointer hit-testing on the canvas while a
parallel DOM layer supplies the accessible controls.

## License

Apache-2.0. Downstream tile and data licences are obligations you inherit when you point the
renderer at those sources. OpenStreetMap and OpenSeaMap seamarks are ODbL (share-alike);
**bathymetry and elevation are licensed per product, not per publisher** — terms differ between
datasets from the same agency, and some carry third-party contributions whose terms travel with
them, so check the specific product and its contributor metadata. See
[`SECURITY.md`](https://github.com/gosha70/mapatlas/blob/main/SECURITY.md) and the licensing
rule in `specs/architecture.md`.
