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

## ADR-0009 — Telemetry rides on track points as named channels; devices are a seam
**Context.** Workout consumers (Strava/Garmin-class) need heart rate, cadence, and power; marine
and angling consumers need depth and water temperature. All of it is a numeric time series
sampled alongside position, and none of it is GPS. `TrackPoint` had no room for it and no
altitude, so it could not be added later without breaking the data model, storage, and export.
**Decision.** `TrackPoint` gains `altitudeM`/`altitudeAccuracyM` and
`channels?: Record<string, number>` — an open bag of consumer-defined numeric keys, described by
`Track.channels: ChannelDescriptor[]` (`key`, `label`, `unit`, `aggregate`). Devices sit behind a
`SensorSource` seam (`start/stop/onSample`); the recorder merges samples into **kept** points per
a `SensorMergePolicy` (`maxAgeMs`, `reduce`). The engine ships `createPollingSensorSource` (the
neutral primitive for "sample every N seconds") and a fake — **no device driver**, ever.
**Consequences.** Telemetry is domain-neutral by construction: `heartRateBpm` and `depthM` take
the identical code path, and the engine renders a number with a label and a unit without learning
what it measures. `simplify` must preserve channels on kept points, `computeStats` rolls them up,
and GeoJSON export carries per-coordinate channel arrays. A sensor failure is non-fatal — losing a
heart-rate strap must never lose the trip.

## ADR-0010 — A track is one geometry with segment and lap views over it
**Context.** `pause()` existed but `points` was one flat array, so a paused trip rendered as a
straight line across the gap, and laps/splits — table stakes for training and for trip logs —
had nowhere to live. "Stats" was promised by the PRD but only `distanceM` existed, so every
consumer would have re-derived duration, pace, and elevation gain differently.
**Decision.** `Track.segments: TrackSegment[]` (contiguous **active** spans) and
`Track.laps?: TrackLap[]` are **index ranges into `points`**, not copies. The gap between two
segments *is* the pause. `TrackStats` is a defined type (distance, elapsed vs moving time, avg/max
speed, elevation gain/loss, per-channel roll-ups) computed by one shared `computeStats`, used by
recorders, drafts, and import alike. Export becomes a `MultiLineString`, one member per segment.
**Consequences.** No geometry duplication and no drift between views. Renderers draw one line per
segment and never bridge a pause. Elevation gain is hysteresis-filtered so GPS altitude noise does
not inflate it. `distanceM` moves into `stats`.

## ADR-0011 — `TileSource` describes raster, vector, and elevation sources
**Status.** The transport/content portion is superseded by ADR-0023 (`kind` and `transport` are
separate axes). `role`, `encoding`, `TerrainOptions` and the `styleLayers` passthrough stand.
**Context.** ADR-0008 chose MapLibre GL *for* vector styling — bathymetry, and by the same
mechanism topographic contours, hillshade, and 3D terrain. But `TileSource` was still the
raster-era shape inherited from the Leaflet design (`xyz | wms | pmtiles`, no style concept), so
the contract could not express the capability the renderer was chosen for.
**Decision.** `TileSource` gains `kind: "vector" | "raster-dem"`, a `role`
(`base|overlay|terrain|hillshade`), `encoding` for DEMs, and `styleLayers?: JSONValue[]` — renderer
style layers passed through **as opaque JSON**. `MapControllerOptions` gains a base `style`
(document or URL) and `TerrainOptions` (`sourceId`, `exaggeration`).
**Consequences.** Topographic and bathymetric basemaps are expressible, so ADR-0008 pays off.
`core` still imports no renderer types — it forwards style JSON it does not interpret, which keeps
the renderer swappable. `OfflineRegion` gains `sourceIds` so a region can cover a chosen subset.

## ADR-0012 — Event presentation belongs to the consumer, not the renderer
**Context.** The engine deliberately knows nothing about `category`, yet the renderer had to draw
a mark for each event and offered no hook — so "show a custom sign for this kind of feature" was
unbuildable without forking the renderer, and no start/finish marks existed at all.
**Decision.** An `EventPresentation` seam: the consumer maps a `MapEvent` to a `MarkerStyle`, and
optionally styles start, finish, lap marks, and each segment's line. Neutral built-in marks apply
when it is absent. `MarkerStyle.ariaLabel` is **required** — only the consumer knows what a mark
means, so only the consumer can name it for assistive tech.
**Consequences.** The renderer stays domain-blind while consumers get arbitrary iconography. The
engine bundles no icon assets. `MarkerStyle.html` is inserted verbatim, so it is consumer-trusted
markup and must never be built from untrusted input — recorded in `SECURITY.md`.

## ADR-0013 — Package layout: browser implementations live outside `core`
**Context.** `api.md` placed `createWebTrackRecorder` in `@mapatlas/core` while the PRD required
`core` to be Node-unit-testable with no DOM import — a direct contradiction the isolation scan
would have caught only after Phase 3. The PMTiles `OfflineRegionStore` was required by the PRD but
belonged to no package and had no exported factory.
**Decision.** Seven packages. `core` keeps interfaces and pure logic; `@mapatlas/recorder-web`
owns `createWebTrackRecorder` (DOM: geolocation, Wake Lock); `@mapatlas/offline-pmtiles` owns
`createPMTilesRegionStore`. `recorder-web`, `storage-idb`, and `offline-pmtiles` may use browser
APIs but must not import `react` or `maplibre-gl`; `maplibre` must not import `react`.
**Consequences.** The isolation scan gets a per-package rule table instead of one rule. Both
independent build harnesses arrived at this same split unprompted, which is corroboration that the
five-package layout was under-specified rather than merely different.

## ADR-0014 — Authored tracks are first-class; storage lists summaries, not tracks
**Context.** Re-creating a past trip by hand is a core web-app flow, but `TrackRecorder` was the
only path to a `Track` — the data model allowed a hand-built track while the product offered no
way to make one. Separately, `listTracks()` returned every track fully hydrated with every point,
which does not survive a trip list of any size.
**Decision.** `TrackDraft` in `core` — a pure, undoable point-list editor with `breakAt`,
`setTimeAt`, and `interpolateTimes` — whose `toTrack()` runs the *same* `finalizeTrack` and sets
`origin: "authored"`. The renderer contributes only interaction (`enterDrawMode`, `renderDraft`),
React contributes `useTrackDraft`. `listTracks()` is replaced by `listTrackSummaries():
Promise<TrackSummary[]>`, which must not hydrate points; `getTrack(id)` hydrates on demand.
**Consequences.** Review, stats, export, offline, and presentation work on an authored track with
no special cases — the only difference is one enum field. Adapters need a summary index, and
`TrackSummary` becomes part of the conformance suite. `Track.origin` also lets a consumer disclose
provenance, which matters when a hand-drawn trip is presented next to a recorded one.

## ADR-0015 — An interrupted recording is recoverable
**Context.** `createWebTrackRecorder(store?)` accepted a store but the contract never said what it
did with it. A multi-hour field trip held only in memory is lost to a tab kill, an OOM, or a
phone reboot — the failure mode a field-logging engine most needs to survive.
**Decision.** `TrackRecorderOptions.autosaveMs` persists the in-progress track (status
`recording`/`paused`) on an interval; `recoverInterruptedTrack(store)` in `core` returns such a
track so the consumer can offer resume-or-discard. `useTrackRecorder` surfaces it as `recovered`.
**Consequences.** At most one autosave interval is ever lost. Storage adapters must tolerate
repeated overwrites of a growing track. This narrows — but does not close — the gap left by
ADR-0003: foreground-only recording still ends when the OS suspends the page, and a native
background recorder remains the consumer's responsibility.

## ADR-0016 — Map assets and trip data are separate stores
**Context.** `createPMTilesRegionStore` took the trip `StorageAdapter`, so downloaded basemaps
and irreplaceable user data shared one namespace. Two consequences followed that nobody wanted:
`clearAll()` — which consumers call on sign-out for a clean device wipe — also destroyed every
downloaded region, and gigabytes of replaceable map bytes competed for quota with tracks and
photos that cannot be re-fetched from anywhere.
**Decision.** A separate `MapAssetStore` interface (`put`/`get`/`delete`/`list`/`estimateBytes`/
`clear`) owns downloaded map assets; `createPMTilesRegionStore({ sources, assets })` takes it
instead of a `StorageAdapter`. `@mapatlas/storage-idb` ships `createIdbMapAssetStore()` backed by
a **separate IndexedDB database**. `StorageAdapter.clearAll()` must not touch map assets, and
`MapAssetStore.clear()` must not touch tracks or events.
**Consequences.** Signing out no longer forces a multi-hundred-megabyte re-download. Map assets
can be evicted first under pressure, which is the correct priority — they are re-downloadable and
trips are not. Browsers still evict per origin, so this separates *intent and blast radius*, not
physical quota; consumers must still drive `navigator.storage.persist()`.

## ADR-0017 — Offline means local bytes, and not every source may be downloaded
**Context.** Two failure modes sat one step apart in the plan. First, "PMTiles offline regions"
reads as solved when a `.pmtiles` archive is merely *hosted* — but an archive read by HTTP range
request still needs the network, so a region can look downloaded and fail in the field. Second,
external review confirmed the OpenStreetMap Foundation's tile policy prohibits bulk downloading
and offline prefetching from `tile.openstreetmap.org`, and directs applications needing offline
maps to self-host or use a provider whose terms allow it.
**Decision.** `OfflineRegionStore.download()` **copies bytes into a `MapAssetStore`** and resolves
from local storage thereafter; remote PMTiles is not an offline region. Region download must never
run against a community tile service — this binds the demo and the test fixtures, not just
production. The Phase 6 acceptance test disables the network, which is the only honest proof.
**Consequences.** A licensing constraint becomes a build-time constraint rather than a deployment
footnote. The demo needs a self-hosted or offline-licensed source before Phase 6 can pass, which
makes the DEM/basemap data decision a scheduling dependency, not a detail. Interactive browsing of
a public host in development remains a courtesy question; bulk download does not.

## ADR-0018 — A draft point is a different type, and simplification is per segment
**Context.** External review of the contract before Phase 1 found two type-level contradictions
that would have been cheap now and expensive after `core` existed.

First, `TrackDraft.points` was typed `TrackPoint[]` while the authoring contract promised that
vertices could be placed first and timed later — but `TrackPoint.t` is required. The contract
asked strict TypeScript to represent two incompatible states in one type.

Second, `Track.simplified?: TrackPoint[]` was a single flat array while `TrackSegment` addresses
geometry by index into raw `points`. After decimation those indices identify nothing, and running
Douglas–Peucker over the concatenated array would smooth straight through a pause — the exact
artifact ADR-0010 introduced segments to prevent.

**Decision.** A separate `DraftTrackPoint` with optional `t` backs `TrackDraft`, `renderDraft`,
and `useTrackDraft`; `TrackPoint.t` stays required. `toTrack()` is the boundary that enforces the
finalized invariants and throws `TrackDraftIncompleteError` — naming the untimed indices — rather
than inventing a timestamp. And `simplified` becomes `simplifiedSegments?: TrackPoint[][]`, one
member per `segments[n]`, in the same order, produced by simplifying each segment independently.

A consequence worth stating outright: **export carries raw geometry, never simplified.** T1.7
requires a lossless round-trip, and that cannot be true of decimated points. Simplified geometry
is a rendering projection, recomputed on import rather than carried.

`simplifiedSegments` is therefore a **disposable cache**, and the contract says so explicitly:
deleting it from a persisted or imported track must not change the semantic track, because
`finalizeTrack` regenerates it deterministically from `points` + `segments`. Storage migrations
and any future change of simplification algorithm are then safe by construction — drop the cache
and rebuild, rather than migrating derived geometry that was never authoritative.

**Consequences.** The weaker alternative — making `TrackPoint.t` optional — would have pushed an
editing-state uncertainty into every consumer that ever reads a finalized track. The invariant is
now stateable in one line: `points + segments` is canonical and exportable; `simplifiedSegments`
is derived and disposable. Settled before T1.3 and T1.4, so the ambiguity never reaches storage,
the renderer, or import/export.

## ADR-0019 — Two distance functions: sampling is spherical, recorded distance is geodesic
**Context.** T1.2 introduced a haversine helper for the sampling decision and it was about to
become, by default, the engine's definition of distance — `computeStats` was going to import the
same function. Measured against Vincenty's inverse on WGS84, haversine on a sphere runs ~0.26%
short over long distances and up to ~0.56% on a meridian near the equator.

Those two uses have completely different tolerances. Sampling asks "did this fix move roughly ten
metres?", where GPS error dwarfs the ellipsoid difference and the answer flips a boolean that is
immediately discarded. `stats.distanceM` is a durable, user-visible number that compounds: a
systematic 0.3% bias is ~30 m over 10 km, ~126 m over a marathon, and more over an all-day trip.
MAP-ATLAS explicitly targets workout-class consumers (PRD §4), so baking that bias into the
canonical statistic would be a defect visible to every one of their users.

**Decision.** Two functions with names that state their precision, so neither can silently become
the other:

- `haversineDistanceMeters(a, b)` — spherical, closed-form, no iteration. Used by `sample()` and
  any other cheap geometric decision.
- `geodesicDistanceMeters(a, b)` — Vincenty's inverse on WGS84, falling back to haversine if it
  fails to converge. The **only** source of `stats.distanceM` and `TrackSegment.distanceM`.

Vincenty rather than Karney: Karney is more robust mathematically, but implementing it correctly
is far more machinery than this needs. Vincenty's weakness is the near-antipodal case, which
cannot arise between adjacent points of a GPS track, and the haversine fallback closes the
total-function contract regardless.

**Consequences.** One extra function and an iteration per leg, against a distance total a
consumer can defend. The generic name `distanceMeters` is deliberately not used by either, so a
future reader cannot pick "the distance function" by accident. If a consumer ever needs a
different geodesic model, it replaces one function rather than auditing every call site.

## ADR-0020 — `finalizeTrack` validates and throws; it never repairs
**Context.** `sample()` deliberately does not invent sequencing policy, so it can report a
negative `elapsedMs` and let the fix through on distance (T1.2). That leaves an open question:
what happens when a track reaches finalization with a timestamp that runs backwards? Such a track
yields nonsensical duration and speed, so something must decide — and the cheap-looking answer,
sorting the points inside `finalizeTrack`, is wrong.

`finalizeTrack` is the one canonicalization step shared by recorded, authored and imported tracks.
Sorting there would change geometry semantics, not just repair time: `TrackSegment` and `TrackLap`
address geometry by **index into the original point order**, and sensor samples are attached to
specific points, so reordering to fix the clock would corrupt the route and detach telemetry. An
out-of-order fix may also be a genuinely stale GPS observation rather than an array-order mistake,
and only the layer that received it knows which.

**Decision.** `finalizeTrack` validates and throws; it never repairs or reorders. The invariant is
**non-decreasing**, `points[i].t >= points[i - 1].t`, so only a strict decrease throws — equal
milliseconds are degenerate but not corrupt, two fixes can share one, and imported files often
round to the second. `computeStats` is then responsible for not deriving an instantaneous speed
from a pair whose `dt` is zero. The check runs **within** each segment and never across a
boundary, where a gap is the entire point of the segmentation. Segment ranges are validated too —
in bounds, not inverted, not overlapping — because a malformed range produces wrong geometry and
wrong statistics just as silently. **All validation happens before any derivation**: finalization
either returns a wholly valid track or throws having computed nothing.

The layers divide explicitly:

| Layer | Responsibility |
|---|---|
| `sample()` | Observational and pure. Reports negative `elapsedMs`; judges nothing. |
| `recorder-web` | **Drops** a stale out-of-order fix before it is ever kept. Never reorders live observations — buffering would entangle `onPoint`, sensor merge, laps, segments and autosave. |
| `TrackDraft` | Catches bad timing before `toTrack()`, alongside its incomplete-timestamp check. |
| import | Preserves source ordering. Malformed order is surfaced, never silently rewritten. |
| `finalizeTrack` | Enforces the canonical invariant. Throws `TrackTemporalOrderError(previousIndex, index, previousT, t)`. |

**Consequences.** A caller that catches the error still holds exactly the input it passed in, and
can decide to repair, discard, or show the offending indices to a user. No layer silently rewrites
a recorded observation. The cost is that a recorder which admits a stale fix produces a track that
cannot be finalized — which is the correct pressure, applied to the layer that can actually fix it.

## ADR-0021 — Elevation hysteresis is a policy, not a constant
**Context.** Summing every positive altitude delta manufactures climb from noise: consumer GPS
altitude oscillates by several metres while stationary, so a flat route can accumulate hundreds
of metres of invented ascent. A deadband is required. The question was what value to bake in.

Any single constant would contradict "seams over features". Phone GPS, a barometric altimeter, an
imported FIT or GPX file, and DEM-derived elevation have very different noise characteristics — a
3 m deadband is reasonable for good barometric data and still manufactures climb from ordinary
phone oscillation. The engine cannot know which it is holding, and `altitudeAccuracyM` is not the
answer either: it is unevenly reported across devices, and deriving the threshold from it would
make a durable statistic depend on absent metadata and stop being reproducible.

**Decision.** A `StatsPolicy` with `elevationHysteresisM`, defaulting to a conservative **5 m**,
accepted by both `computeStats` and `finalizeTrack` so recorded, authored and imported tracks can
all be finalized under one explicit policy. `0` disables filtering and accumulates raw movement.

The filter is **rolling and trend-aware, not pairwise**. Pairwise thresholding — count a step only
if it exceeds the deadband — reports zero for a 100 m climb taken in 1 m steps, because no single
step clears the bar. Instead the algorithm tracks the extreme reached since the last confirmed
turning point and commits a leg only when altitude reverses by more than the deadband. So
`100, 101, 102, 103, 104, 105, 106` yields 6 m of gain, while `100, 103, 98, 102, 99, 101, 97, 100`
yields nothing. Gain and loss are computed **per segment**, never across a pause, exactly as
distance is: a boat that drifts between two casts did not climb the difference.

**Consequences.** A field-journal consumer gets sensible behaviour untouched; a barometric one can
tighten to 1–3 m, a known-noisy device loosen to 8–10 m, and a pre-smoothed DEM import set 0. The
statistic stays deterministic and reproducible for a given policy, which is what makes it safe to
persist. `finalizeTrack` also takes `simplifyToleranceM` in the same policy object, so every
derived field a track carries is governed by one explicit argument.

## ADR-0022 — Derived data is computed at the boundary, never carried
**Context.** Review found the same defect twice in one feature. `TrackDraft` preserved laps from a
seeded track, and each preserved lap carried its `stats` — so the statistics were shared by
reference with the source track (mutating a finalized lap's `stats.channels` changed the original)
and went stale the moment geometry changed (moving one vertex doubled the track's distance while
the lap covering those same points still reported the old one). A track that reports one distance
overall and another for a lap spanning the same points is worse than one that reports nothing.

This is the third derived value to cause trouble. `simplifiedSegments` was settled by ADR-0018 —
a disposable cache, regenerated deterministically, never exported. `TrackStats` was made the
output of one shared `computeStats` by ADR-0010. Lap statistics were the case nobody generalised
the rule to.

**Decision.** Anything derivable is derived at the boundary that produces a `Track`, and nothing
upstream holds it. `finalizeTrack` accepts laps as `LapInput` — id, range, and an optional label —
and computes `index`, `startedAt`, `endedAt` and `stats` itself, via `computeLapStats`, which
clips the track's segments to the lap's range so a lap crossing a pause is measured correctly.
`TrackDraft` therefore stores only what a lap *is*.

The general rule: **a value that can be computed from the geometry is never stored beside it.**
Aliasing and staleness are both consequences of holding derived state, and removing the state
removes both at once — no defensive copying to remember, no invalidation to get right.

**Consequences.** Recorders marking laps in T3.2 get correct statistics for free rather than
having to compute them. Undo becomes simpler, since a snapshot holds no derived values that could
disagree with the geometry it sits beside. The cost is recomputation on every `finalizeTrack`,
which is the same pass that already simplifies and computes track statistics.

## ADR-0023 — `TileSource` separates content kind from transport
**Context.** `TileSourceKind` was `"xyz" | "wms" | "pmtiles" | "vector" | "raster-dem"` — a single
axis mixing two independent questions. `xyz` and `wms` name *how tiles are fetched*; `vector` and
`raster-dem` name *what the tiles contain*; `pmtiles` names a transport and says nothing about
content. Since a `.pmtiles` archive holds either raster or vector tiles, the renderer had no
stated way to know which, and T4.1a shipped an inference: presence of `styleLayers` decided it,
on the reasoning that vector tiles are unrenderable without layers and raster tiles need none.

The inference is wrong in both directions. A raster archive whose consumer adds a hillshade layer
is built as a vector source and draws nothing; a vector archive whose layers arrive later — or
come from a base `style` document — is built as raster and draws nothing. Both fail silently:
MapLibre reports no error for a source of the wrong type, so the map is simply blank.

Compounding it, the raster branch appended `/{z}/{x}/{y}` to the archive url. PMTiles is read
through a registered protocol handler that resolves the archive itself; MapLibre's own PMTiles
example passes `url: "pmtiles://…"` for raster, vector and `raster-dem` alike. The appended path
does not exist.

**Decision.** Three fields with three separate jobs:

    kind       describes content.
    transport  describes how the source is obtained.
    url        is the transport's underlying location or template.

`kind: "raster" | "vector" | "raster-dem"` maps directly to MapLibre's source `type`.
`transport: "template" | "wms" | "tilejson" | "pmtiles"` decides only the url's shape —
`tiles: [url]` for `template` and `wms`, `url` for `tilejson` and `pmtiles`. The builders infer
nothing.

**Renderer adapters may translate a transport into renderer-specific mechanisms; for MapLibre,
PMTiles becomes the registered `pmtiles://` protocol.** That pseudo-scheme is MapLibre's, not the
engine's: Leaflet's PMTiles integration constructs `PMTiles(url)` from the plain archive
location, and OpenLayers has its own source abstraction — neither knows what `pmtiles://` means.
So `TileSource.url` is always `https://cdn.example/map.pmtiles`, and `@mapatlas/maplibre` alone
prefixes it on the way into a style. A url arriving with the scheme already on it is **rejected
under every transport**: `transport: "pmtiles"` states the fact once, and a second representation
of it would mean deciding whether to prefix again.

What cannot be expressed is likewise rejected rather than rendered wrong: `wms` with a
non-`raster` kind, since GetMap returns an image, and a `wms` url with no bbox placeholder.

This **supersedes the transport/content portion of ADR-0011**. Everything else ADR-0011 decided
stands: `role`, `encoding`, `TerrainOptions`, and `styleLayers` as an opaque JSON passthrough
that keeps renderer style types out of `core`.

**Consequences.** A breaking change to a public type, taken now because nothing outside the
renderer builders constructs a `TileSource` yet — once Phase 6 and the demo do, it costs far
more. Migration is mechanical: `xyz` → `raster`/`template`, `wms` → `raster`/`wms`, `vector` →
`vector`/`tilejson`, `raster-dem` → `raster-dem`/`tilejson`, and a PMTiles source states its
content kind explicitly and drops the `pmtiles://` prefix from its url.

Phase 6 gets the better end of this. `OfflineRegionStore` can reason from `transport: "pmtiles"`
while `url` stays the archive location it must fetch bytes from — it never has to strip a
renderer's pseudo-scheme to do its own job.

The general rule, and the one worth carrying forward: **when a value answers two questions, it
answers neither — split the axes rather than infer one from the other.** The corollary this
correction added: a renderer-specific encoding of a value is the renderer's to apply, not
something the neutral contract carries on its behalf.

## ADR-0024 — Demo elevation data and hosting
**Status.** Decided, unconditionally. Superseded the earlier "pending one input: whether the
representative region is US-only" — that input turned out to gate on a premise the engine does
not satisfy. See **Amendment: the substitution is unreachable** at the end.

**Decision.** **Copernicus DEM GLO-30 Public** — specifically `COP-DEM_GLO-30-DGED`, 2021
release, read from the `s3://copernicus-dem-30m` mirror at build time and **terrarium-encoded by
us into the PMTiles archive**. Nothing is fetched from a third party at runtime.

**The USGS 3DEP substitution recorded here originally is withdrawn**, for the reason set out in
the amendment below: it was conditional on the engine sampling elevation from the DEM, which it
does not do. What it said, for the record: *if the representative region is US-only, take USGS
3DEP 1/3 arc-second instead — public domain, so redistribution is trivially satisfied and
attribution nearly vanishes; and bare-earth, which removes the one real defect in the Copernicus
choice.* Both statements remain true about 3DEP. Neither is a reason to prefer it here.

**Against the criteria.**

1. **A named product, not a named agency.** "Copernicus DEM" is a family, not a product — which
   is the trap this criterion exists for. The instances are EEA-10, GLO-30 and GLO-90, packaged
   as INSPIRE, DGED or DTED, and the packaging changes the data: 32-bit float in DGED, 16-bit
   signed in DTED. The licence excludes the higher-resolution WorldDEM-10 from public
   distribution under separate terms. GLO-30 **Public** is also a deliberate subset: some
   countries' tiles are not released publicly and there are no ocean tiles at all, so **the
   representative region must be chosen from released coverage**, and that check belongs here
   rather than in a build failure.

2. **Redistribution and offline rights — passes explicitly, not by silence.** Article 4 grants
   reproduction, distribution, communication to the general public, and adaptation, modification
   and combination with other data; Article 5 makes it free of charge; Article 3 grants it
   worldwide and without limitation in time. Terrarium-encoding is adaptation, so both the
   archive and the user's download are covered. **Mapbox Terrain-RGB fails here** — its terms do
   not permit caching tiles outside its own SDKs — which is the elimination this criterion was
   written to perform.

3. **Attribution is three strings and a file placement, not one string.** Because we modify the
   data, the derived-works notice applies: *"produced using Copernicus WorldDEM-30 © DLR e.V.
   2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the
   European Union and ESA; all rights reserved"*. Two obligations that are usually missed, and
   which are **carried code rather than prose**: a verbatim liability sentence stating that the
   organisations in charge of Copernicus incur no liability for any use of the data must appear
   in any licence or notice covering redistribution, and downstream recipients must be bound by
   the same obligations. Together those mean a **LICENSE file shipped inside the archive**, not
   only an on-map credit. There is also a no-endorsement clause.

4. **Datum and resolution.** Horizontal WGS84-G1150 (EPSG:4326); vertical EGM2008 (EPSG:3855),
   metres. Two consequences for the statistics `computeStats` derives from GPS:

   - GPS reports height above the WGS84 **ellipsoid**; EGM2008 is a **geoid**. Absolute
     altitudes therefore disagree by the local undulation — tens of metres — while elevation
     *gain* and *profile shape* largely cancel, since undulation varies over hundreds of
     kilometres. **Relative statistics are comparable; absolute altitude is not**, unless a
     geoid grid ships too. Recorded here rather than discovered in a bug report.
   - The native grid's longitudinal spacing widens beyond 50°N and 50°S, so "30 m" holds near
     the equator and not elsewhere.

   **The real cost: it is a DSM, not a DTM.** It represents the surface including buildings and
   vegetation, so over forest the elevation reads high by the canopy height. The distinction
   bites wherever a DEM value becomes a **statement about ground**, and there are two places to
   look for that, not one — a check scoped to runtime sampling misses the nearer of them.

   - *At runtime:* nothing. The amendment below establishes that no code path reads elevation
     off the terrain, so a profile or a snapped vertex altitude cannot be wrong because nothing
     produces one. Latent, and the trigger is precise: **a call that samples the DEM**, not a
     field that could hold the result. Adding altitude to a draft vertex changes nothing here.
   - *At build time:* **the contour layer**, and this one is live. The engine only styles
     contours — `styleLayers` is an opaque passthrough (ADR-0011) — so it never generates the
     geometry, which means this fixture's build script must. Contours are where a DSM looks
     worst: a contour line is read as a claim about ground, and canopy enters as closed loops
     around woodland and buildings that survive every zoom level and every restyle. Unlike
     shading, it is not arguable as texture.

   The resolution is a constraint on **where the fixture's region may be**, not a change of
   source: see the amendment.

5. **Encoding: terrarium.** Copernicus ships COG GeoTIFF, so we encode either way, and encoding
   ourselves is a benefit under criterion 2: the runtime then depends on no third party's
   behaviour at all. Decode is `(R * 256 + G + B / 256) - 32768`, simple enough that fixtures can
   synthesise pixels by hand and a unit test can check known values against it. Mapbox's
   `-10000 + (R * 65536 + G * 256 + B) * 0.1` is no harder and buys nothing here.

6. **Archive size — to be measured, not calculated.** The shape: a 1°×1° footprint at z12 is on
   the order of 130 terrarium tiles, and the full pyramid beneath it about a third more again,
   so low tens of MB per degree-cell at 256px; a few-degree region with a z14 ceiling should land
   in the low hundreds of MB. That is a download, not a distribution problem — but the criterion
   asked for a measured number, and it is a build-script output.

7. **Delivery splits build-time from runtime.** Build-time: S3 over HTTPS, range-read by
   construction since COGs depend on it, unauthenticated. Runtime: **nothing** — the archive is
   local. CORS stops being a criterion at all, which is usually where candidates die.

**Rejected: AWS Terrain Tiles (Tilezen/Joerd).** Already terrarium, already tiled, and
bare-earth — better than Copernicus on the DSM problem. It fails criterion 1 exactly as written:
it is a **mosaic of national DEMs**, and its attribution is a compound string naming ArcticDEM,
Geoscience Australia, Austria's DGM, Canada's Open Government Licence, EU-DEM, ETOPO1 and
others. "Carried verbatim" would then mean carrying a string whose correct contents depend on
which region was archived, over sources with **mixed vertical datums** — which defeats criterion
4 as well.

**Consequences.** The archive shape matters more than the data's vintage. The Copernicus DEM
datasets were released for use in 2019 and are maintained until 2026; since Article 3 grants
rights without limitation in time and we archive rather than fetch, an end to upstream
maintenance threatens anyone depending on a live endpoint, not us. That is a third argument for
the archive design, alongside the OSM tile policy and offline operation.

Two things become build-script obligations rather than prose: the attribution and liability
strings must be **checked against the licence document at build time and written into the
archive**, and the region must be verified as released coverage before tiles are cut.

**Amendment: the substitution is unreachable, so the region question is moot.**

The 3DEP branch rested on one sentence in criterion 4 — *"if the product ever shows trail
profiles that is a visible defect"* — and that condition is not met. Three checks, each
independently sufficient:

- `computeStats` is declared as `(t: Pick<Track, "points" | "segments" | "channels">, policy?)`.
  Its entire input is track data. It is handed no map, no controller and no DEM, so it cannot
  read a terrain value even if it wanted one.
- `TrackPoint.altitudeM` is *"WGS84 ellipsoidal metres, when the fix provides it"* — it comes
  from the geolocation fix. Criterion 4 above says the same thing when it works through the
  ellipsoid-versus-geoid mismatch "for the statistics `computeStats` derives from GPS".
- No terrain-sampling call exists anywhere in `specs/` or `packages/` — no
  `queryTerrainElevation`, no equivalent on `MapController` — so there is no way to read a
  value off the terrain at all. This is the load-bearing check, and it is deliberately *not*
  argued from what the geometry carries: a profile along a drawn line needs something to sample
  a DEM at those coordinates, not an altitude field on the vertices, so adding one to
  `DraftTrackPoint` would not make this condition live. Only a sampling call would. The word
  "profile" appears in none of `PRD.md`, `roadmap.md` or `architecture.md`.

**The decisive argument is not the canopy one, and holds even if the premise had been true.**
Choosing 3DEP binds the engine's own reference fixture to a single country. The fixture is the
thing consumers copy, so a US-shaped one teaches a US-shaped setup — in an engine whose entire
premise is that it carries no domain and no place. That alone settles it. The premise check
below matters because it removes the only counter-argument that could have justified the
narrowing, not because it is the reason for the choice.

**Where the DEM's values are consumed, and what remains live.** Runtime: nothing, per the three
checks below. Build time: the contour layer, per criterion 4 — live, and resolved by region
selection rather than by source, in the constraint stated at the end of this amendment.
Hillshade sits between the two and is a caveat rather than a defect: at 30 m a treeline is a
one- or two-pixel step of twenty-odd metres, which shades as an escarpment. The surface is
real, but it renders as terrain and can read as a cliff. Worth knowing; not worth changing the
decision over.

**Region constraint, which is where the live criterion is discharged.** The fixture's region
must be **above the treeline and inland**. Above the treeline there is no canopy, so the DSM and
a DTM converge to within the product's own vertical error and the contour geometry is a claim
about ground after all — the criterion-4 defect is not tolerated, it is arranged not to arise.
**"Inland" is defined operationally, so it is checked rather than asserted.** It means: the cut
requires only published tiles, and every decoded sample satisfies the floor. Both are already
obligations — 2 and 3 for the first, 4 for the second — so the constraint needs no check of its
own; a coastal box either reaches tiles GLO-30 Public never published, or includes sea-level
pixels that any above-treeline floor rejects. Two things follow. The definition enforces **no
ocean intersection**, not distance from a coastline: a box a kilometre inland of a cliff, wholly
above the floor and wholly within published tiles, satisfies it, and should. And the constraint
is discharged by the same three checks rather than by a fourth, which is why the "and inland"
half of the sentence has no separate machinery — it was, until this was written down, the half
still resting on prose.

Inland avoids the coast, and with it the second trap: GLO-30 Public ships **no ocean tiles**,
and terrarium has **no no-data sentinel** — every one of the 2^24 RGB triples decodes to a valid
elevation, so absence cannot be expressed at all. An earlier version of this paragraph said a
zero fill "decodes to sea level"; that is wrong, and the first line of the encoder falsified it.
The formula carries a fixed offset, so a zero-byte fill decodes to **−32768 m**, the bottom of
the range, while sea level is `RGB(128, 0, 0)`. The correction strengthens the point rather than
weakening it: the problem is not that a fill looks plausible, it is that there is no value that
means nothing. A coastal fixture would therefore need an explicit choice about absent tiles, made
rather than inherited from whatever the encoder does by default. The constraint also happens to select for the relief
that makes terrain, hillshade and contours worth demonstrating at all, so it costs the fixture
nothing.

**Every obligation below fails the build; none warns.** A warning is an obligation with an
opt-out that nobody records taking, and these fail on the day a region changes or an upstream
release does rather than on a day someone is watching.

**The constraint is enforced, not described.** "Above the treeline" is not a property a script
can read off a bounding box: a region can satisfy it in aggregate and still include a forested
valley floor in one corner, which is precisely where a reader would go looking for the artifact.
Left as prose it is a premise that was true when written and stops being true, silently, the
first time someone widens the bounds by half a degree. So the region declaration carries a
**minimum-elevation floor** alongside its bounds, and the build script checks the cut region's
lowest sample against it — from the DEM it already has open, since every tile is read to encode
it. The floor is declared per region rather than fixed, because the treeline is a function of
latitude and no single number is right from the Alps to Scandinavia; what is fixed is that a
number must be given, justified, and met.

Absent tiles remain a build-script obligation even inland, because withholding is at **tile**
granularity: a region can be partially covered with no country-level list saying so. Coverage is
therefore verified per tile, not per country, and the script fails on a gap rather than filling
one silently. The failure **names the tile** — "no published tile at N45E007" rather than "gap
in coverage", since the second sends whoever reads it to debug the fetcher for a file that was
never going to arrive.

**How this was reached is the point.** The conditional had stood for two review rounds and read
as a deferred decision awaiting an input. It was in fact a decision awaiting a *premise check* —
and the check was cheaper than the decision it gated. Two general forms worth carrying. Before
answering the question a conditional poses, confirm the condition can occur at all. And when
checking whether a data property has a consumer, the distinction that matters is not build time
versus runtime but whether the value is **recomputable**: a runtime sample can be wrong today
and right tomorrow when the source changes, while a value baked into shipped geometry is wrong
for as long as the artifact exists and leaves no code path pointing back at where it came from.
That is why the baked consumer is both the more permanent and the easier to miss — it stops
looking like a consumer the moment its output ships.


---

## ADR-0025 — Terrain and contours are separate PMTiles archives

**Status.** Decided. Discovered while adopting the writer (T4.6), before any contour code existed
to be shaped by the alternative.

**Decision.** The vertical fixture writes **two** PMTiles archives for one region: terrain
(terrarium PNG rasters) and contours (MVT vectors). They are never combined.

**Why it is a structural constraint rather than a preference.** PMTiles v3 carries **one
archive-level Tile Type** and **one archive-level Tile Compression** — single bytes at fixed
header offsets, verified in the pinned reader's own parse (`tileType` at byte 99,
`tileCompression` at 98) rather than taken from the specification alone. So a single conforming
archive cannot describe both PNG and MVT payloads *at all*, regardless of what compression is
chosen. An earlier framing of this constraint said compression only — already-compressed PNG
wants `none` while vector tiles want `gzip` — which is true and much too weak: it suggests a
trade-off where there is none available.

**What follows, so this is not rediscovered downstream.**

- The fixture layout is one archive per source, not one per region. Anything that assumes a
  region maps to a single archive — build outputs, the `/lab` route, the offline scenario, the
  archive-size measurement of ADR-0024 criterion 6 — must handle a set.
- Archive size is therefore reported **per archive and as a total**; one number would hide which
  source grew.
- `scripts/fixture/archive.mjs` takes the payload type per call and holds no opinion about which
  sources exist, so adding a third source is a caller change, not a writer change.

**Consequences accepted.** Two files per region rather than one, and two `getHeader` round trips
for a consumer wanting both. Both are what a renderer does anyway: a terrain source and a vector
source are separate sources in a style, so nothing here asks a consumer to do more work than the
format already implies.

## ADR-0026 — `@mapatlas/react` depends on `@mapatlas/recorder-web`, and recovery is explicit

**Status.** Accepted 2026-09-01, before T5.1's first hook.

**Context — two specifications disagreed, and the disagreement was load-bearing.** `api.md` §9
publishes `useTrackRecorder({ recorder?, store?, sampling?, sensors? })`, where `recorder` is
optional and the other three only make sense if the hook constructs a default recorder when none
is injected. `architecture.md` lists `@mapatlas/react`'s dependencies as `core`, `maplibre`,
`react` — and **no recorder factory exists in `core`**. The only one is `createWebTrackRecorder`
in `@mapatlas/recorder-web`. As written, the published signature could not be implemented.

**Decision 1 — preserve the published signature; add the dependency.** `@mapatlas/react` takes
`@mapatlas/recorder-web` as a production dependency and the architecture table is corrected. This
creates no cycle (`react → recorder-web → core`), keeps the ergonomic default that a consumer
supplying only a `store` gets a working recorder, and leaves `recorder:` injection as the route
for a native or out-of-tree implementation. The alternative — making `recorder` required — would
change a published contract to avoid a dependency, which is the more expensive of the two.

*The cost, recorded rather than left to be rediscovered.* `@mapatlas/recorder-web` reaches for
`navigator.geolocation`. A React Native consumer importing `@mapatlas/react` pulls it into the
module graph even while injecting its own recorder. For V1 the ergonomic web default wins. If
React Native becomes a first-class target, the fix is a lazy import or a default-recorder subpath
that keeps the web module out of the native import graph — neither of which changes
`TrackRecorder` itself.

**Decision 2 — recovery is two explicit operations, not a side effect of `start()`.** `api.md`
§9 gains:

```ts
resumeRecovered(): Promise<void>;   // starts a new recorder constructed with resumeFrom
discardRecovered(): Promise<void>;  // durably deletes the interrupted track
```

The distinction that makes them necessary: `resume()` returns the **current in-memory paused
session** to recording, while `resumeRecovered()` restores an **interrupted prior session from
durable storage**. They are different operations on different subjects, and the second cannot be
expressed as the first — `resumeFrom` is *constructor* state on the web recorder, not a method on
the `TrackRecorder` seam, so a recorder that already exists cannot be told to resume a track.

The rejected reading is `start()` silently passing `recovered` as `resumeFrom`. It invents policy,
makes discarding unreachable, and contradicts `core`'s own documentation, which says recovery
exists so a consumer can offer **resume-or-discard**. It is also the behaviour an implementation
drifts into when nobody decides, which is why it is written down as refused.

Semantics, pinned:

- `start()` **never** consumes `recovered`; it always begins a fresh recording.
- `resumeRecovered()` constructs the recorder with exactly that candidate as `resumeFrom`,
  subscribes before starting, and clears `recovered` only after a successful start. A
  constructor, validation or start failure leaves the candidate available to retry.
- `discardRecovered()` deletes exactly `recovered.id` through `StorageAdapter.deleteTrack()`, and
  clears `recovered` only once that resolves. A failed deletion leaves it in place.

**Decision 3 — recovery belongs only to the hook-owned recorder.** When `opts.recorder` is
supplied, the consumer owns recorder construction and therefore owns recovery construction too:
`recovered` stays `undefined` and the hook does not scan for an interrupted track.

This is a consequence of the seam rather than a convenience. `resumeFrom` is not on
`TrackRecorder` — deliberately — so a generic recorder cannot be reconstructed with it. Without
this rule, `resumeRecovered()` would have to ignore the injected native recorder and build a web
one behind the consumer's back, which is worse than not offering the operation.

**Decision 4 — the hook's options do not grow into `TrackRecorderOptions`.** No `autosaveMs`,
matching the existing omission of `sensorMerge`. It is not needed for the common path:
`createWebTrackRecorder` resolves `autosaveMs ?? DEFAULT_AUTOSAVE_MS` (10 000 ms) and enables
autosave whenever a store is present and the resolved interval is positive — so
`useTrackRecorder({ store })` already produces recoverable recordings, and recovery has something
to find by default. A consumer needing a custom interval, `autosaveMs: 0`, a custom sensor merge
or a native recorder uses `recorder:` injection. Stating this now is what stops the hook's options
from drifting into a duplicate of the recorder's.

## ADR-0027 — `EventComposer` blob ownership, and what a rejection does not establish

**Status.** Accepted 2026-09-02, before T5.3's first implementation increment.

**Context.** The composer writes photo blobs through `StorageAdapter.putBlob` and hands the
resulting `blobKey` to the consumer through `onSave(input): void` — a callback that cannot
acknowledge persistence. The storage seam offers no transactions, and the repository's only
orphan collection (`deleteTrack`, removing blobs referenced only by a track's events) does not
cover a blob no saved event references. Somebody has to own every moment of that lifecycle, and
the interface cannot say who; this record does.

**Decision 1 — blobs are written on Save.** The selected `File` stays in memory; preview and
analysis use it directly. This narrows the orphan window; it does not close it.

**Decision 2 — ownership is positional, and transfers at the callback.** Before Save, nobody
owns anything durable. From Save until the write settles, the composer owns it: a cancel or
unmount during the write means the composer best-effort-deletes a landed blob and never calls
`onSave`. **From the instant `onSave` receives the `blobKey`, the consumer owns it** — the
composer never deletes it afterwards, unmount included, and a consumer that discards the input
owns the orphan it chose to make.

**Decision 3 — a rejection establishes no storage outcome.** The adapter contract does not
promise that a rejected `putBlob` wrote nothing: a remote adapter can persist the bytes and lose
the response, and the composer then holds no key with which to clean up. A rejected Save
therefore retains the draft, never calls `onSave`, and promises no orphan-free retry — the retry
may orphan the first, unlocatable write. Symmetrically, a rejected `deleteBlob` means deletion is
**unconfirmed**, not that the blob remains. The write row runs against a fake whose write lands
before it rejects, and the cleanup row against a separate delete-then-reject fake — but the fakes
are the environment, not the proof: both storage outcomes present identically to the composer, so
what is asserted are the observables — error wording acknowledging an unconfirmed write, the
draft retained, and `onSave` unreachable.

**Decision 4 — a Save snapshots its complete handoff.** The assembled input, the store, and the
`onSave`/`onCancel` recipients are captured when Save starts, and completion uses the snapshot:
delivering store A's key to a replacement callback associated with store B would hand the
consumer a key that resolves nowhere in B.

**Decision 5 — handoff and cancellation are terminal; rejection is not.** After `onSave` or
`onCancel`, the instance is inert; a new composition is a new mount, and at most one of
`onSave`/`onCancel` fires per instance. The write limit is per *attempt*, not per instance —
a lifetime cap would forbid the retry Decision 3 exists to govern, and a photo-free Save
performs zero writes. Precisely: **one `putBlob` per photo-bearing Save attempt, no concurrent
duplicate attempts, a rejected attempt permits retry unless cancelled, and handoff or
cancellation permanently prevents further submissions.** Pinned as a sequence: reject → retry
succeeds → a subsequent Save is ignored.

**Decision 6 — cleanup-failure reporting.** While mounted, a failed cleanup is retained in state
and shown as an inline notice — UI, not new API. After unmount there is no channel: the failure
is logged as a `console.warn` and acknowledged as unreported, because a reporting callback would
be API that §9 does not publish.

**Also clarified, in `api.md` and `specs/tasks.md` alongside this record:**
`capture="environment"` requests a *preferred camera facing mode, with fallback permitted*
(W3C html-media-capture); it guarantees neither a rear camera nor a camera at all. And
`mode: "photo"` means the capture affordance is the initially active, accessible control, with
the picker invoked through a user action — not an automatic camera launch, which user-activation
rules do not permit anyway.
