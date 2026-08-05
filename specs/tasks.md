<!-- SPDX-License-Identifier: Apache-2.0 -->

# MAP-ATLAS — Task backlog

The buildable units, grouped by the [`roadmap.md`](roadmap.md) phases. Build in order;
respect the one architectural rule (core imports nothing consumer/renderer specific). Every
task: keep the gates green, DCO-sign commits, SPDX-header new files. `AC` = acceptance criteria.

## Phase 0 — Toolchain & skeleton
- **T0.1 Workspace root.** Monorepo (npm or pnpm workspaces), `packages/*` + `apps/*`, root
  scripts `build|typecheck|lint|test`. _AC:_ `npm install` then all four scripts run (no-op ok).
- **T0.2 TypeScript strict base.** Shared `tsconfig.base.json` (strict, ESM, declaration).
  _AC:_ a stub `@mapatlas/core` typechecks; `any` in public API is a lint error.
- **T0.3 Lint + format.** ESLint + formatter; a rule/plugin config. _AC:_ `npm run lint` green.
- **T0.4 Test runner.** Vitest (or equivalent) wired per package. _AC:_ a sample test runs.
- **T0.5 Isolation CI scan.** A script that fails if `@mapatlas/core`/`@mapatlas/leaflet`
  import `react`/DOM (for core also `leaflet`) or any domain token (fish, species, mushroom,
  plant, product, auth, db). _AC:_ scan passes clean and *proven to fail* on a planted violation.
- **T0.6 SPDX header check.** Fail build if a source file lacks `SPDX-License-Identifier: Apache-2.0`.

## Phase 1 — `@mapatlas/core`
- **T1.1 Types.** All of `api.md §1` + ids/util. _AC:_ exported, typechecked, no runtime dep.
- **T1.2 Sampling.** `SamplingPolicy` + a pure `sample(prev, candidate, policy)` decision fn.
  _AC:_ unit tests for distance/interval/accuracy branches.
- **T1.3 Simplify.** Douglas–Peucker `simplify(points, toleranceM)`. _AC:_ reduces a noisy
  fixture 60–80% without visibly changing shape; endpoints preserved.
- **T1.4 Track finalize.** `finalizeTrack(points)` → `simplified` + `distanceM` (haversine).
  _AC:_ distance within tolerance of a known fixture.
- **T1.5 EventLog logic.** Create/update/delete against a `StorageAdapter`. _AC:_ tested with fake.
- **T1.6 Interfaces.** `StorageAdapter`, `MediaAnalyzer`, `TileSource`, `OfflineRegionStore`,
  `TrackRecorder` per `api.md`; ship `noopAnalyzer`. _AC:_ typecheck; `noopAnalyzer` returns `[]`.
- **T1.7 GeoJSON.** `trackToGeoJSON`/`geoJSONToTrack`. _AC:_ round-trip preserves geometry,
  timestamps, comment, tags, `fields`, `analysis` (media by reference + manifest).

## Phase 2 — `@mapatlas/storage-idb`
- **T2.1 Conformance suite.** A reusable `StorageAdapter` test suite (in `core` test utils)
  runnable against any adapter. _AC:_ passes against an in-memory fake.
- **T2.2 IndexedDB adapter.** Implement `StorageAdapter` over `idb`. _AC:_ passes T2.1 suite
  (use a fake-indexeddb in tests); `clearAll()` removes tracks+events+blobs.

## Phase 3 — Web recorder
- **T3.1 `createWebTrackRecorder`.** `watchPosition` + sampling (T1.2) + Wake Lock + error map.
  _AC:_ with a mocked geolocation, emits only accuracy-passing points; `stop()` returns a
  finalized `Track`; Wake Lock acquired on start, released on stop/pause.

## Phase 4 — `@mapatlas/leaflet`
- **T4.1 MapController + layers.** Mount Leaflet, ordered `TileSource[]`, attribution. _AC:_
  base + overlay composite; attribution rendered verbatim.
- **T4.2 Track & events render.** Live position, growing polyline, event DivIcon markers,
  `fitTrack`, `recenter`. _AC:_ renders from fixtures.
- **T4.3 Interaction + a11y.** `onMapTap`, `onEventClick`; controls keyboard-reachable, visible
  focus, `prefers-reduced-motion` respected. _AC:_ a11y checks pass in the demo shell.

## Phase 5 — `@mapatlas/react`
- **T5.1 Hooks.** `useTrackRecorder`, `useEventLog`, `useOfflineRegions`. _AC:_ tested with fakes.
- **T5.2 `<MapCanvas>`.** Wraps MapController; SSR-safe (no window at import). _AC:_ renders track+events.
- **T5.3 `<EventComposer>`.** Comment + in-place photo capture (`capture="environment"`); if an
  `analyzer` is passed, "Analyze photo" → suggested labels the user confirms. _AC:_ saves a
  `MapEvent` with media; analyze path works with `noopAnalyzer`; remote-analyzer disclosure shown.
- **T5.4 `<TripReview>`.** Replay track + browse events/photos + stats. _AC:_ renders a finalized trip.

## Phase 6 — Offline regions
- **T6.1 PMTiles region store.** Implement `OfflineRegionStore` (download bbox×zoom, list,
  delete, `estimateSize`). _AC:_ a downloaded region renders offline (network disabled in test/demo).
- **T6.2 Persistence UX.** `navigator.storage.persist()` + install prompt guidance in the demo.

## Phase 7 — Demo + docs
- **T7.1 Demo app.** Generic field logger wiring recorder+map+event+storage+offline, analyzer
  slot defaulting to `noopAnalyzer`. _AC:_ full record→pin→photo→review loop works **offline**,
  survives reload, exports valid GeoJSON.
- **T7.2 Getting started.** Docs derived from `api.md`: embed the loop in an afternoon. _AC:_
  a new consumer following the doc reaches a working map+event loop.

## Global definition of done (every task)
`build` + `typecheck` (strict) + `lint` + `test` green · isolation & SPDX scans green ·
public API changes mirrored into `api.md` · consequential decisions appended to `decisions.md`.
