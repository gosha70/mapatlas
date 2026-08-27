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
