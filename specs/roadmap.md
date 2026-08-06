<!-- SPDX-License-Identifier: Apache-2.0 -->

# MAP-ATLAS — Roadmap

Phases are ordered by dependency. Build a phase's tasks (see [`tasks.md`](tasks.md)) before
the next. Each phase ends with all gates green (`build`, `typecheck`, `lint`, `test`).

## Phase 0 — Toolchain & skeleton
Stand up the monorepo so everything after it has a home and the gates exist.
- Workspaces, TypeScript strict, lint, a fast unit test runner, the five package folders,
  the import-isolation CI scan, SPDX-header check.
- **Exit:** empty packages build, typecheck, lint, and test green; CI enforces core isolation.

## Phase 1 — Core domain (framework-agnostic)
The heart, with no browser or renderer.
- Data types; `SamplingPolicy`; GPS sampling; `simplify` (Douglas–Peucker); `Track` finalize
  (distance); `EventLog` logic; interface definitions (`StorageAdapter`, `MediaAnalyzer`,
  `TileSource`, `OfflineRegionStore`, `TrackRecorder`); `noopAnalyzer`; GeoJSON export/import.
- **Exit:** `@mapatlas/core` is 100% unit-tested in Node with fakes; no DOM/maplibre/react import.

## Phase 2 — Persistence
- `@mapatlas/storage-idb`: IndexedDB `StorageAdapter` (tracks, events, blobs) + `clearAll()`.
- **Exit:** adapter passes a shared `StorageAdapter` conformance test suite (also runnable
  against an in-memory fake).

## Phase 3 — Web track recorder
- `createWebTrackRecorder`: `watchPosition` + Screen Wake Lock + sampling; error mapping.
- **Exit:** recorder tested against a mocked geolocation; emits only accuracy-passing points;
  Wake Lock acquired on start / released on stop.

## Phase 4 — MapLibre renderer
- `createMapController`: layered `TileSource` stack, live position, track polyline, event
  DivIcon markers, tap-to-place, fit/recenter; keyboard-accessible controls.
- **Exit:** renders a track + events from fixtures in the demo shell; a11y checks pass.

## Phase 5 — React bindings
- `useTrackRecorder`, `useEventLog`, `useOfflineRegions`; `<MapCanvas>`, `<EventComposer>`
  (comment + in-place photo capture + optional analyze), `<TripReview>`.
- **Exit:** component tests cover the record→pin→photo→review loop with fakes.

## Phase 6 — Offline map regions
- PMTiles-backed `OfflineRegionStore` (download bbox×zoom, list, delete, size estimate);
  `persist()` + install guidance surfaced in the demo.
- **Exit:** a downloaded region renders with the network disabled.

## Phase 7 — Demo app + docs
- `apps/demo`: a generic field logger (no real domain) wiring the whole engine, including a
  swappable `noopAnalyzer` slot. Getting-started docs derived from `api.md`.
- **Exit:** the success criteria in `PRD.md §6` are demonstrably met end-to-end, offline.

## Post-v1 (documented extension points, not v1 scope)
- Native background `TrackRecorder` adapter (Capacitor/Cordova) as a separate package.
- An alternative (raster) renderer sibling to `@mapatlas/maplibre`, same `core` — the renderer stays swappable.
- Reference analyzers (on-device ONNX; remote vision) as separate, optional packages.
