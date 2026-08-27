<!-- SPDX-License-Identifier: Apache-2.0 -->

# MAP-ATLAS — Task backlog

The buildable units, grouped by the [`roadmap.md`](roadmap.md) phases. Build in order;
respect the one architectural rule (core imports nothing consumer/renderer specific). Every
task: keep the gates green, DCO-sign commits, SPDX-header new files. `AC` = acceptance criteria.

## Phase 0 — Toolchain & skeleton
- **T0.1 Workspace root.** Monorepo (npm or pnpm workspaces), `packages/*` + `apps/*`, root
  scripts `build|typecheck|lint|test`. Seven packages: `core`, `recorder-web`, `maplibre`,
  `react`, `storage-idb`, `offline-pmtiles`, plus `apps/demo`. `maplibre-gl` is pinned to an
  exact version (no `^`/`~`). _AC:_ `npm install` then all four scripts run (no-op ok); the
  dependency graph matches `architecture.md §2`; no renderer dependency uses a range.
- **T0.2 TypeScript strict base.** Shared `tsconfig.base.json` (strict, ESM, declaration).
  _AC:_ a stub `@mapatlas/core` typechecks; `any` in public API is a lint error.
- **T0.3 Lint + format.** ESLint + formatter; a rule/plugin config. _AC:_ `npm run lint` green.
- **T0.4 Test runner.** Vitest (or equivalent) wired per package. _AC:_ a sample test runs.
- **T0.5 Isolation CI scan.** A script that fails if `@mapatlas/core` imports `react`/DOM/
  `maplibre-gl`, if `@mapatlas/maplibre` imports `react`, if `recorder-web`/`storage-idb`/
  `offline-pmtiles` import `react` or `maplibre-gl`, or if any package outside `apps/` contains a
  domain token (fish, species, mushroom, plant, product, auth, db). _AC:_ scan passes clean and
  *proven to fail* on a planted violation of each rule — including a bare side-effect import
  (`import "react";`), which a naive `from`-only regex misses.
- **T0.6 SPDX header check.** Fail build if a source file lacks `SPDX-License-Identifier: Apache-2.0`.
- **T0.7 CI workflow.** `.github/workflows/ci.yml` running install → build → typecheck → lint →
  test → `scan:isolation` → `scan:spdx` on push and PR, plus a DCO sign-off check on PRs.
  _AC:_ (a) the workflow runs green on GitHub, not merely locally; (b) the scanner's negative
  cases — forbidden import, bare side-effect import, DOM global, domain token — are **automated
  unit tests** that run inside that workflow, so a regression in the scanner fails CI; and
  (c) one recorded end-to-end proof that a planted violation turns the job red. (a) and (b) are
  standing guarantees; (c) is a one-time demonstration, since a repository cannot keep a broken
  commit around to re-prove it.

  **T0.7(c) evidence.** A bare side-effect `import "react"` in `@mapatlas/core` — the form T0.5
  names specifically, because a `from`-only regex misses it — was planted on the throwaway branch
  `test/ci-isolation-negative-proof` (commit `8a0d627`) and opened as PR #1 against `main` at
  `a5db199`. Run [33092051527](https://github.com/gosha70/mapatlas/actions/runs/33092051527)
  failed at **`Scan — import isolation`** with Install, Build, Typecheck, Lint, Format check and
  Test all green before it — so the red is attributable to the scanner, not to a broken build.
  Branch deleted, never merged.

  That run also exposed a defect in this workflow: the DCO job checked `HEAD`, which on a
  `pull_request` event is the synthetic merge commit GitHub generates without a sign-off, so it
  would have failed every PR regardless of the author. Fixed by checking out
  `github.event.pull_request.head.sha` and skipping merge commits. The negative test earned its
  keep twice.

## Phase 1 — `@mapatlas/core`
- **T1.1 Types.** All of `api.md §1` + ids/util — incl. `altitudeM`, `channels`,
  `ChannelDescriptor`, `TrackSegment`, `TrackLap`, `TrackStats`, `TrackSummary`, `origin`,
  `simplifiedSegments`, and `DraftTrackPoint` (optional `t`) distinct from `TrackPoint`.
  _AC:_ exported, typechecked, no runtime dep.
- **T1.2 Sampling.** `SamplingPolicy` + a pure `sample(prev, candidate, policy)` decision fn.
  _AC:_ unit tests for distance/interval/accuracy branches.
- **T1.3 Simplify.** Douglas–Peucker `simplify(points, toleranceM)` over one continuous run;
  `finalizeTrack` (T1.4) is what maps it **per segment**.
  _AC — correctness:_ every original point lies within `toleranceM` of the resulting polyline,
  measured as the minimum distance to *any* segment of it and verified by a test-only reference
  implementation, not by the code under test. Endpoints preserved; retained points unchanged in
  value including `t`/`altitudeM`/`channels` (value equality, not object identity — the API does
  not promise references); input never mutated; empty/1-point/2-point/all-coincident/closed-loop
  inputs behave predictably; tolerance `0` yields zero-error geometry rather than preserving every
  point, since an exactly collinear point may legitimately be dropped; a negative or non-finite
  tolerance throws rather than acquiring accidental semantics; a high-latitude fixture confirms the
  local projection does not distort where a degree of longitude is a few hundred metres.
  _AC — fixture signal:_ a representative noisy route reduces 60–80%. Deliberately loose and
  labelled as such: the ratio is knife-edge against the tolerance, so it is a regression signal
  about that fixture rather than a property of the algorithm.
  _AC — at the track layer (T1.4):_ a two-segment fixture yields
  `simplifiedSegments.length === segments.length` and **no** simplified member spans the pause.
- **T1.4a Geodesic distance.** `geodesicDistanceMeters` — Vincenty's inverse on WGS84, falling
  back to `haversineDistanceMeters` when it fails to converge (ADR-0019). _AC:_ agrees with
  published Vincenty values to <1 mm on a set of reference pairs including a near-equatorial leg,
  a high-latitude leg, and an antimeridian crossing; the fallback is exercised by a
  forced-non-convergence case and returns a finite number; identical points return exactly 0.
- **T1.4b Temporal invariants.** `finalizeTrack` validates that `t` is non-decreasing within each
  segment and throws `TrackTemporalOrderError` naming the offending indices. Sampling deliberately
  does not invent sequencing policy (T1.2), so finalization is where a track with decreasing
  timestamps — and therefore nonsensical duration and speed — is rejected rather than silently
  producing bad statistics. _AC:_ a monotonic fixture finalizes; a fixture with one backwards
  point throws and names its index; the error does not fire across a segment boundary, where a
  gap is expected.
- **T1.4c Lap statistics.** `computeLapStats`, and `finalizeTrack` deriving every lap field
  from `LapInput` rather than trusting a caller (ADR-0022). _AC:_ a lap inside one segment
  measures its own span; a lap crossing a pause counts the elapsed time but neither the distance
  nor the moving time of the gap, and invents no elevation across it; a lap covering everything
  agrees with the track's own statistics; the `StatsPolicy` reaches every lap through
  `finalizeTrack`; and an out-of-bounds, negative, inverted or fractional range throws
  `TrackLapRangeError` **before** anything is derived, while overlapping and non-covering laps are
  accepted, since laps are markers rather than a partition.
- **T1.4 Stats + finalize.** `computeStats(track, policy?)` (distance via `geodesicDistanceMeters`,
  elapsed vs moving time, avg/max speed skipping zero-duration pairs, elevation gain/loss via a
  **rolling trend-aware** deadband from `StatsPolicy.elevationHysteresisM` (default 5, `0` = raw),
  per-channel roll-up honoring `aggregate`) and
  `finalizeTrack` (segments + `simplifiedSegments` + `stats`). _AC:_ distance and elevation gain within
  tolerance of a known fixture; a fixture with a pause reports `movingTimeMs < durationMs`;
  a flat-but-noisy altitude fixture reports ~0 gain, not accumulated noise; **deleting
  `simplifiedSegments` and re-running `finalizeTrack` reproduces it exactly** — it is a cache,
  not state, and dropping it must not change the track.
- **T1.5 EventLog logic.** `createEventLog(store)` — create/update/delete/list against a
  `StorageAdapter`, plus the shipped in-memory adapter it is tested with.
  _AC:_ `add` assigns an id; `update` throws `EventNotFoundError` rather than inserting; `list`
  is ordered by `occurredAt` with an id tiebreak so it is total and stable; `remove` is
  idempotent; the log holds no state of its own, proven against a second adapter that records
  the calls.
  _AC — the shipped adapter (`@mapatlas/core/testing`):_ exported from a **separate entry point**,
  never the main barrel; copies values in and out so a caller cannot mutate the store through a
  returned object; cascade-deletes a track's events and the blobs only they referenced, while
  keeping a blob another event still holds; `clearAll()` leaves a `MapAssetStore` untouched and
  vice versa; obeys `core`'s purity boundary. Whether the conformance *suite* becomes public —
  and in what form — is deliberately left to T2.1.
- **T1.6 Interfaces.** `StorageAdapter`, `MapAssetStore`, `MediaAnalyzer`, `TileSource`,
  `OfflineRegionStore`, `TrackRecorder`, `SensorSource` per `api.md`; ship `noopAnalyzer`.
  _AC:_ typecheck; `noopAnalyzer` returns `[]`; every seam Phase 2 and Phase 6 implement is
  declared here — a Phase 1 that omits `MapAssetStore` leaves T2.3 with nothing to implement.
- **T1.7 GeoJSON.** `trackToGeoJSON`/`geoJSONToTrack` returning/accepting `TrackExport`.
  _AC — the governing property:_ export → import → export is **byte-identical**, and the imported
  track equals the original over its **canonical state** (`points + segments + laps + channels +
  stats + origin + tags + meta` + events) — not over every property, since `simplifiedSegments` is
  omitted by design and regenerated. That regeneration is asserted separately.
  _AC — determinism:_ output does not depend on input ordering. Channel keys sorted, manifest
  sorted by id, events ordered by `occurredAt` then id; segments, laps, coordinates, tags and an
  event's media keep the order they were given, because there the order is data.
  _AC — fails closed:_ a misaligned parallel array, a missing timestamp, segment properties that
  disagree with the geometry, two track features, a wrong geometry type, or a track violating the
  temporal or coverage invariants must all raise rather than truncate or repair.
  _AC:_ round-trip preserves geometry **as a `MultiLineString` per segment at raw fidelity**
  (exporting `simplifiedSegments` fails the losslessness requirement below), timestamps
  (`coordTimes`), `altitudeM`, per-coordinate `channels` + descriptors, laps, stats, origin,
  comment, tags, `fields`, `analysis` (media by reference in the manifest, never inlined).
- **T1.8 Sensor channels.** `createPollingSensorSource`, `mergeSensorSamples`, and
  `createFakeSensorSource` on the **testing** entry point. The scheduler is injected internally
  for determinism and deliberately kept **off** the public contract — it is implementation
  machinery, and putting it in `api.md` means owning its shape forever.
  _AC — polling:_ at most one `read()` in flight, with later ticks **skipped rather than queued**;
  samples stamped at read completion from the injected clock; `intervalMs` positive and finite;
  duplicate descriptor keys fail construction; undeclared keys and non-finite values raise
  `read-failed` while a partial set of declared channels is accepted; a rejected read raises and
  polling continues; `start`/`stop` idempotent; a read in flight across `stop()`→`start()` cannot
  emit into the new session.
  _AC — merge:_ reduction is per channel over the samples carrying that key, so a staggered
  fixture (`t=100 {a:10}`, `t=110 {b:20}`, `t=120 {a:14,b:24}`) averages `a` over 10,14 and `b`
  over 20,24 rather than treating absence as zero; samples older than `maxAgeMs` are dropped, and
  samples newer than the point belong to the next one.
- **T1.9 Manual authoring.** `createTrackDraft` per `api.md §4` over `DraftTrackPoint[]` —
  append/insert/move/remove, `breakAt`, `setTimeAt`, `interpolateTimes`, undo/redo, `toTrack`.
  History is **bounded full-state snapshots**, not a command log: correctness matters more than
  memory where the mutations are hardest, and an authored route is tens to hundreds of vertices.
  The limit stays private — implementation policy, replaceable by structural sharing later.
  _AC:_ a draft accepts a point with no `t` and reports it via `untimedIndices`; `toTrack()`
  throws `TrackDraftIncompleteError` naming those indices rather than inventing a timestamp;
  after `interpolateTimes` it succeeds; undo/redo restores exact prior state across every
  mutation, with `interpolateTimes` counting as **one** step; snapshots are deep, so nested
  `channels` in history survive later edits; the oldest states are evicted past the limit and a
  further undo is a no-op; a **rejected** mutation changes nothing — no state, no undo entry, no
  cleared redo, no `onChange`; one `onChange` per successful edit/undo/redo and none for an
  unavailable one; `interpolateTimes` preserves anchored timestamps, distributes by **distance**
  not index, and produces a non-decreasing series; `breakAt(i)` makes `i` begin a segment without
  duplicating it, and insert/remove shift boundaries predictably; `toTrack()` touches no history
  and fires no listener; output round-trips through `createTrackDraft(track)` unchanged; editing a
  track never mutates the input; timestamps supplied via `append`/`insertAt` are validated exactly
  as `setTimeAt` validates them, so `{ t: NaN }` cannot masquerade as timed and finalize into
  `NaN` statistics; `toTrack()` returns deep copies, so mutating the finalized track cannot reach
  back into the draft; a seeded draft preserves the source track's `id`, `tags`, `meta`, channel
  descriptors and laps, with laps shifted by edits and dropped when they no longer span anything;
  `interpolateTimes` **refuses to cross an unanchored break**, since a pause has a duration only
  the author knows and the leg across it was never travelled.
- **T1.10 Crash recovery.** `recoverInterruptedTrack(store)` and `listInterruptedTracks(store)`.
  _AC:_ a store holding a track left in `recording` or `paused` returns it; a store with only
  finalized tracks returns `undefined`; the most recently started wins when a device crashed more
  than once; it reads **summaries** and hydrates only the one candidate — proven by counting
  `getTrack` calls against a store holding twenty finalized tracks — and calls nothing at all when
  there is nothing to recover; the store is not modified.

## Phase 2 — `@mapatlas/storage-idb`
- **T2.1 Conformance suite.** `storageAdapterContract(createAdapter)` exported from
  **`@mapatlas/core/testing`**, beside the memory adapter. Public because `StorageAdapter` is
  meant to be implemented by third parties, and **framework-neutral by construction**: each case
  is `{ name, run }` where `run` throws an ordinary `Error`, so a consumer maps the cases into
  Vitest, Jest or `node:test` without inheriting ours. Every case takes a fresh adapter from the
  factory. _AC:_ the memory adapter passes every case; a summary case asserts the projection
  carries no point array and that counts and bbox match the stored track; an ordering case asserts the
  **returned order directly** (sorting it first would normalise away the behaviour under test) and
  is itself proven by running against a deliberately id-ordered adapter; a summary case asserts
  the full projection including `stats`, using a fixture that has them; cascade cases prove a track's events and
  orphaned blobs go with it while a still-referenced blob survives; copy-semantics cases catch an
  adapter that aliases the caller's object, which passes naive testing and breaks against
  serialising persistence — proven by running the contract against a deliberately aliasing
  adapter and asserting it fails.
- **T2.2 IndexedDB adapter.** Implement `StorageAdapter` over `idb`. A **separate summaries
  store** carrying its own `startedAt` index — IndexedDB has no projection, so listing from the
  tracks store would deserialize every point of every trip to draw a list that shows none of
  them. _AC:_ passes every case of the T2.1 contract (fake-indexeddb in tests, a uniquely named
  store per case, deleted afterwards); a track and its summary are written in **one transaction**,
  so neither is observable without the other; an overwrite that changes `startedAt` **reindexes**,
  leaving no stale entry and no duplicate; listing is a single ordered index traversal, proven by
  **instrumenting `IDBObjectStore` and `IDBIndex` reads** and asserting the tracks store is never
  opened — with a control case proving the instrumentation records anything at all, and a
  mutation check confirming a scan-and-sort implementation fails it; `eventCount` stays current as
  events are added and removed; `deleteTrack` cascades to its events and orphaned blobs while
  keeping a still-referenced one; `clearAll()` empties user data and leaves map assets untouched.
- **T2.3 Map asset store.** `createIdbMapAssetStore()` implementing `MapAssetStore` in a
  **separately named store**, not merely a separate object store: one name would put both behind
  a single lifecycle, one `deleteDatabase` or accidental `clear()` from taking the user's trips
  with the basemap. _AC:_ `StorageAdapter.clearAll()` leaves downloaded assets intact and
  `MapAssetStore.clear()` leaves tracks, events and blobs intact, each verified independently;
  `deleteTrack` does not reach into assets; the two keyspaces do not collide; and the asset store
  survives the user-data store being deleted outright.

## Phase 3 — `@mapatlas/recorder-web`
- **T3.1 `createWebTrackRecorder`.** `watchPosition` + sampling (T1.2) + Wake Lock + error map.
  _AC:_ with a mocked geolocation, emits only accuracy-passing points; `stop()` returns a
  finalized `Track` with `stats`; Wake Lock acquired on start, released on stop/pause.
- **T3.2 Segments + laps.** `pause`/`resume` close and open segments; `markLap` splits.
  _AC:_ a mocked record→pause→resume→stop run yields two segments whose index ranges do not
  overlap and cover every point; `markLap` twice yields two laps with per-lap stats.
- **T3.3 Sensor merge.** Accept `sensors: SensorSource[]`; merge per T1.8 into kept points and
  union descriptors into `Track.channels`. _AC:_ with a fake HR-like source, every kept point
  carries the channel and `stats.channels` reports its avg/min/max.
- **T3.4 Autosave + recovery.** Persist the in-progress track every `autosaveMs`.
  _AC:_ simulating a crash mid-recording, `recoverInterruptedTrack` returns a track containing
  all points written before the last autosave.

## Phase 4 — `@mapatlas/maplibre`
- **T4.1 MapController + layers.** Mount a MapLibre GL map, optional base `style`, ordered
  `TileSource[]` across raster/vector/`raster-dem` kinds, engine-owned `attributionPrefix`.
  _AC:_ base + overlay + vector composite in source order; attribution rendered verbatim; the
  library's built-in attribution default is not shipped.
- **T4.2 Terrain & topography.** `TerrainOptions` → 3D terrain + hillshade from a `raster-dem`
  source; `styleLayers` passthrough for contour/bathymetry layers. _AC:_ a fixture stack of
  DEM + hillshade + contours renders; `setTerrain(null)` fully removes terrain.
- **T4.3 Track & events render.** Live position, **one polyline per segment**, start/finish/lap
  marks, event marks, `fitTrack`, `fitBounds`, `recenter`. _AC:_ renders from fixtures; a
  two-segment fixture renders two lines with no connecting geometry across the pause.
- **T4.4 Presentation seam.** `EventPresentation` for event/start/finish/lap marks and
  per-segment line style; neutral built-in defaults when absent. _AC:_ two events of different
  `category` render with different consumer-supplied marks and their `ariaLabel`s; with no
  presentation supplied, neutral defaults render and no consumer branding appears.
- **T4.5 Draw/edit mode.** `renderDraft`, `enterDrawMode` with add/move/click vertex handlers
  and draggable vertices. A third-party drawing library may back this **only** if it is first
  verified against the exact pinned `maplibre-gl` version; the `TrackDraft` contract stays
  independent of it either way, so a failed spike costs only `@mapatlas/maplibre`.
  _AC:_ tapping appends a vertex, dragging moves one, the exit fn removes every listener and the
  draft layer; no drawing library appears in `@mapatlas/core`'s dependency tree.
- **T4.6 Vertical acceptance fixture.** One realistic end-to-end fixture, not a unit stub: a
  large track (≥5k raw points), a two-segment pause, a DEM + hillshade + contour source stack,
  two consumer-defined event marks, and a locally-persisted PMTiles region. Exercised as a test
  and reused by the demo. _AC:_ renders with the network disabled; the pause shows as a gap;
  frame time and memory are recorded as a baseline. Its purpose is to surface renderer and
  data-format assumptions here, in Phase 4, rather than in Phase 7 when they are expensive.
- **T4.7 Interaction + a11y.** `onMapTap`, `onEventClick`; controls keyboard-reachable, visible
  focus, `prefers-reduced-motion` respected. _AC:_ a11y checks pass in the demo shell; draw-mode
  vertices are keyboard-operable, not pointer-only.

## Phase 5 — `@mapatlas/react`
- **T5.1 Hooks.** `useTrackRecorder` (live `channels`, `markLap`, `recovered`), `useEventLog`,
  `useOfflineRegions`. _AC:_ tested with fakes.
- **T5.1b `useTrackList` + `useTrackDraft`.** Summary-backed trip list; draft editor exposing
  undo/redo and `save()`. _AC:_ the list renders from `listTrackSummaries()` without loading
  points; the draft hook's `save()` persists an `origin: "authored"` track.
- **T5.2 `<MapCanvas>`.** Wraps MapController incl. `style`/`terrain`/`presentation`/draw mode;
  SSR-safe (no window at import). _AC:_ renders track+events; toggling `drawMode` enters and
  exits cleanly.
- **T5.3 `<EventComposer>`.** Comment + in-place photo capture (`capture="environment"`) writing
  blobs via the required `store`; `mode` selects comment-first or camera-first; consumer
  `fields`/`categories` render into `MapEvent.fields`/`category`; settable `occurredAt`; if an
  `analyzer` is passed, "Analyze photo" → suggested labels the user confirms. _AC:_ saves a
  `MapEvent` whose `media[0].blobKey` resolves in the store; `mode: "photo"` opens capture first;
  a `FieldSpec` of each type round-trips into `fields`; analyze path works with `noopAnalyzer`;
  remote-analyzer disclosure shown when `runsRemotely`.
- **T5.4 `<TripReview>`.** Map (sources/terrain/presentation) + replay + events/photos + stats
  panel + per-channel charts. _AC:_ renders a finalized trip on a basemap with start/finish
  marks; a track with a `heartRateBpm`-style channel charts it against time with the
  descriptor's label and unit; a track with no channels renders without an empty chart frame.

## Phase 6 — Offline regions
- **T6.1 PMTiles region store.** `@mapatlas/offline-pmtiles`: implement `OfflineRegionStore`
  over a `MapAssetStore` (download bbox×zoom per `sourceIds`, list, delete, `estimateSize`).
  _AC:_ a downloaded region renders offline (network disabled in test/demo), including a
  vector/DEM source in the stack — proving bytes were **copied locally**, not range-requested;
  `download()` refuses a source flagged as not offline-licensed, and no test or demo fixture
  points `download()` at a community tile service (`architecture.md §8`).
- **T6.2 Persistence UX.** `navigator.storage.persist()` + install prompt guidance in the demo.

## Phase 7 — Demo + docs
- **T7.1 Demo app.** Generic field logger wiring recorder+map+event+storage+offline, analyzer
  slot defaulting to `noopAnalyzer`, a topographic source stack, a custom `EventPresentation`
  with two neutral categories, and a fake polling sensor channel. Every tile source in the demo
  must be one whose terms permit offline download. _AC:_ full record→pin→photo→review loop works
  **offline**, survives reload, exports valid GeoJSON; the demo's region download runs against a
  self-hosted or offline-licensed source only.
- **T7.1b Authoring + list flows.** A trip list from `listTrackSummaries()`, and a
  draw→set-times→pin→save flow. _AC:_ a hand-drawn trip appears in the list and reviews
  identically to a recorded one (same stats panel, same export shape, differing only in `origin`).
- **T7.1c Channel demo.** The fake sensor channel is recorded, persisted, charted in review, and
  survives GeoJSON round-trip. _AC:_ the exported file contains the channel arrays and
  re-importing reproduces the chart.
- **T7.2 Getting started.** Docs derived from `api.md`: embed the loop in an afternoon. _AC:_
  a new consumer following the doc reaches a working map+event loop.

## Global definition of done (every task)
`build` + `typecheck` (strict) + `lint` + `test` green · isolation & SPDX scans green ·
public API changes mirrored into `api.md` · consequential decisions appended to `decisions.md`.
