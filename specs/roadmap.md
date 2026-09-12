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
- Data types (incl. altitude, `channels`, `segments`, `laps`, `origin`, `TrackSummary`,
  `simplifiedSegments`, and `DraftTrackPoint` distinct from `TrackPoint`);
  `SamplingPolicy`; GPS sampling; `simplify` (Douglas–Peucker, per segment, channel-preserving);
  `computeStats` + `finalizeTrack`; `TrackDraft` (manual authoring, undo/redo, time
  interpolation); `SensorSource` + `createPollingSensorSource` + a fake; `EventLog` logic;
  interface definitions (`StorageAdapter`, `MapAssetStore`, `MediaAnalyzer`, `TileSource`,
  `OfflineRegionStore`, `TrackRecorder`, `SensorSource`); `noopAnalyzer`;
  `recoverInterruptedTrack`; GeoJSON export/import (raw geometry) with the media manifest.
- **Exit:** `@mapatlas/core` is unit-tested in Node with fakes behind an enforced coverage floor
  (92% statements / 82% branches / 90% functions / 92% lines, checked in CI); no DOM/maplibre/react
  import. The residual gap is defensive `undefined` guards that strict indexing requires and no
  input can reach — pursuing literal 100% would mean writing tests against TypeScript rather than
  against the engine.

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
- **Exit:** the vertical acceptance fixture (T4.6) renders over a topographic
  (terrain + hillshade + contour) source stack with the network disabled; a paused track renders
  as two lines, not one; consumer-supplied marks render with their accessible names; a11y checks
  pass.

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
- **Exit:** a downloaded region renders with **the archive host** unreachable — map data
  offline. The application shell is still served from its own origin; serving that offline is
  Phase 7's exit, not this one. See T6.1 in `tasks.md` for why the narrower cut is the honest
  one: a blanket abort cannot coexist with the fresh realm the positive control requires.

## Phase 7 — Demo app + docs
- `apps/demo`: a generic field logger (no real domain) wiring the whole engine — record and
  hand-draw a trip, a trip list from summaries, a topographic source stack, a custom
  `EventPresentation` with two neutral categories, a fake polling sensor channel charted in
  review, a swappable `noopAnalyzer` slot. Getting-started docs derived from `api.md`.
- **Exit:** the success criteria in `PRD.md §6` are demonstrably met end-to-end, offline.

  > **Met 2026-09-11**, on T7.2's close-out, and recorded here because it was a ruling rather than
  > an observation. §6's first criterion is that a developer embeds the loop *"in an afternoon,
  > reading only `api.md`"*. That is true for a developer who **builds the packages from a
  > checkout**: `api.md` §0 takes them there, every fenced block in it is either the same bytes as a
  > file under `examples/quick-start` or generated from this repository, `check:packaging` compiles
  > that example against the packed tarballs and `e2e/quick-start.e2e.ts` runs it in a browser, and
  > following the document by hand produces a project that typechecks and builds.
  >
  > It is **not** true for a developer who runs `npm install @mapatlas/react`. Nothing is published:
  > every package is `0.0.0`, the registry has none of them, and there is no publish workflow. The
  > exit is taken on the reading that **§6 names no registry** — it asks what a developer can build
  > with, and the answer is checked in two lanes — and `api.md` §0 states the situation plainly, so
  > no reader is misled while it stands. **Publishing moves to post-v1** below rather than being
  > treated as an omission here.
  >
  > The consequence is that **M1 is reached**: Phases 0–7 are green and §6 is met on that reading.
  > M2 is untouched and remains out of the web engine's scope.
  >
  > **ADR-0042** in [`decisions.md`](decisions.md) carries the full record: the evidence the reading
  > rests on, the release-first alternative and why it was not taken, the consequences, and the
  > reversal rule. Recorded so that a later reader finds a decision rather than a gap. If the owner
  > later rules that §6 requires a registry install, that is an amendment to that ADR and to this
  > note, plus a release task — not a reinterpretation of either.

## Phase 8 — Follow-ups (post-v1, recorded and unscheduled)
- Work that is real, is not part of M1, and would otherwise live only in `CONTINUE.md`.
  `tasks.md` carries the three with acceptance criteria: the fixture-build flake tracked in issue
  #30, per-package READMEs, and the `/lab` retirement audit. **Not part of M1** — Phases 0–7 are
  what `PRD.md §6` measures, and nothing here is required by it.

## Milestones (do not conflate these two)

- **M1 — v1 web engine complete.** Phases 0–7 green: the full record / author / review / offline
  loop in a browser, foreground recording only. This is what `PRD.md §6` measures.
- **M2 — production native recorder complete.** A native background `TrackRecorder` adapter, so
  a trip survives a locked screen. **Not part of M1**, and not achievable inside a web page.
  A consumer promising Strava/Garmin parity needs M2; a field journal may ship on M1 alone.

## Post-v1 (documented extension points, not v1 scope)
- **Publishing the packages to a registry.** v1 is embeddable from a checkout and proved to be so;
  making it `npm install`-able is a release problem rather than an engine one — versioning off
  `0.0.0`, a publish workflow with provenance, org ownership, and deciding what `check:packaging`
  should assert about a *published* artifact rather than a packed one. Moved here by the Phase 7
  exit note above.
- Native background `TrackRecorder` adapter (Capacitor/Cordova) as a separate package —
  the only way to record with the screen locked, and the gap a workout/trip consumer must
  close itself in v1.
- Concrete `SensorSource` adapters (Web Bluetooth heart rate, HealthKit/Health Connect bridge,
  NMEA depth) as separate, optional packages.
- An alternative (raster) renderer sibling to `@mapatlas/maplibre`, same `core` — the renderer stays swappable.
- Reference analyzers (on-device ONNX; remote vision) as separate, optional packages.
