<!-- SPDX-License-Identifier: Apache-2.0 -->

# MAP-ATLAS — Decision log (ADRs)

Append a new entry when you make a consequential, hard-to-reverse choice. Keep entries
short: context → decision → consequences. Newest at the bottom.

---

## ADR-0001 — Domain-agnostic engine, consumers own the domain
**Context.** The project began as the reusable core of a fishing app (HookAtlas). The value
is reuse across domains (fishing, foraging, surveying).
**Decision.** MAP-ATLAS contains **no** domain knowledge. Domain data rides in neutral bags
(`tags`, `category`, `fields`) and behind interfaces (`MediaAnalyzer`). Dependencies point one
way: consumers → engine, never the reverse.
**Consequences.** Enforced by a CI import/token scan. Enables the open-core model (engine
public; domain + privacy private in the consumer). Slightly more indirection than a bespoke app.

## ADR-0002 — Leaflet renderer now; MapLibre possible later
**Context.** Dynamic content is one track + a few markers; expected overlays (nautical charts,
seamarks) are raster; target is all-day mobile battery.
**Decision.** Ship a Leaflet renderer (`@mapatlas/leaflet`). Keep `core` renderer-agnostic so a
MapLibre sibling can be added without touching `core`. PMTiles (ADR-0004) is renderer-neutral.
**Consequences.** Lighter/faster for the expected load; a future vector-basemap need is a new
package, not a rewrite.

## ADR-0003 — TrackRecorder is a seam; v1 ships web (foreground) only
**Context.** Reliable background GPS (screen-locked) is impossible in a pure web app on iOS; it
needs a native shell (Capacitor/Cordova) with a background-geolocation plugin.
**Decision.** Define `TrackRecorder` as an interface; ship `createWebTrackRecorder`
(`watchPosition` + Wake Lock, foreground) in v1. A native recorder is an out-of-tree adapter a
consumer injects.
**Consequences.** The engine stays browser-only and dependency-light; background tracking is an
additive package, so the hard native problem never blocks the core.

## ADR-0004 — Offline map imagery via PMTiles regions
**Context.** Off-grid use needs pre-downloaded basemap tiles; MBTiles needs a server, public
tile hosts are unreliable.
**Decision.** `OfflineRegionStore` backed by PMTiles (single-file, range-request, renderer-neutral).
User data offline is a separate concern (`StorageAdapter`, IndexedDB default).
**Consequences.** Simple per-region size accounting/eviction; consumers must drive install +
`storage.persist()` on iOS. No tiles are bundled in the repo.

## ADR-0005 — AI analysis is an optional, injected seam (egress boundary)
**Context.** Consumers want photo ID (fish, plants, mushrooms) but with different models, and
some want on-device (offline/private) while others want a remote vision model.
**Decision.** `MediaAnalyzer` interface with `runsRemotely` disclosed; ship only `noopAnalyzer`.
The engine calls `analyze` only on explicit user action and never interprets label meaning.
**Consequences.** No model is bundled; analysis is pluggable and testable; remote egress is
explicit and consumer-gated (see `SECURITY.md`).

## ADR-0006 — Apache-2.0 + DCO, open-core
**Context.** Goal is community contribution flowing back to consumers (incl. a closed, paid one)
without a CLA barrier.
**Decision.** License Apache-2.0 (patent grant, business-friendly). Accept contributions under
the DCO (`git commit -s`), no CLA. SPDX header on every source file.
**Consequences.** Max adoption/contribution; the engine is freely embeddable in proprietary
consumers; contributions arrive under the same permissive terms.

## ADR-0007 — Privacy transforms are the consumer's job
**Context.** Raw tracks are highly sensitive; different consumers need different sharing rules.
**Decision.** The engine exposes **raw** primitives (full-resolution tracks/points) and applies
**no** coarsening/fuzzing/trimming itself. Any privacy transform before data leaves a device is
implemented by the consumer.
**Consequences.** The engine stays honest and general; consumers (e.g. HookAtlas's PI-28
track-egress rule) own and test their own privacy guarantees.

## ADR-0008 — `@mapatlas/core` references Web-Platform + GeoJSON standard types
**Context.** The public API in `api.md` uses `Blob` (media bytes in `StorageAdapter`/`AnalyzeInput`)
and `GeoJSON.FeatureCollection` (portability §8). Neither resolves under core's strict base
config (`lib: ["ES2022"]`, `types: []`), yet core must stay framework-agnostic.
**Decision.** Give `@mapatlas/core` `lib: ["ES2022", "DOM"]` and `types: ["geojson"]` (with a
type-only `@types/geojson` dependency). These add **types only** — no runtime, no bundled code.
Framework-agnosticism keeps being enforced at the source level by the import-isolation scan
(T0.5), which still forbids DOM *globals* (`window`/`document`/`navigator`/`localStorage`),
`react`/`react-dom`/`leaflet` imports, and domain tokens. `Blob` and the `GeoJSON` namespace are
neutral Web-Platform standards available in both browsers and modern Node, not consumer-specific.
**Consequences.** Core compiles against the exact `api.md` signatures with zero runtime deps; the
architectural rule is still machine-checked by the scan rather than by the absence of the DOM lib.
Consumers get the `GeoJSON` types transitively via the `@types/geojson` dependency.

## ADR-0009 — GeoJSON portability stores a lossless payload in feature `properties`
**Context.** `trackToGeoJSON`/`geoJSONToTrack` (§8) must round-trip geometry **and** all
non-spatial data (per-fix timestamps/accuracy/speed/heading, `simplified`, `tags`, `meta`,
event `comment`/`category`/`fields`/`analysis`) — none of which fit in bare `[lng, lat]`
coordinates.
**Decision.** Emit standard geometry (track → `LineString`, event → `Point`) for interoperability,
and carry the full structured payload in each feature's `properties` under a `mapatlas:*` `kind`
tag. Per-point metadata rides in a `pointMeta` array parallel to the coordinates. Media travels
**by reference** (`MediaRef` has `blobKey`/`url`, never bytes) plus a collection-level
`mapatlas:manifest` feature (an empty `GeometryCollection`, so the result stays a valid
`GeoJSON.FeatureCollection`). Unknown/manifest features are ignored on import.
**Consequences.** External tools render the geometry; MAP-ATLAS reconstructs losslessly from
`properties`. Blob bytes are the consumer's to export alongside the manifest.

## ADR-0010 — One StorageAdapter conformance suite; in-memory fake is the reference
**Context.** T2.1 wants a reusable adapter test suite runnable against *any* `StorageAdapter`
(the in-memory fake, the IndexedDB default, a consumer's remote/sync store), living in `core`.
The suite must import the test runner (`vitest`), yet `core` must stay a dependency-light,
DOM-free library whose `dist` carries no test tooling.
**Decision.** Ship `runStorageAdapterConformance(name, make)` at
`@mapatlas/core/src/testing/` and **exclude `src/testing/**` from the compiled build**, so
`vitest` never enters `core`'s `dist`; test files import it by source path. Ship
`createMemoryStorageAdapter()` as a first-class, built export — it is both the reference the
suite is proven against (T2.1 AC) and a genuinely useful SSR/preview fallback. The IndexedDB
adapter (`createIdbStorageAdapter`) in `@mapatlas/storage-idb` passes the same suite under
`fake-indexeddb` (T2.2).
**Consequences.** Every adapter is held to one machine-checked contract; adding a store means
adding one `runStorageAdapterConformance(...)` line. The suite is not part of the public
runtime surface (no `vitest` in `dist`); the in-memory adapter is.

## ADR-0011 — The web recorder ships in `@mapatlas/recorder-web`, not `@mapatlas/core`
**Context.** `api.md §2` originally declared `createWebTrackRecorder` under `@mapatlas/core`,
but the recorder's implementation needs `navigator.geolocation` and the Screen Wake Lock.
The import-isolation scan (T0.5) — a hard, non-negotiable gate — forbids the DOM globals
`window`/`document`/`navigator`/`localStorage` in `core`. The two requirements cannot both hold
in one package: a DOM-using recorder in `core` fails the scan.
**Decision.** Keep the *interface* (`TrackRecorder`, `SamplingPolicy`, error types) in `core`,
and ship the *web implementation* in a new DOM-facing package **`@mapatlas/recorder-web`** that
depends on `core`. The public factory keeps its `store?` parameter and gains an optional,
additive `deps?` for injecting a fake `geolocation`/`wakeLock` in tests; both default to the
ambient `navigator` resolved lazily at `start()` (construction stays SSR-safe). `api.md §2` is
updated in the same change.
**Consequences.** `core` stays DOM-free and scan-clean; the recorder is fully unit-tested with
fakes (no live hardware); consumers add one dependency to get the v1 recorder. It mirrors
ADR-0003 (native background recorders are also out-of-tree adapters implementing the same seam)
and matches the layering already used for `@mapatlas/leaflet`/`@mapatlas/react`.

## ADR-0012 — Photo-bearing components take an optional `store`; SSR loads Leaflet lazily
**Context.** T5.3/T5.4: `<EventComposer>` captures photo *bytes* and `<TripReview>` displays
them, but the `api.md §7` signatures carried no persistence handle — so media could only live
as in-memory object URLs that do not survive a reload, defeating the offline durability the
demo (T7.1) must prove. Separately, `<MapCanvas>` must be SSR-safe, yet Leaflet reads `window`
the moment it is imported.
**Decision.** Add an **optional, additive** `store?: StorageAdapter` prop to `<EventComposer>`
(captured photos persist via `putBlob` → `blobKey`; without a store, object URLs) and to
`<TripReview>` (resolves `blobKey` previews). Load `@mapatlas/leaflet` with a **dynamic
`import()` inside `<MapCanvas>`'s mount effect** — the only static reference is a type-only
import (erased) — so importing `@mapatlas/react` on a server never evaluates Leaflet. `api.md §7`
is updated in the same change. The hook return objects use `T | undefined` fields (read-compatible
with the `?:` optionals in `api.md`).
**Consequences.** Media is durable when a store is supplied (the demo does), the components stay
usable store-free, and the React entry point imports cleanly under SSR (verified by a node-env
test). No public interface was removed or changed — only additive optionals.
