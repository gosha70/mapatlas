<!-- SPDX-License-Identifier: Apache-2.0 -->

# MAP-ATLAS — Roadmap

Phases are ordered by dependency. Build a phase's tasks (see [`tasks.md`](tasks.md)) before
the next. Each phase ends with all gates green (`build`, `typecheck`, `lint`, `test`).

## Phase 0 — Toolchain & skeleton
Stand up the monorepo so everything after it has a home and the gates exist.
- Workspaces, TypeScript strict, lint, a fast unit test runner, the **seven** package folders,
  the import-isolation CI scan, SPDX-header check, and the GitHub Actions workflow that runs them.
- **Exit:** empty packages build, typecheck, lint, and test green; CI enforces core isolation.

## Phase 1 — Core domain (framework-agnostic)
The heart, with no browser or renderer.
- Data types (incl. altitude, `channels`, `segments`, `laps`, `origin`, `TrackSummary`);
  `SamplingPolicy`; GPS sampling; `simplify` (Douglas–Peucker, channel-preserving);
  `computeStats` + `finalizeTrack`; `TrackDraft` (manual authoring, undo/redo, time
  interpolation); `SensorSource` + `createPollingSensorSource` + a fake; `EventLog` logic;
  interface definitions (`StorageAdapter`, `MediaAnalyzer`, `TileSource`, `OfflineRegionStore`,
  `TrackRecorder`); `noopAnalyzer`; `recoverInterruptedTrack`; GeoJSON export/import with the
  media manifest.
- **Exit:** `@mapatlas/core` is 100% unit-tested in Node with fakes; no DOM/maplibre/react import.

## Phase 2 — Persistence
- `@mapatlas/storage-idb`: IndexedDB `StorageAdapter` (tracks, events, blobs) + a summary index
  backing `listTrackSummaries()` + cascading `deleteTrack` + `clearAll()`.
- **Exit:** adapter passes a shared `StorageAdapter` conformance test suite (also runnable
  against an in-memory fake), including a summary-listing test that asserts points are not
  hydrated.

## Phase 3 — Web track recorder + sensor merge (`@mapatlas/recorder-web`)
- `createWebTrackRecorder`: `watchPosition` + Screen Wake Lock + sampling; segments on
  pause/resume; `markLap`; `SensorSource` merge into kept points; autosave + crash recovery;
  error mapping.
- **Exit:** recorder tested against a mocked geolocation and a fake sensor; emits only
  accuracy-passing points with merged channels; pause/resume produces two segments;
  Wake Lock acquired on start / released on stop; an interrupted track is recoverable.

## Phase 4 — MapLibre renderer
- `createMapController`: layered `TileSource` stack (raster · vector · `raster-dem`), base style
  document, 3D terrain + hillshade, live position, **per-segment** track lines, marks via
  `EventPresentation` (events, start, finish, laps), tap-to-place, fit/recenter/fit-bounds,
  and the draw/edit mode (`renderDraft`, draggable vertices); keyboard-accessible controls.
- **Exit:** renders a track + events from fixtures in the demo shell over a topographic
  (terrain + hillshade + contour) source stack; a paused track renders as two lines, not one;
  consumer-supplied marks render with their accessible names; a11y checks pass.

## Phase 5 — React bindings
- `useTrackRecorder` (incl. live channels, laps, recovery), `useTrackList`, `useTrackDraft`,
  `useEventLog`, `useOfflineRegions`; `<MapCanvas>` (terrain, presentation, draw mode),
  `<EventComposer>` (comment-or-camera first, consumer `fields`/`categories`, in-place photo
  capture + optional analyze), `<TripReview>` (map + stats + channel charts).
- **Exit:** component tests cover the record→pin→photo→review loop **and** the
  draw→time→pin→save authoring loop, with fakes.

## Phase 6 — Offline map regions (`@mapatlas/offline-pmtiles`)
- PMTiles-backed `OfflineRegionStore` (download bbox×zoom per source, list, delete, size
  estimate); `persist()` + install guidance surfaced in the demo.
- **Exit:** a downloaded region renders with the network disabled.

## Phase 7 — Demo app + docs
- `apps/demo`: a generic field logger (no real domain) wiring the whole engine — record and
  hand-draw a trip, a trip list from summaries, a topographic source stack, a custom
  `EventPresentation` with two neutral categories, a fake polling sensor channel charted in
  review, a swappable `noopAnalyzer` slot. Getting-started docs derived from `api.md`.
- **Exit:** the success criteria in `PRD.md §6` are demonstrably met end-to-end, offline.

## Milestones (do not conflate these two)

- **M1 — v1 web engine complete.** Phases 0–7 green: the full record / author / review / offline
  loop in a browser, foreground recording only. This is what `PRD.md §6` measures.
- **M2 — production native recorder complete.** A native background `TrackRecorder` adapter, so
  a trip survives a locked screen. **Not part of M1**, and not achievable inside a web page.
  A consumer promising Strava/Garmin parity needs M2; a field journal may ship on M1 alone.

## Post-v1 (documented extension points, not v1 scope)
- Native background `TrackRecorder` adapter (Capacitor/Cordova) as a separate package —
  the only way to record with the screen locked, and the gap a workout/trip consumer must
  close itself in v1.
- Concrete `SensorSource` adapters (Web Bluetooth heart rate, HealthKit/Health Connect bridge,
  NMEA depth) as separate, optional packages.
- An alternative (raster) renderer sibling to `@mapatlas/maplibre`, same `core` — the renderer stays swappable.
- Reference analyzers (on-device ONNX; remote vision) as separate, optional packages.
