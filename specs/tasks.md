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
- **T0.8 Browser lane.** A `browser` job running **in parallel** with `gates`, never behind it,
  installing Chromium only. Playwright specs live under `e2e/` on a distinct pattern excluded
  from Vitest, so `npm test` stays browser-free and fast. It exists for what a fake cannot
  reach: real platform APIs, a real WebGL context, and — from T4.1 — MapLibre's ESM worker
  loading, which is what breaks on a major-version bump and precisely what a module mock hides.
  Browser binaries are deliberately **not cached**; Playwright's own guidance is that restoring
  a cached browser costs about what downloading it does. One worker in CI, since WebGL contexts
  are a shared finite resource and parallel workers make failures depend on what else was
  rendering. Traces and screenshots upload on failure. _AC:_ the job is required, runs
  concurrently, and covers the engine through real APIs rather than test-supplied ones.
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
  A private `WebRecorderEnvironment` — `now`, `watchPosition`/`clearWatch`, `requestWakeLock`
  returning a releasable lease, `setInterval`/`clearInterval` — is injected into an internal
  factory exported from its source module only. It stays **off** the public contract: the
  factory keeps the `TrackRecorderOptions` signature `api.md` publishes.
  _AC:_ with a driven environment, emits only accuracy-passing points; `stop()` returns a
  finalized `Track` with `stats`; Wake Lock acquired on start, released on stop **and** pause,
  and a lease resolving *after* the session ends is released rather than held; a geolocation
  callback queued before the watch was torn down is ignored, across both pause and stop, via a
  generation token; error codes map to their kinds and a transient failure does not end the
  recording; `start()` is idempotent and refuses to restart after producing a track; and one
  **public-factory smoke test** proves the real browser wiring — `navigator.geolocation` and
  `navigator.wakeLock` — which an injected environment can never demonstrate.
  _AC — the recorder owns its state:_ a point handed to `onPoint` is an independent deep copy, so
  a listener can neither corrupt sampling and finalization nor change what the next listener sees;
  and one recording has **one identity** — the track id is minted when recording begins, `stop()`
  is idempotent and returns the same track rather than reminting, segment ids are stable from the
  moment a segment opens, and a lifecycle call after finalization changes nothing.
  _AC — ADR-0020:_ a candidate strictly older than the last kept point is **dropped, never
  reordered**, even when far enough that `sample()` would otherwise accept it: it is neither
  stored nor emitted, and `stop()` still finalizes. The comparison is `candidate.t <
  lastKept.t` — equal timestamps stay valid — and is made against the last kept point
  **globally, including across pause and resume**, separately from the generation token that
  rejects obsolete callbacks. `sample()` is unchanged.
- **T3.2 Segments + laps.** `pause`/`resume` close and open segments; `markLap` splits.
  _AC:_ a driven record→pause→resume→stop run yields two segments whose index ranges do not
  overlap and cover every point, with distance and moving time excluding the gap; a pause that
  caught no fixes creates **no empty segment**, since an inverted range would fail the coverage
  invariant; the watch and the wake lock are both released on pause and retaken on resume, so a
  pause costs no battery; `markLap` twice yields two laps with per-lap stats, marking with
  nothing recorded since the last one is ignored, and laps are absent entirely unless marked.
- **T3.3 Sensor merge.** Accept `sensors: SensorSource[]`; merge per T1.8 into kept points and
  union descriptors into `Track.channels`. _AC:_ with a fake source, every kept point carries the
  channel and `stats.channels` reports its avg/min/max; telemetry is attached **only to points
  that survive sampling**, since a dropped fix is not a moment anyone will look at; the
  `SensorMergePolicy` is honoured for both reduce and `maxAgeMs`; sensors start and stop with the
  recording and across pause/resume; a sample arriving from an obsolete generation is ignored; and
  a sensor failure surfaces on `onError` with its `sourceId` **without ending the recording**.
  A sample dated *after* the current fix is **retained for the next point**, not discarded — the
  merge contract assigns it there, and a sensor clock running slightly ahead of the GPS would
  otherwise report nothing. The recorder owns what a source hands it: the configured array,
  each descriptor, and each sample are copied, so a source reusing one sample object cannot
  rewrite a buffered reading and mutating a descriptor after stop cannot rewrite the track.
  A `start()` still pending when pause or stop runs is reconciled on completion and stopped —
  unless a newer generation has since started it, which owns it.
  _AC — lifecycle edges:_ `stop()` before `start()` **rejects** rather than memoizing an empty
  track; the previous behaviour left `started` false, so a later `start()` succeeded while every
  subsequent `stop()` returned the cached empty track before any cleanup, leaving a live watch and
  status `recording`.
- **T3.4 Autosave + recovery.** Persist the in-progress track every `autosaveMs`, and continue
  one via `TrackRecorderOptions.resumeFrom`.
  _AC — the snapshot:_ raw and **unfinalized** — one canonical `startedAt` shared by every
  snapshot and the final write (never the first point's timestamp, which a snapshot taken before
  any fix does not have), `status` recording/paused, `origin: "recorded"`, deep-cloned points,
  closed segments plus the open one under its **stable id** and current `endIndex`, declared
  channel descriptors, and completed laps with `index` and timing derived but **no lap
  statistics**. No track statistics, no simplification, no `endedAt` — all derived (ADR-0022) and
  all a full pass over every point that nobody reads until the trip ends.
  _AC — ordering:_ pause sets status, closes the segment, tears down watch/lock/sensors, then
  **flushes immediately** rather than waiting for a tick, because a pause is often the last thing
  before an app is backgrounded and killed; the timer stays alive while paused, since a paused
  track is still recoverable. At most one write is in flight and only the newest pending snapshot
  is kept, so two writes cannot land out of order and leave an older picture on disk — proven by
  **genuinely holding a write in flight** while more snapshots are enqueued, asserting maximum
  concurrency of one, that superseded snapshots coalesce rather than accumulating a backlog, and
  that `stop()` waits for the held write before landing last. `stop()`
  clears the timer, drains the queue, then saves the finalized track **last** under the same id;
  the `stopPromise` is memoized, not just the result, so concurrent stops await one drain and
  produce exactly one final save.
  _AC — the interval is validated:_ exactly `0` or a positive finite number of milliseconds;
  anything else throws `RangeError` rather than acquiring an undocumented meaning — `Infinity`
  reached `setInterval` unchanged, and negative or `NaN` values quietly meant "disabled", which
  only `0` means. Same boundary the polling sensor source enforces.
  _AC — errors name their own cause:_ two configured sensors defining one key differently raise
  `ChannelConflictError`, not `RecorderResumeError`; that path runs whether or not a track is
  being resumed, and reporting "cannot resume this track" sends a reader looking for a snapshot
  that never existed. `RecorderResumeError` is reserved for restored-state validation.
  _AC — one enablement rule:_ autosave is on when a store exists **and** the interval is
  positive, resolved once so the periodic write and the pause flush cannot disagree. Omitting
  `autosaveMs` uses the documented default; `0` writes nothing at all, pause included, while
  `stop()` still saves the finished track — disabling autosave asks for no *periodic* writes, not
  for the trip to be discarded.
  _AC — what may be resumed:_ `status` must be `recording` or `paused` and `origin` must be
  `recorded`. A finalized track is a durable trip, and resuming one would let a partial recording
  overwrite it under its own id.
  _AC — channel conflicts:_ the **whole normalised definition** is compared — label, unit,
  aggregate, bounds and precision — not just label and unit. `aggregate` decides whether
  `computeStats` sums or averages, so a change to it changes what every stored value means; an
  omitted one normalises to the documented `"avg"`. The same check applies **between configured
  sensors**, where a bare `Map` would let the last source win and produce a track labelled one way
  holding values measured another.
  _AC — failures:_ a rejected autosave surfaces as a `storage` error, does not poison the queue,
  does not become an unhandled rejection, and does not end the recording; a failed **final** save
  rejects `stop()` and can be retried, since the finalized track is already memoized.
  _AC — resumption:_ `resumeFrom` preserves id, points, laps, channels and the original
  `startedAt`; **always opens a new segment**, the crash interval being an unobserved gap; and
  restores `lastKept` so the first post-recovery fix still faces ADR-0020 — a fix older than the
  last restored point but far enough for `sample()` to accept is **dropped**, while one sharing
  its timestamp is kept. Restored points are validated as **globally** non-decreasing, stricter
  than `assertValidTrackGeometry`, which checks chronology within a segment only; and recovered
  channel descriptors are merged with newly declared ones, appending new keys but **rejecting a
  conflicting definition** for an existing one rather than reinterpreting stored values.

## Phase 4 — `@mapatlas/maplibre`
- **T4.1a Pure builders.** `buildTileSources` (`TileSource` → MapLibre sources and layers) and
  the track GeoJSON builders (`Track` → one `LineString` per segment, endpoint and lap marks).
  Deterministic translation with **no side effects at all**: they run in Node with no DOM, no
  WebGL and no map, and describing a source never depends on a runtime being present.
  _AC:_ each `kind` maps to the right MapLibre source type and each `transport` to the right url
  shape, with **nothing inferred** (ADR-0023) — in particular the builder adds MapLibre's
  `pmtiles://` scheme exactly once for all three kinds, never appending `/{z}/{x}/{y}`, and
  rejects a url already carrying the scheme, since it is the renderer's to add and no other
  renderer can read it; `styleLayers` pass through verbatim with only `source` and a namespaced
  `id` filled in, since the engine has no opinion about how contours or bathymetry look, but
  **deep-copied**, so mutating a nested `paint`, `layout`, `filter` or expression array
  afterwards cannot change what was installed — prepared state is a snapshot, not a view, or the
  call-time validation guarantee holds only at the top level;
  **every** supplied layer id is namespaced so two sources each carrying `labels` yield
  `a__labels` and `b__labels`; empty attribution is rejected, being a licence obligation; a WMS
  url without a bbox placeholder is rejected, since it renders one extent everywhere and reports
  nothing, as is a WMS source of non-`raster` kind; duplicate source ids are rejected, as are
  duplicate **final** layer ids across the whole stack — namespacing makes a collision unlikely
  rather than impossible, since one source can supply `labels` twice and `a__b` carrying `c`
  collides with `a` carrying `b__c`; order is preserved and the first source defaults to `base`; geometry prefers `simplifiedSegments[n]` and
  falls back to slicing raw points; a singleton segment emits **no line feature** while keeping
  its endpoint mark; and no empty or single-position `LineString` is ever emitted, asserted
  across every fixture.
- **T4.1b PMTiles protocol bootstrap.** `ensurePmtilesProtocol`, module-level and lazy.
  `addProtocol` installs a handler on the MapLibre **runtime**, not on a map, so this is
  package-lifecycle state rather than controller state — and `destroy()` deliberately does **not**
  unregister it, because controller A tearing down infrastructure controller B still needs is a
  bug with no owner. _AC:_ no PMTiles source means no `Protocol` is constructed and the global is
  untouched; any number of controllers over PMTiles sources produce exactly **one** registration;
  and the module exposes no unregister for a controller to reach for, and no test-only reset —
  a test needing a fresh realm re-imports the module. The builders themselves stay **internal**:
  the package publishes the controller, not MapLibre's style specifications.
- **T4.1 MapController + layers.** Mount a MapLibre GL map, optional base `style`, ordered
  `TileSource[]` across raster/vector/`raster-dem` kinds, engine-owned `attributionPrefix`.
  Construction is synchronous for the consumer, but source installation waits for MapLibre's
  `load` event, so the narrow `MapLike` fake carries the load/event seam rather than just
  `addSource`/`addLayer`.
  _AC:_ base + overlay + vector composite in source order, which is MapLibre's draw order;
  attribution rendered verbatim; the library's built-in attribution default is **not** shipped —
  the control is constructed explicitly, never inherited; with no `style`, an explicit empty v8
  document rather than a style-less map that would need `setStyle()` before rendering; desired
  state is translated and validated **at the call**, so `setSources` either throws to its caller
  or is guaranteed installable, and an invalid initial stack throws without constructing a map at
  all — validating at install would make rejection asynchronous, surfacing from inside MapLibre's
  `load` callback where no caller can catch it and the last valid stack is already abandoned;
  before load, `setSources` replaces desired state only and load reconciles the latest **exactly
  once**, so `setSources(A); setSources(B); load` installs B and never A; after load, replacement
  removes old layers, then old sources, then adds the new stack in declared order, and a rejected
  `setSources` leaves the visible map intact;
  `ensurePmtilesProtocol` is called only for a stack containing `transport: "pmtiles"` and only
  before that source is added — controller A without PMTiles registers nothing, B registers once,
  C registers nothing further, and destroying B leaves the protocol registered.

  Every guard above is **mutation-tested**: reversing the removal order, registering the protocol
  after `addSource`, dropping the once-only load guard, installing eagerly, queuing commands
  instead of modelling desired state, deferring validation to install, dropping either layer-id
  uniqueness check, shallow-copying style layers at any of three depths, swapping lng/lat, and inheriting the attribution default each fail at least
  one test. Two are settled in the browser, where a fake cannot: without the attribution override
  MapLibre 6.6.0 renders `"© OpenStreetMap contributors | MapLibre"`, and the PMTiles pair fails
  in both directions — never registering breaks the positive case, registering unconditionally
  breaks the negative one.

  The browser lane is **typechecked**: `e2e/**` is in `tsconfig.tests.json`, whose `paths` mirror
  the harness's vite aliases and must move with them.
- **T4.2 Terrain & topography.** `TerrainOptions` → 3D terrain + hillshade from a `raster-dem`
  source; `styleLayers` passthrough for contour/bathymetry layers.

  The governing rule: **terrain is prepared desired state over the source stack.** A
  source-stack replacement is *atomic* with respect to terrain — compatibility is validated
  before any mutation; when applied terrain exists it is cleared before any old source is
  removed, and restored only after the replacement sources and layers are installed. Terrain is
  a consumer of the source stack exactly as layers are, not an exception to it, so when T4.3
  adds track and event sources they join the same ordering rather than becoming a second
  special case.

  _AC:_ a fixture stack of DEM + hillshade + contours renders, proven by asking MapLibre whether
  the generated layer ids `dem__shade` and `contours__lines` are in the style — the library can
  report a layer-validation error and return **without adding the layer** rather than throwing,
  so "no exception" and "the source's attribution appeared" both go green on a stack whose
  layers were silently dropped; `setTerrain(null)` fully removes terrain, proven by the
  library's own `getTerrain()` going null.

  `setTerrain` is validated **against desired sources, not the installed map** — before load
  the map holds nothing, so validating against it would accept everything and fail later. The
  named source must exist and have `kind === "raster-dem"`; `role` is deliberately not checked,
  since `kind` states capability while `role` states stack behaviour and a DEM may drive terrain
  while also carrying a hillshade layer. `exaggeration` must be finite and `>= 0` per the style
  spec — zero accepted, negative and non-finite rejected.

  Two of those are checks MapLibre 6.6 also makes: it validates a `TerrainSpecification` and
  rejects a source the style does not hold. The value here is **when** — synchronously, at this
  package's own public boundary, rather than from inside a `load` callback no caller can catch.
  The source *kind* cross-check is the one MapLibre makes at no point: terrain over ordinary
  imagery renders flat, indistinguishable from a DEM whose tiles failed.

  Desired terrain is stored separately from renderer-applied terrain; applied state is **read
  from the renderer, never mirrored**. `setTerrain(dem); setTerrain(null);
  setTerrain(dem2)` before load makes **zero** MapLibre calls, and load makes exactly one, after
  the sources. After load, replacing terrain needs no `null` between — MapLibre takes a new
  definition directly; the explicit release exists only for the case where the DEM is about to
  be removed. Reconciliation order is: release terrain → remove layers → remove sources → add
  sources → add layers → apply terrain.

  `setSources` re-validates the standing terrain against the prospective stack and assigns
  **nothing** until both pass, so a stack that would orphan terrain — by dropping the DEM, or by
  keeping its id while changing its kind — throws and leaves desired state untouched. The
  map-untouched assertion cannot see this before load, where there is nothing to touch: the
  falsifying case is that a rejected call must not change what a later `load` installs.

  The fake refuses `removeSource` while terrain references it, which makes the four-phase order
  a behavioural requirement rather than an assertion about a call log. That rule is
  **deliberately stronger than MapLibre 6.6**, which checks only layer references there:
  MAP-ATLAS treats terrain as a dependency of the sources it names, like any other consumer of
  the stack.

  Applied terrain is **read from the map, never mirrored in a flag**. A base `style` may declare
  its own `terrain`, which MapLibre applies as the style loads — before the controller has done
  anything. A remembered "what I applied" flag starts at `null` in that case and stays wrong,
  leaving style terrain running under a controller reporting none. The controller is
  authoritative: desired terrain of `null` clears whatever the map actually has. Pinned in the
  browser as a pair, since one test alone cannot distinguish clearing from absence — the first
  proves MapLibre applies a style's terrain unaided, the second proves the controller then
  clears it.

  Twelve terrain mutations each fail at least one test, four of them in the browser.
- **T4.3 Track, events & draft render.** `renderTrack`, `renderEvents`, `renderDraft`,
  `showLivePosition`, `fitTrack`, `fitBounds`, `recenter`. **Not** `enterDrawMode` — that is
  interaction, needs its own event seam, and is T4.5.
  Geometry comes from `simplifiedSegments[n]` when present, falling back to slicing the raw
  points for `segments[n]` — the cache is disposable (ADR-0018), so a track that arrives without
  it must still draw rather than render nothing.
  A **singleton segment** gets no line feature at all: a GeoJSON `LineString` needs at least two
  positions, so one point cannot be a line. Its endpoint and marker rendering stay, since a
  single kept fix is still a place the user was.

  **Engine state is namespaced and persistent.** Reserved prefix `mapatlas:` for every
  engine-owned source and layer id; a consumer `TileSource` claiming it is rejected during
  preparation, before desired state changes, exactly as a duplicate id is. Consumer and engine
  registries are kept apart so `setSources` tears down only consumer state.

  Ordering belongs to **layers**, not sources: replacing consumer sources would otherwise add
  their layers above a persistent track layer. `MapLike.addLayer` takes a `beforeId`, and
  consumer layers are inserted before a stable engine anchor so they stay below engine overlays
  without those overlays being torn down and rebuilt.

  Engine sources are installed **once** after load and updated through `setData` thereafter, so
  live position and draft edits cause no layer-order drift and no teardown churn.
  `renderTrack(null)`, `renderEvents([])`, `renderDraft(null)` and `showLivePosition(null)` apply
  **empty feature collections** and remove the corresponding DOM markers rather than removing
  sources and layers.

  The renderer's stylesheet is the **consumer's** to load, and `api.md` says so: a package
  that injects global CSS decides something about the host document that belongs to the
  application. Without it markers lay out in normal flow rather than absolutely against the
  map, so the browser lane loads it and asserts marks land **inside the map container** —
  bounds alone pass while a mark sits hundreds of pixels below it.

  Telling a consumer to import `maplibre-gl/dist/maplibre-gl.css` obliges the engine to make
  that path resolvable *from their project*, so `maplibre-gl` is a **peer dependency** rather
  than a bundled one. There is a correctness reason as well as a packaging one: `addProtocol`
  registers on a MapLibre **module instance**, so a second nested copy would register PMTiles
  on a runtime that is not drawing the consumer's map, and an archive would silently fail to
  load. `npm run check:packaging` packs the real tarballs and installs them with
  `--install-strategy=nested`, which is the one environment no other gate reaches: inside this
  workspace every dependency is hoisted and an undeclared import resolves anyway.

  That gate also enforces **T0.1's no-ranges rule on the peer itself**, against the packed
  manifest a consumer's resolver actually reads: the peer must name one exact version and it
  must be the version this repository tests. A caret would let a fresh install resolve a 6.x
  release the browser lane has never run — and without the check, reintroducing one passes
  every other gate, which is precisely how it got in.

  The watch validates what it is *handed*, not only what reaches it: a global or sticky pattern
  is refused, because `test()` on one advances `lastIndex` and matches would alternate; a count
  below one is refused, because "match this and expect none" is a suppression wearing a count
  and an undeclared error already fails. Declarations are first-match-wins, so a declaration
  that matched nothing while a broader one absorbed its lines is reported as **shadowed**
  rather than as the subject having failed to run — that misdiagnosis is reachable with two
  declarations in one test, and it is the exact failure this file exists to prevent.

  A residual imprecision, recorded rather than left implicit: `settled()` polls a count that
  grows, so a sample taken while a chain is mid-flight can end a wait early. The bound on that is
  a signal saying rendering has finished — an idle or render-complete event — reaching
  `settled()` through the environment seam the way reduced-motion does, at which point the fake
  can drive the timing deterministically instead of the poll interval having to be unlucky in
  our favour. An extension, not a defect.

  It checks the **lockfile against the manifests** first, because `npm ci` does not: `npm ci`
  validates that the resolution graph can be satisfied, and a peer range is not part of that
  graph, so a manifest edited without a reinstall leaves a lockfile contradicting the package
  it locks while every gate stays green. Verified rather than assumed — reverting the
  lockfile's peer to `^6.6.0` passes `npm ci` cleanly.

  **Marks are DOM markers**, since `MarkerStyle.html` is inserted verbatim and must be
  keyboard-reachable. Marker construction belongs to `MapEnvironment`, not `MapLike`: the
  environment owns the renderer's constructors, the map instance owns map operations. A marker
  is not accessible for having an `aria-label`, so the engine owns a wrapper element carrying
  the `aria-label`, a `tabIndex`, an appropriate `role`, and Enter/Space activation for
  clickable event marks; consumer-authored `html` is inserted inside it.

  _AC:_ renders from fixtures; a two-segment fixture renders two lines with no connecting
  geometry across the pause; a track with `simplifiedSegments` deleted renders identically in
  shape; a one-point segment produces marks but no line, and no empty or single-position
  `LineString` is ever emitted; a consumer source id under `mapatlas:` is rejected before any
  state changes; replacing consumer sources leaves engine sources, layers and their relative
  order untouched; clearing any engine layer applies an empty collection rather than removing
  it; a mark that persists across a re-render is **moved, not rebuilt**, since recreating the
  element would drop the focus a keyboard user is holding; every marker the engine creates
  satisfies the full accessibility contract.

  **What each lane proves.** Layer *ordering* is settled deterministically: the fake models
  insertion position and rejects an unknown `beforeId` exactly as MapLibre does, so appending
  instead of anchoring fails there. The browser lane proves something different and
  complementary — that MapLibre accepts the engine's layers at all, filter expressions included,
  and that a **broken** anchor fails loudly. It does not prove ordering, because `getLayer` says
  nothing about position; the claim is not made.
- **T4.4 Presentation seam.** `setPresentation`, `EventPresentation` for event/start/finish/lap
  marks and per-segment line style; neutral built-in defaults when absent.
  `setPresentation` **prepares the currently desired track and events against the prospective
  presentation before committing it**, so a consumer callback that throws leaves both the
  visible map and desired state unchanged — the same transactional rule `setSources` follows for
  terrain.

  **A mark whose `anchor` changes must be rebuilt, not reused.** T4.3 reuses a mark's element
  across renders to preserve focus and reapplies its style, but the renderer fixes `anchor` when
  the marker is constructed and it cannot be updated after. That is safe in T4.3 only because
  every built-in mark's anchor follows from its kind, so a reused element always describes the
  same kind of mark. Consumer-chosen anchors end that guarantee. Reuse therefore turns on
  **identity and anchor together** — and on nothing else: a changed class, colour, size, name or
  markup is a refresh, since rebuilding for those would discard focus for no reason.

  **A presentation is prepared state, never a callback retained and run later.** Every callback
  runs at the call that installs it or supplies data — `setPresentation`, `renderTrack`,
  `renderEvents` — against what is already desired, and **all of it completes before anything is
  committed or reconciled**. Transactional stored state is not enough: a marker rebuilt before a
  later callback threw has already lost its focus, whatever the stored state says afterwards.
  Callback results are snapshotted for the same reason prepared geometry is — a presentation
  reusing one style object could otherwise change the map at the next unrelated reconcile.

  `setPresentation(null)` is a real transition back to neutral defaults, applied immediately
  rather than at the next render; a callback returning `null` suppresses that mark entirely,
  which is a decision rather than an absence.

  Per-segment line styling is **data-driven**, folded into each feature and read by a `coalesce`
  expression, because one layer per segment would mean a hundred layers for a track with a
  hundred pauses. `dashed` is the exception MapLibre will not data-drive, so it gets a second
  layer filtered on the same property.

  _AC:_ consumer marks carry their own accessible names; a presentation applies to what is
  already drawn without waiting for another render; `null` returns suppress marks and
  `setPresentation(null)` restores the engine's; a throwing callback at any of the three entry
  points leaves visible and desired state untouched **and touches no marker at all**, proven by
  a case where an anchor change would force a rebuild before a later callback throws; reuse
  survives a style change and rebuilds on an anchor change.

  Eight mutations, and two lanes that catch different halves: a *retained* callback evaluated
  during reconciliation, and an *incremental* apply, both fail in the unit lane; committing the
  presentation before preparing survives there — with no track rendered there is nothing to
  churn — and fails in the browser, where the same element must still be present afterwards. _AC:_ two events of different `category` render with different consumer-supplied
  marks and their `ariaLabel`s; with no presentation supplied, neutral defaults render and no
  consumer branding appears; a presentation whose `marker()` throws changes nothing.
- **T4.5 Draw/edit mode.** `enterDrawMode` with add/move/click vertex handlers and draggable
  vertices, over the draft geometry T4.3 already renders, plus one real-browser drag. Its own
  deterministic event seam — pointer events, vertex hit-testing and drag are what make this a
  separate task rather than an appendix to the render surface. No drawing library: the
  interaction is small and the engine already owns the geometry.

  **`exit()` owns interaction state only.** It removes the permanent and in-flight listeners and
  restores the map's pan behaviour to what it found. It does **not** remove the draft source or
  layers, and does not clear their data — `renderDraft(null)` alone clears persistent geometry.
  This supersedes the original wording, which predates T4.3's decision to make engine layers
  persistent so their ordering could not drift.

  The down event calls `preventDefault()` **before** anything else — the renderer decides at
  gesture start whether it owns the pointer, so disabling `dragPan` inside the callback can
  already be too late. Panning is restored to its **entry state**, not enabled, since a consumer
  may have disabled it themselves.

  **A stale gesture is discarded by the next press, not at the end of its own.** Whether a click
  follows a gesture is the renderer's decision, made against a movement tolerance that is not
  ours to know: it sends one for a press that stayed within it and none for a press that passed
  it. So the end of a gesture releases the drag and keeps the gesture, and the two things that
  can happen to it both do the right thing — a click consumes it, and the next press discards
  it. Clearing at the end instead lets a press that drifted two pixels off a vertex fall through
  to the hit test and be taken as an instruction to add one; never clearing lets a completed
  drag's gesture be consumed by the user's next unrelated tap, which then does nothing at all,
  once per drag. `mouseout`/`touchcancel` clear immediately, since a cancelled gesture is
  followed by nothing.

  **Ending comes from the document, not the map.** The map's `mouseup` fires only for a release
  over its container, so a drag ending a pixel past the edge — ordinary near a map's border —
  would never end and the borrowed pan behaviour would never come back. `mouseout` looks like
  the answer and is not: it bubbles, so it fires when the pointer crosses a *marker inside the
  map*, and cancelling there re-enables panning while the button is still down, leaving the rest
  of the gesture to pan the map under the vertex being dragged. Measured before it was fixed:
  dragging a vertex across a mark 75px away restored panning at exactly that point and lost half
  the remaining moves. So `MapEnvironment` supplies a document-level pointer release, and
  `touchcancel` stays on the map, where a cancellation is genuine.

  A consumer callback that throws cancels **only the active drag** — panning back, temporary
  listeners detached, gesture cleared, the session still live for another attempt — and
  rethrows. `exit()` and `destroy()` use the same cleanup path. One session at a time: a second
  `enterDrawMode` is refused rather than leaving two claims on `dragPan` nobody could reason
  about. `exit()` is idempotent, and a drag never also reports a vertex click or a vertex add.

  _AC:_ every rule above, mutation-tested; and a **real-browser drag** proving the vertex moved,
  the camera did not, and panning was restored — the camera observed through a mark anchored to
  a coordinate rather than by widening the seam to read it.

  The browser lane serves the hosts these specs invent — a real 256×256 PNG for raster and DEM
  templates, a TileJSON pointing back at it, an empty vector tile — and **fails on any console
  error a test has not declared, and on any declared error that never arrives**. A declaration
  is an expectation, not a suppression: one that merely permitted its error would let a test
  claiming "this error proves the handler was reached" pass in exactly the case it exists to
  rule out, where nothing ran and no error occurred. It carries a required reason, since an
  unexplained pattern is indistinguishable from a silenced defect, and the watch has its own
  tests for the same reason the fake map does. Before the worker was wired up nothing was ever requested, so
  the invented hosts cost nothing; with it working, a green run printed several hundred lines of
  `AJAXError`. Noise on that scale is where a real failure hides, and a lane that always prints
  errors cannot fail on one. The archive host answers too, with bytes that are not an archive,
  so the PMTiles cases see exactly the one error they are about rather than that plus a
  name-resolution failure underneath it.

  **Consumers must call `setWorkerUrl`.** MapLibre loads its worker as a separate module
  resolved relative to the importing chunk, so a bundler that rewrites imports resolves it
  beside the rewritten chunk and the request 404s. Nothing errors: the map is constructed, the
  style parses, sources emit `sourcedata`, and nothing is ever painted. Found here because the
  browser lane had never verified that anything renders — every assertion before this task was
  about the DOM and MapLibre's style state. The harness now sets it, and the lane paints;
  documented in `api.md` and the package README as the consumer requirement it is.

- **T4.6 Vertical acceptance fixture.** Implementation plan:
  [`specs/plans/t4-6-vertical-fixture.md`](plans/t4-6-vertical-fixture.md). ADR-0024 has settled
  the elevation source outright:
  **Copernicus DEM GLO-30 Public**, whatever region is chosen. The input that used to remain —
  whether the region is US-only, selecting 3DEP instead — was gated on the engine sampling
  elevation from the DEM, which it does not do anywhere; the ADR's amendment records the three
  checks. The region is therefore an ordinary fixture choice rather than a decision the source
  depends on — but a **constrained** one: **above the treeline and inland**, the second defined operationally — the cut requires only
  published tiles and every decoded sample clears the floor, which is obligations 2, 3 and 4
  rather than a fourth check, and which enforces no ocean intersection rather than distance from
  a coastline. The contour geometry
  this script generates is the one live consumer of the DSM/DTM difference, and above the
  treeline the two converge; inland keeps the fixture off the coast, where GLO-30 Public ships no
  ocean tiles and terrarium has no no-data value with which to say a tile is absent at all.

  **Four build-script obligations, each of which makes something checked rather than trusted.**
  Every one of them **fails the build**; none of them warns. An obligation that logs is an
  obligation someone walks past, and three of these four first fail on the day a region changes
  or an upstream release does — which is to say, not on the day anyone is watching for them.

  1. The attribution and liability strings are checked against the licence document and written
     into the archive.
  2. Released coverage is verified **per tile, not per country** — withholding is at tile
     granularity, so a region can be partially covered with no country-level list saying so.
  3. A gap **fails the build** rather than being filled, since terrarium has no no-data value:
     every one of its 2^24 triples decodes to a valid elevation, so absence cannot be
     expressed — a zero-byte fill reads as −32768 m, the bottom of the range, and sea level is
     `RGB(128, 0, 0)` rather than zero because the formula carries a fixed offset. The failure
     **names the tile** — "no published tile at N45E007", not "gap in coverage", which sends a
     reader to debug the fetcher for a file that was never going to arrive.
  4. The region declares a **minimum-elevation floor** beside its bounds, and the cut region's
     lowest sample is checked against it, from the DEM already open for encoding. This is what
     makes "above the treeline" enforced rather than described: a box can satisfy it in
     aggregate and still hold a forested valley floor in one corner, and left as prose it is a
     premise that stops being true the first time someone widens the bounds. Declared per region
     because the treeline is a function of latitude; what is fixed is that a number must be
     given, justified and met.

  Two additions beyond the
  original scope: it is reachable as a human-openable `/lab` route in `apps/demo` — through the
  packages' public entry points, sharing one fixture with the Playwright scenario, while
  `e2e/harness` stays automation-only — and it carries a **simulated GPS mode**, so the demo can
  be operated from a desk rather than by walking around.

  One realistic end-to-end fixture, not a unit stub: a large track (≥5k raw points), a
  two-segment pause, a DEM + hillshade + contour source stack, two consumer-defined event marks,
  and a **synthetic PMTiles pair cut by the real writer into test-local temporary files**, whose
  range reads are fulfilled locally with **no external egress**. *Narrowed 2026-08-31 from "a
  locally-persisted PMTiles region", which overreached the T6.1 boundary:*
  `@mapatlas/offline-pmtiles` is a deliberate stub until T6.1, whose acceptance criterion is that
  archives were copied into `MapAssetStore` and survive offline. **Browser persistence and reload
  survival are T6.1's and are not claimed here.** Exercised as a test and reused by the demo.
  _AC:_ renders with no network egress permitted; the pause shows as a gap;
  frame time and memory are recorded as a baseline. Its purpose is to surface renderer and
  data-format assumptions here, in Phase 4, rather than in Phase 7 when they are expensive.

  **Done** (2026-09-01, PR #9 and #10). Each criterion, and what discharges it:

  - *No external egress.* `e2e/lab.e2e.ts` guards both seams — `page.route` for HTTP and
    `page.routeWebSocket` for sockets it never sees — failing rather than counting an unexpected
    request, and each guard falsified by a decoy origin that shares a textual prefix with an
    allowed one. Both archives are read by range, asserted per archive.
  - *The pause shows as a gap.* `e2e/render-differential.e2e.ts` proves it as a set relation:
    the two-segment render's track pixels are exactly the union of each segment's, measured at
    0 added and 0 lost, while a deliberately bridged control contributes 827 pixels of its own
    in the corridor that the real render does not contain.
  - *A recorded baseline.* `e2e/performance-baseline.e2e.ts`, with macOS and Ubuntu columns in
    the plan and **no thresholds** — deliberately, since two consecutive CI runs of unchanged
    code measured medians of 33.4 ms and 50.0 ms.

  **Follow-up — DEM tile-size fidelity.** Removing `tileSize: 256` still renders terrain and
  hillshade, but at a different scale; current evidence proves presence, not which rendering is
  spatially correct. This is **not** a blocker for T4.6 and remains an explicit future fidelity
  acceptance property.
- **T4.7 Interaction + a11y.** `onMapTap`, `onEventClick`; controls keyboard-reachable, visible
  focus, `prefers-reduced-motion` respected. Completes `MapController`, so this is the task that
  puts `createMapController` on the package barrel and makes `api.md`'s declaration true.

  **The renderer's keyboard handler looked like a second `dragPan`, and is not.** MapLibre's
  canvas is focusable and binds the arrow keys to pan and `+`/`-` to zoom, and keyboard vertex
  movement wants the arrows too — which reads as the borrow-and-give-back problem draw mode
  already solves for panning. Measurement below shows the two never contend, so `map.keyboard`
  does **not** go on the seam and nothing is borrowed. Focus is the whole mechanism.

  **Keyboard-operable vertices are an architectural fork, not an attribute.** Draft vertices are
  layer features painted into the canvas: there is nothing to focus, nothing in the tab order,
  and nothing assistive technology can see. Two shapes exist — a parallel DOM layer of focusable
  elements positioned over each vertex, or one focusable canvas with a roving selection index and
  `aria-live` announcements.

  **Decision: the parallel DOM layer.** A draft is authored by hand, so its vertices number in
  the tens rather than the thousands, and the cost that rules the DOM approach out at scale does
  not arise. In exchange it gets real focus rings, a real tab order and real hit targets from the
  platform rather than reimplemented by us — and it reuses the accessible wrapper T4.3 already
  built for marks, so the machinery exists and is already tested. The roving-index shape would
  mean owning the entire accessibility surface by hand for a saving that does not apply here.
  The canvas vertices stay: they are what the pointer hit-tests, and what a mouse user sees.

  **One tab stop, not one per vertex.** Roving `tabindex` across the vertex elements: the group
  takes a single stop, arrows move between vertices within it. Forty vertices as forty stops
  would put a whole draft between the map and whatever follows it, and someone tabbing *past* a
  map should not have to traverse its geometry. This is the composite-widget pattern, and it is
  a separate question from the fork above, which was about roving over a single canvas.

  **The keyboard gesture is the pointer gesture.** Arrows are claimed three times over — map
  pan, focus movement between vertices, and nudging the focused one — so the collision is
  settled before any handler is written, rather than by whichever runs first. A vertex is
  **grabbed** (Enter or Space), **nudged** while grabbed (arrows), and **dropped** (Enter or
  Space) or **cancelled** (Escape); ungrabbed, Left and Right move focus by index and Up and
  Down do nothing at all — array order is not screen order for a hand-drawn line, so a vertical
  key would move focus against the direction pressed, and a key a control does not act on
  should reach the page rather than be swallowed. Both axes return once a vertex is grabbed,
  where the movement genuinely is geometric. A nudge is one screen pixel,
  and ten with Shift — the renderer's own draggable marker offers both, and shipping only the
  fine one would leave the keyboard path an order of magnitude slower than the pointer path in
  the task whose whole point is that they are equals. That is the same shape as the
  pointer path — press, move, release — so it reports through the same `onVertexMove`, with the
  grabbed state playing the part the drag plays there.

  **Measured, not reasoned: the arrow keys are already partitioned by focus.** A focusable
  element appended to the map container, with a `keydown` listener, arrows pressed five times
  per row, in Chromium against `maplibre-gl` 6.6.0:

  | focus | `stopPropagation` | arrows pan the map | vertex element sees the key |
  | --- | --- | --- | --- |
  | vertex element | no | no | yes |
  | vertex element | yes | no | yes |
  | canvas | no | **yes** | no |
  | canvas | yes | **yes** | no |
  | vertex element, after `map.keyboard.disable()` | either | no | yes |
  | canvas, after `map.keyboard.disable()` | either | no | no |

  `KeyboardHandler` binds to the canvas, which is a *sibling* of the vertex layer rather than an
  ancestor of it. A keydown at a vertex therefore never traverses it — there is nothing for
  `stopPropagation` to stop — and a keydown at the canvas never traverses the vertex, which is
  why the element hears nothing in the canvas rows whatever `map.keyboard` is doing. The two
  handlers are not competing for one event stream; they are on disjoint ones, selected by focus.

  **So nothing is borrowed, and `map.keyboard` stays off the seam.** The apparent hole — the
  canvas taking focus mid-grab — closes on its own, because focus transfer is synchronous and
  a keydown is a later task: the vertex is blurred before any arrow can reach the canvas. If
  blur ends the grab, there is no instant at which a grab is live and the canvas is focused, so
  disabling the pan would only be suppressing a handler that could never have fired. Shipping
  the borrow anyway would be the same mistake as shipping `stopPropagation`: a line that looks
  protective, is unobservable, and has to be re-reasoned every time someone reads it.

  **The contract is therefore focus-scoped grab cleanup, and it has two entrances.** Blur is the
  ordinary one — a click on the canvas, a tab away, the window losing focus — and it must cancel
  synchronously, not on a microtask, or the guarantee above is only mostly true. The other is
  reconciliation: when `renderDraft` removes the focused element, the DOM may move focus to the
  body **without firing `blur` at all**, so the removal path must cancel through the same
  cleanup rather than relying on the event. One cleanup, two callers — the shape draw mode
  already uses for `releaseDrag`.

  **Escape needs no special handling at the map.** Measured with focus on a vertex, it reaches
  the element's own listener and focus stays put — neither MapLibre nor browser-level UI
  consumes it — so the cancel key is an ordinary element listener.

  **Two representations of one vertex is a new failure mode.** Deleting vertex 2 shifts every
  index above it while a focused DOM element still holds the old one. Two contracts: the DOM
  layer's indices match the source features after **every** `renderDraft`, including removal and
  reorder; and when the focused vertex stops existing, focus moves somewhere defined — the
  vertex that took its index, else the previous one, else the group — never nowhere, which is
  what the DOM does by default and which drops the user back to the top of the page.

  **The focus ring's colour belongs to the consumer.** It is drawn over whatever the basemap
  shows, so no fixed value can satisfy WCAG's non-text contrast requirement against satellite
  imagery — and an inline style cannot be overridden without `!important`, which would make the
  styling decision on the application's behalf in a package that argues that decision is
  theirs. The colour goes behind `--mapatlas-focus-ring-color` with the default as its
  fallback; the geometry stays fixed, being what makes the ring perceivable rather than what a
  contrast problem is about.

  **`pointer-events: none` on the vertex layer needs a behavioural guard, not a stylesheet
  line.** The pointer path is canvas hit-testing; if the DOM layer ever becomes the pointer
  target, `queryRenderedFeatures` stops being exercised and every unit test still passes, since
  the fake cannot see DOM. The browser drag test is that guard **provided it runs with the
  vertex layer present** — otherwise it tests draw mode in a configuration the demo never uses.

  **A held arrow key repeats**, which decides what the live region is *for*. It announces the
  state changes that have no other channel — grab, drop, cancel — and neither nudges nor focus
  moves. A nudge announcement would fire on every repeat of a held arrow; a focus announcement
  would too, and would additionally repeat the element's own accessible name, which already
  says which vertex is active and where it sits in the set.

  **A tap resolves in one order, not two pairwise rules:** draft vertex, then event mark, then
  map position — and both lanes must ask the vertex question the *same* way, at the pointer
  with the renderer's hit radius. Asking the DOM lane at the mark's own anchor instead would
  let a vertex a few pixels away win by pointer and lose by click, so the one order would mean
  two different things depending on which lane delivered the activation. In draw mode both `draw-mode.ts`'s click handling and a controller-level
  `onMapTap` listen to the same event, so two rules stated separately would leave the vertex
  case undefined.

  _AC:_ a reduced-motion preference **reaches the camera**, asserted through the seam in both
  states — the query is read by the controller, not only by a stylesheet, because the camera is
  moved from JavaScript and a media query has no say over an eased transition; the keyboard
  grab is released by drop, Escape, blur **and** by a reconcile that removes the focused vertex
  — the last two asserted, since neither is driven by the key handler under test; draft vertices
  are focusable, reachable by tab, carry an accessible name saying which vertex they are, and
  are operable by arrow keys at one screen pixel and ten with Shift — the coarse step asserted
  so that dropping it fails; a tap on an event mark fires `onEventClick` **alone**, asserted in
  the unit lane and not only in the browser.

  **That last one must be shown to fail without the implementation.** Marks are DOM elements
  above the canvas, so a click on one may never be dispatched as a map `click` at all — in which
  case the contract holds because the event never reached the map, not because anything
  suppressed it, and a test would pass with nothing behind it. Mutating out the suppression must
  turn it red; if it does not, the DOM is providing the contract and it will stop holding the day
  a mark is rendered into a layer instead of a div.

  **The a11y check runs against the browser harness page, not the demo shell.** The demo shell is
  T4.6's `/lab` route, and T4.6 waits on the region input, so an exit criterion naming it could
  not be satisfied in this order. T4.6 re-runs the same check against `/lab` when it exists.

  **Done** (2026-09-01). Audit: [`specs/plans/t4-7-interaction-a11y.md`](plans/t4-7-interaction-a11y.md).

  - *Nine of the ten clauses were already discharged before this task began*, most of them by the
    draw-mode work merged earlier in Phase 4 — reduced motion through the camera seam in both
    states, the grab released by blur and by a reconcile that removes the focused vertex, vertices
    focusable and tab-reachable with a name saying which they are, the 1 px and 10 px steps
    asserted numerically, `onEventClick` firing alone in the unit lane with the DOM relationship
    built so the assertion cannot pass vacuously, and the tap order asked at the pointer. The
    audit names the test and the failure mode for each rather than restating the implementation.
  - *The deferred `/lab` obligation above is discharged here*, by `e2e/lab-a11y.e2e.ts`, asserting
    **the same contract** as the harness check — one tab stop, an accessible name per vertex,
    focus reached through the browser's real tab order, a computed focus ring. No accessibility
    engine and no new dependency: "the same check" is not a licence to turn a named contract into
    a standards scan. Both checks are kept — the harness proves the engine in isolation, `/lab`
    proves the shipped composition did not break it.
  - *That new proof is non-vacuous.* Taking every vertex out of the tab order, and removing the
    visible focus ring, each make it fail.
  - *A sequencing correction.* This task's summary says it "puts `createMapController` on the
    package barrel". It was already exported before T4.7 began, because **T4.6 required it** —
    `/lab` is assembled from package entry points only. The backlog's assumption about the order
    was overtaken by earlier implementation; the export was not touched to make history match it.

## Phase 5 — `@mapatlas/react`
- **T5.1 Hooks.** `useTrackRecorder` (live `channels`, `markLap`, `recovered`), `useEventLog`,
  `useOfflineRegions`. _AC:_ tested with fakes.

  **Done** (2026-09-01). Plan: [`specs/plans/t5-1-hooks.md`](plans/t5-1-hooks.md); the contract
  question it had to settle first is [ADR-0026](decisions.md).

  - *All three hooks are tested with fakes*, in the Vitest lane under `happy-dom` with a small
    `createRoot`/`act` harness. No Testing Library: these hooks bind React state to **interfaces**,
    and the browser lane stays for behaviour only a real browser has, which is T5.2's.
  - *`api.md` §9 had to be settled before the first hook.* It published `recorder?` as optional
    while `architecture.md` gave `@mapatlas/react` no dependency that could build one — a
    contradiction that made the published signature unimplementable. ADR-0026 adds
    `@mapatlas/recorder-web`, and makes recovery two explicit operations
    (`resumeRecovered`/`discardRecovered`) rather than a side effect of `start()`.
  - *The public surface is checked against the document, not against itself.* `index.test.ts`
    transcribes §9's signatures and compares **parameter tuples, return types and key sets** to
    them exactly, in both directions, so drift fails to compile. Exactness is the point: one-way
    assignment certified only *compatibility*, and TypeScript admits both an extra optional
    parameter and an extra optional property — which is how `internals?` and `environment` reached
    the generated declarations while a check built on assignment stayed green. The barrel's
    exports are also compared as a **set**, so an unreviewed addition is as visible as a removal,
    and the internal seams and test harness are asserted never to reach it.
  - *Scope.* §9 also publishes `useTrackList` and `useTrackDraft`. Those are **T5.1b** and remain
    unbuilt; the surface test names them and asserts their absence, so it fails when T5.1b lands
    and has to be extended rather than silently covering them.

  **Found while building, and fixed here.** The packaging gate packed only `core` and `maplibre`,
  so `@mapatlas/react` — which gained its first production dependency in this task — was outside
  it entirely. It now packs the whole publish graph, **executes** a consumer import rather than
  only resolving one, and refuses a shipped test harness or a `react-dom` production dependency.
- **T5.1b `useTrackList` + `useTrackDraft`.** Summary-backed trip list; draft editor exposing
  undo/redo and `save()`. _AC:_ the list renders from `listTrackSummaries()` without loading
  points; the draft hook's `save()` persists an `origin: "authored"` track.

  **Done** (2026-09-02). Plan: [`specs/plans/t5-1b-track-list-draft.md`](plans/t5-1b-track-list-draft.md).

  Both acceptance clauses are discharged, and both cross a seam rather than being read off a
  type: the list fake makes `getTrack` **throw**, so a hydrating implementation fails outright
  rather than passing on the shape of what it returned; and `save()` is asserted to produce
  `origin: "authored"` and to persist exactly the track it resolves with.

  *Mostly a binding, and the survey said so before any code.* `StorageAdapter` already owns the
  ordered, non-hydrating summary projection (ADR-0014) and `createTrackDraft` already owns
  editing, history, validation and authored finalization. React exposes them; it reimplements
  none of it, and the tests wrap a **real** `createTrackDraft` so React's own bookkeeping cannot
  stand in for the thing under test.

  *Two lifecycle rules were settled before implementation rather than discovered in it.* A draft
  is identified by `from.id`, so a fresh `Track` object for the same track keeps unsaved edits —
  the ordinary React case. And one session has one persisted identity: the id is adopted **before**
  `saveTrack` is awaited, because a write that rejects may still have landed, and retrying under
  a newly minted id would create a second trip rather than overwrite the uncertain first one.

  *Evidence.* 30 mutations across the two hooks and the guard cleanup. Three survived and each
  changed something real: a `loading` flag nothing could see restart, an oracle that compared a
  retry against its own id instead of against the failed attempt, and a redundant context
  comparison that was removed rather than kept. One further mutation is recorded as
  **unreachable** rather than manufactured.

  *Found and repaired on the way.* `TrackDraft.toTrack` accepted an undocumented
  `policy?: Partial<FinalizePolicy>` second parameter that no call site used — the same
  extra-optional-parameter leak that reached `@mapatlas/react`'s declarations in T5.1, and
  invisible for the same reason. It is removed, and both core and React now compare parameter
  tuples, return types and key sets exactly rather than by assignment.

  *Scope.* `api.md` §9's remaining React surface is `TripReview`, owned by T5.4, and
  `index.test.ts` names it absent. The mechanism has earned its keep four times
  (`useTrackList`, `useTrackDraft`, `MapCanvas`, `EventComposer`): declaring an unbuilt name
  and asserting it absent is what failed the moment each reached the barrel, forcing it into
  the exact checks instead of letting it appear unverified.
- **T5.2 `<MapCanvas>`.** Wraps MapController incl. `style`/`terrain`/`presentation`/draw mode;
  SSR-safe (no window at import). _AC:_ renders track+events; toggling `drawMode` enters and
  exits cleanly.

  **Done** (2026-09-02). Plan: [`specs/plans/t5-2-map-canvas.md`](plans/t5-2-map-canvas.md).

  A reconciliation component: every published prop except `style` maps to an existing controller
  mutator, so `style` is the one recreation boundary, and a recreation re-applies the whole
  current state. The governing rule — **presence is lifecycle; identity is data** — is pinned on
  both halves: an inline callback's new identity never resubscribes or re-enters draw mode
  (cumulative counts, since at-rest counts cannot see a churn), and a handler disappearing ends
  its session.

  *Evidence, both lanes.* Vitest: nine mutations killed against a counted controller, including
  the full-state style-recreation test and StrictMode ownership; SSR proven in a Node lane that
  asserts `window`/`document` absent before dynamically importing the module — the package's
  first runtime `react → maplibre → maplibre-gl` chain — with the construct-in-render mutant
  dying there on "HTMLElement is not defined". Playwright: the public-shaped component with the
  production controller on one persistent StrictMode root; the track proven in pixels with an
  empty-map control, the event as `.mapatlas-mark--event` (the specific class — start and finish
  pins make the generic class count 3), and `drawMode` toggling 0 → 3 → 0 draft vertices across
  two prop transitions with one canvas throughout. Mounting a plain div instead fails both
  browser tests because the production rendering surface never appears.

  *Public surface.* Exact `api.md` §9 conformance — parameter tuple, return type, and the
  complete prop key set — with `MapCanvas` on the barrel and `EventComposer` still asserted
  absent, gated the same way this component was until now.
- **T5.3 `<EventComposer>`.** Comment + in-place photo capture (`capture="environment"`) writing
  blobs via the required `store`; `mode` selects comment-first or camera-first; consumer
  `fields`/`categories` render into `MapEvent.fields`/`category`; settable `occurredAt`; if an
  `analyzer` is passed, "Analyze photo" → suggested labels the user confirms. _AC:_ saves a
  `MapEvent` whose `media[0].blobKey` resolves in the store; `mode: "photo"` opens capture first —
  meaning the capture affordance is the initially active control, with the picker invoked by a
  user action; `capture="environment"` requests a preferred facing mode with fallback permitted,
  not a rear-camera guarantee (ADR-0027);
  a `FieldSpec` of each type round-trips into `fields`; analyze path works with `noopAnalyzer`;
  remote-analyzer disclosure shown when `runsRemotely`.
  **Done** — `040af2a` (fields/comment/category/save/cancel), `272f27d` (duplicate option
  values), `84fd1ea` (photo + ADR-0027 blob ownership), `1ce57df` (analyzer), `85e586a`
  (per-request disclosure authorization), plus this closure increment: `EventComposer` and
  `FieldSpec` are exported and pinned to §9 by exact parameter, return, key-set and nested
  `options: { value, label }` comparisons. Two decisions settled during the work and recorded
  in `api.md`: an absent `occurredAt` is captured once when the composition opens and never
  resampled, and `""` is not reserved — a `select` or category option may carry it, so
  missing-ness is the placeholder being selected, never the empty string. `FieldSpec.key` is an
  identity and duplicates are rejected rather than resolved by order.
- **T5.4 `<TripReview>`.** Map (sources/terrain/presentation) + events/photos + stats panel +
  per-channel charts. **Replay is T5.5**, split out because this task already carries five
  surfaces and T5.3 showed what that costs. _AC:_ renders a finalized trip on a basemap with
  start/finish marks; a track with a `heartRateBpm`-style channel charts it against time with
  the descriptor's label and unit; a track with no channels renders without an empty chart
  frame; an event whose `MediaRef` carries a `blobKey` renders its photo, resolved through the
  `store` prop added to §9 for exactly this (ADR-0028).

  *Settled here, because scope named what the signature could not do.* §9 had no
  `StorageAdapter`, so "photos" was unbuildable as written — `store` is added rather than
  photos dropped, since a review that cannot show what the composer just wrote is a seam with
  a hole in it. And "no channels" has five readings, enumerated in ADR-0029 and pinned one test
  each: no descriptors on the track; a descriptor with no samples; samples whose key has no
  descriptor; a `channels?` prop naming nothing that matches; and `channels: []`. What
  "defaults to all" means when descriptors and data disagree is settled by the same ADR — the
  default is the descriptors — rather than being a sixth case.

  **Done** — `fb10e02`/`f8d57a3` (contract: ADR-0028 `store`, ADR-0029 the five readings,
  ADR-0030 replay split out, ADR-0031 charts), `595925b`/`48386f6` (composition, every forward
  falsified at the controller rather than in the DOM), `9402475`/`7138548`/`3e2a6bb` (stats and
  charts; the chart breaks at a pause as the map does), `569df0e` (photos, three outcomes told
  apart, both revocation moments), and the closure increment: `TripReview` exported and pinned
  to §9, `TripReviewInternal` held off the barrel, the harness alias retired.

- **T5.5 Replay.** A time cursor over the finalized track, with play/pause and scrub, driving
  the map marker and a matching cursor on each channel chart. _AC:_ the marker interpolates
  between samples; **it holds rather than sliding across a pause**, the same discontinuity
  `render-differential.e2e.ts` already pins in the rendered line; scrubbing to a time moves
  both the marker and the chart cursors; playback state is internal, so §9 gains no props
  (ADR-0030); replay **mounts paused at `first.t`** and advances only on an explicit Play.

  *Split by owner (ADR-0032).* Core owns **where the track was at a moment** — `positionAt` is a
  pure projection with no renderer, clock or playback state, published because the
  no-travel-through-a-pause rule is already cross-surface and a third implementation inside
  React is the drift `computeStats` exists to prevent. React owns the playback state machine and
  its controls. A `t` inside a pause holds at the **last point before** it: returning the next
  segment's first point would leak a future observation backwards in time.

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
