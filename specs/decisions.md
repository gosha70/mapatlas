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
**Status.** Superseded by ADR-0008 (renderer is MapLibre GL).

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


## ADR-0008 — Renderer is MapLibre GL (supersedes ADR-0002)
**Context.** The renderer was originally Leaflet (ADR-0002; raster/DOM). Target consumers
include marine/outdoor apps that need rich graphics and **water-depth (bathymetry) styling**,
which raster Leaflet renders poorly. ADR-0002 always anticipated a vector renderer as a sibling.
**Decision.** Ship the renderer as **MapLibre GL** (`@mapatlas/maplibre`): vector tiles, GPU
rendering, smooth zoom, and first-class vector bathymetry/depth styling (e.g. MapTiler Ocean or
a self-hosted vector basemap). `core` stays renderer-agnostic and the `MapController` contract
(api.md §6) is unchanged; Leaflet-specific details (DivIcon markers, raster TileLayer stacking)
become MapLibre equivalents (HTML/symbol markers, style layers). PMTiles (ADR-0004) works with
either.
**Dependency criterion (general).** A third-party dependency must not inject political or
editorial content into the product's default UI. Any library whose defaults include
branding/attribution must let those be overridden, and the engine sets a **neutral, brandable**
attribution prefix explicitly rather than inheriting a library's built-in default. (This rule is
about a dependency's *behaviour in the product*; it is a technical/neutrality criterion, not a
judgement about a project's authors.)
**Consequences.** Richer graphics + bathymetry; higher GPU/battery cost than Leaflet (acceptable
for the value); a raster renderer can still be added later as a sibling without touching `core`.
