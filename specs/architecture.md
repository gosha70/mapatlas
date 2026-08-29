<!-- SPDX-License-Identifier: Apache-2.0 -->

# MAP-ATLAS — Architecture

> The "how." Read [`PRD.md`](PRD.md) first; the enforceable contract is [`api.md`](api.md);
> decisions are logged in [`decisions.md`](decisions.md).

## 1. Shape in one picture

```
consuming app (HookAtlas, a foraging app, a survey tool)
   │  supplies: domain, MediaAnalyzer, privacy rules, (optional) remote sync
   ▼
┌───────────────────────────────────────────────────────────────┐
│ @mapatlas/react     React components + hooks (integration face)│
├───────────────────────────────────────────────────────────────┤
│ @mapatlas/maplibre  MapLibre renderer: raster+vector+terrain    │
│                     source stack, track segments, marks via the │
│                     presentation seam, draw/edit mode           │
├───────────────────────────────────────────────────────────────┤
│ @mapatlas/core      framework-agnostic: data model, EventLog,   │
│                     sampling+simplify, segments/laps, stats,    │
│                     TrackDraft (manual authoring), interfaces:  │
│                     StorageAdapter · MediaAnalyzer · TileSource ·│
│                     OfflineRegionStore · TrackRecorder ·         │
│                     SensorSource                                 │
└───────────────────────────────────────────────────────────────┘
   │ default implementations (swappable)
   ▼
@mapatlas/storage-idb   ·   @mapatlas/recorder-web   ·   @mapatlas/offline-pmtiles
```

**The invariant:** arrows only point downward and outward. `core` imports nothing from
`maplibre-gl`, `react`, the DOM, or any consumer. This is what makes the engine reusable and
testable, and it is CI-enforceable with an import scan (see §8).

## 2. Packages

| Package | Depends on | Responsibility |
|---|---|---|
| `@mapatlas/core` | nothing (pure TS) | Types, `EventLog`, `@mapatlas/core/testing` (a shipped in-memory `StorageAdapter`/`MapAssetStore`, on a separate entry point so test utilities stay out of production bundles), GPS sampling + `simplify`, segments/laps, `computeStats`/`finalizeTrack`, `TrackDraft` (manual authoring), `createPollingSensorSource`, GeoJSON export/import, and the interfaces: `TrackRecorder` · `SensorSource` · `StorageAdapter` · `MediaAnalyzer` · `TileSource` · `OfflineRegionStore` |
| `@mapatlas/recorder-web` | `core` | `createWebTrackRecorder`: `watchPosition` + Screen Wake Lock + sampling + sensor merge + autosave. **Separate from `core` because it touches the DOM** (ADR-0013) |
| `@mapatlas/maplibre` | `core`, `maplibre-gl` | `MapController`: mount a MapLibre GL map, composite the ordered `TileSource` stack (raster · vector · `raster-dem`), 3D terrain + hillshade, render live position + per-segment track lines + start/finish/lap/event marks via `EventPresentation`, and the draw/edit interaction mode |
| `@mapatlas/react` | `core`, `maplibre`, `react` | `<MapCanvas>`, `<EventComposer>`, `<TripReview>`, `useTrackRecorder`, `useTrackList`, `useTrackDraft`, `useEventLog`, `useOfflineRegions` |
| `@mapatlas/storage-idb` | `core`, `idb` | Default `StorageAdapter` over IndexedDB — tracks, events, media blobs, and a **separate summaries store** with a `startedAt` index, because IndexedDB has no projection and listing from the tracks store would read every point of every trip. Also `createIdbMapAssetStore`, the default `MapAssetStore`, under a **separately named store** so neither can wipe the other — lifecycle isolation, not quota isolation, since eviction remains per-origin (ADR-0016) |
| `@mapatlas/offline-pmtiles` | `core`, `pmtiles` | `createPMTilesRegionStore`: download/list/delete a bbox×zoom region per source; renderer-neutral |
| `apps/demo` | all above | A generic field-logger (no real domain) proving the loop; also the manual test bed |

Monorepo via npm/pnpm workspaces. Each package is independently publishable ESM with types.

## 3. Data model (domain-neutral)

All ids are opaque strings (ULID/UUID). Coordinates are WGS84 `{ lat, lng }`.

- **`Track`** — one session: `id`, `startedAt`, `endedAt?`, `status`
  (`recording|paused|finalized`), `origin` (`recorded|authored|imported`), `points: TrackPoint[]`
  (raw, the single source of truth), `segments: TrackSegment[]`, `simplifiedSegments?`, `laps?`,
  `channels?: ChannelDescriptor[]`, derived `stats?: TrackStats`, plus consumer `tags`/`meta`.
- **`TrackSegment` / `TrackLap`** — index ranges into `points`, never copies of it. A segment is
  a contiguous **active** span; the gap between two segments *is* the pause. A lap is a split,
  which may cross segments. This is what stops a paused trip rendering as a straight line and
  what makes splits possible without a second geometry.
- **`TrackStats`** — derived, never authored: `distanceM`, `durationMs` (elapsed),
  `movingTimeMs` (segments only), avg/max speed, elevation gain/loss, and one `ChannelStats`
  per telemetry channel. Computed by `computeStats`; recorders, drafts, and import all use it.
- **`TrackSummary`** — the list projection: everything a trip list needs (stats, bbox,
  start/finish, counts) with **no** point array. `listTrackSummaries()` returns these so a web
  app with hundreds of trips does not load megabytes to draw a list.
- **`TrackPoint`** — `lat`, `lng`, `t` (epoch ms), `accuracyM?`, `altitudeM?`,
  `altitudeAccuracyM?`, `speedMps?`, `headingDeg?`, and `channels?: Record<string, number>` —
  the per-point telemetry bag (heart rate, cadence, depth, temperature). Keys are described by
  `Track.channels` and are **opaque to the engine**.
- **`ChannelDescriptor`** — `key`, consumer-supplied `label`/`unit`, and an `aggregate` telling
  `computeStats` how to roll the channel up. This is the domain seam for *telemetry*, exactly
  as `fields`/`tags`/`category` are the domain seam for *events*.
- **`MapEvent`** — a pinned moment: `id`, `trackId?`, `position`, `occurredAt`, `comment?`,
  `media: MediaRef[]`, `tags: string[]`, `fields?: Record<string, JSONValue>` (consumer-defined),
  `category?: string`.
- **`MediaRef`** — `id`, `mime`, `width?`, `height?`, a `blobKey` (into the `StorageAdapter`)
  and/or `url`, and `analysis?: MediaAnalysis`.
- **`MediaAnalysis`** — analyzer output: `labels: { label: string; confidence: number }[]`,
  `summary?: string`, `model?: string`, `raw?: JSONValue`. The engine never interprets labels.

`fields`, `tags`, `category` are the domain seam in the *data*: HookAtlas stores `species`,
a foraging app stores `mushroomGenus`, the engine stores neither — just typed bags. Likewise a
workout consumer declares a `heartRateBpm` channel and a marine one declares `depthM`; both run
the identical code path, because the engine stores and charts numbers with a label and a unit
and never learns what they measure.

## 4. Key seams (interfaces, see `api.md` for signatures)

- **`TrackRecorder`** — `start/stop/pause/resume/markLap`, emits `TrackPoint`s. Web
  implementation (`@mapatlas/recorder-web`) wraps `navigator.geolocation.watchPosition` and
  holds a Screen Wake Lock while recording. A **native** recorder (Capacitor/Cordova background
  geolocation) is an out-of-tree adapter a consumer registers — the seam exists precisely so
  background tracking can be added without touching the engine. Sampling policy
  (distance/time/accuracy filter) is configurable. With a `store` and `autosaveMs`, the
  in-progress track is persisted as it grows so a crash or a killed tab is recoverable
  (`recoverInterruptedTrack`) rather than a lost trip.
- **`SensorSource`** — the non-GPS telemetry seam: `start/stop` and an `onSample` stream of
  `{ t, values }`, plus the `ChannelDescriptor[]` it produces. The recorder merges the reduced
  values into each **kept** point per a `SensorMergePolicy` (max sample age + reduce mode).
  The engine ships `createPollingSensorSource` (sample a consumer `read()` on an interval —
  the neutral primitive behind "take the heart rate every N seconds") and a fake for tests; it
  ships **no device driver**. A sensor failure surfaces on `onError` and never aborts a
  recording — losing a heart-rate strap must not lose the trip.
- **`MapAssetStore`** — persistence for downloaded **map bytes**, deliberately not the
  `StorageAdapter`. Map assets are large, replaceable, and the right thing to evict first; tracks
  and photos are irreplaceable. Keeping them in one store meant a sign-out wipe destroyed
  hundreds of megabytes of basemap. Separation buys lifecycle isolation and a bounded blast
  radius — **not** quota isolation, since browsers evict per origin. Default:
  `createIdbMapAssetStore` in `@mapatlas/storage-idb`, backed by its own IndexedDB database
  (ADR-0016).
- **`StorageAdapter`** — persistence for tracks, events, and media blobs. Default:
  IndexedDB (`@mapatlas/storage-idb`). A consumer can supply a remote/sync adapter. The
  engine treats storage as async CRUD and never assumes locality beyond the default.
- **`MediaAnalyzer`** — `analyze(input) => Promise<MediaAnalysis>`. Optional; absent → no
  analysis UI. Implementations may run on-device (ONNX/TF.js/Core ML via a native bridge) or
  call a remote vision model. **This is an egress boundary** — see `SECURITY.md`.
- **`TileSource`** — any layer the renderer composites, described on two independent axes: a
  `kind` (`raster`/`vector`/`raster-dem`) saying what the tiles contain and a `transport`
  (`template`/`wms`/`tilejson`/`pmtiles`) saying how to fetch them, so a PMTiles archive states
  its own content instead of the renderer guessing (ADR-0023). Plus a `role` (`base`/`overlay`/
  `terrain`/`hillshade`) and attribution. `styleLayers` carries renderer style layers as opaque
  JSON, so `core` can describe contours, hillshade, or bathymetry **without importing a
  renderer's types**. This is what makes topographic and depth basemaps expressible
  (ADR-0011). No provider is hardcoded.
- **`EventPresentation`** — the *presentation* seam, and the renderer-side twin of the data
  seam: the consumer maps a `MapEvent` (its `category`/`tags`/`fields`) to a `MarkerStyle`, and
  optionally styles the start/finish/lap marks and each segment's line. The engine draws what
  it is handed. Without it the renderer uses neutral built-in marks. Every mark carries a
  consumer-supplied `ariaLabel` — only the consumer knows what a mark *means*, so only the
  consumer can name it for a screen reader. `MarkerStyle.html` is inserted verbatim and is
  therefore consumer-trusted markup (see `SECURITY.md`).
- **`OfflineRegionStore`** — download/list/delete a map region (a bounding box × zoom range)
  as a PMTiles archive for offline use; reports size; supports eviction-aware re-download.

## 5. Offline model

Two independent offline concerns:

1. **Map imagery** → `OfflineRegionStore` (PMTiles regions). Single-file per region, read via
   HTTP range requests online and cached whole for offline. Consumers must drive
   "install to home screen" + `navigator.storage.persist()` on iOS (eviction).
2. **User data** (tracks/events/media) → `StorageAdapter` (IndexedDB default). Recording never
   requires the network; writes are local and durable immediately. Any upload/sync is a
   consumer-provided adapter, not an engine feature.

The engine is usable end-to-end with zero network after a region is downloaded.

## 6. Track handling

- **Sampling** (configurable, sensible defaults): accept a fix only if it moved > `minDistanceM`
  since the last kept point OR `maxIntervalMs` elapsed, and drop fixes with
  `accuracyM > maxAccuracyM`. This avoids dense noise while anchored.
- **Simplification is per segment**, not per track: `simplifiedSegments[n]` is the rendering
  projection of `segments[n]`, one member each, same order. Two reasons, both fatal to the flat
  alternative. A raw index means nothing inside a decimated array, so `TrackSegment.startIndex`
  could no longer locate its own geometry; and running Douglas–Peucker across the concatenated
  points would treat a pause as continuous line and smooth straight through it. Simplification
  **preserves the `channels` and `altitudeM` of the points it keeps** — a decimated line must not
  silently drop telemetry. The invariant to hold onto:

  ```
  points + segments      = canonical geometry (source of truth, what gets exported)
  simplifiedSegments[n]  = rendering projection of segments[n] (derived, never exported)
  ```
- **Segments & laps**: `pause()` closes a segment and `resume()` opens the next, so a paused
  span is a gap in the geometry; `markLap()` records a split. Both are index ranges into
  `points` — one geometry, two views over it.
- **Distance has two implementations on purpose** (ADR-0019). `haversineDistanceMeters` is
  spherical and answers cheap geometric questions — "did this fix move ten metres?" — where GPS
  error dwarfs the ~0.3% ellipsoid difference. `geodesicDistanceMeters` (Vincenty on WGS84, with a
  haversine fallback) is the **only** source of `stats.distanceM`, because that number is durable,
  user-visible, and compounds: 0.3% is ~126 m over a marathon. The names carry the precision so
  neither can quietly become the other.
- **Stats**: `computeStats` is the single implementation of distance, elapsed vs moving time,
  speed, elevation gain/loss (hysteresis-filtered so GPS altitude noise does not inflate it),
  and per-channel roll-ups. Recorders, drafts, and import all call it, so a hand-drawn trip and
  a recorded one report numbers the same way.
- **Geometry**: internally an array of points plus segment ranges; **export** as a GeoJSON
  `MultiLineString` (one member per segment, at **raw** fidelity — export is portability, and a
  lossless round-trip and decimated geometry cannot both be true) + `Point` features (events),
  with `coordTimes` and per-coordinate `channels` arrays. A consumer with PostGIS stores this as
  `geography(MultiLineString)` — but the engine has no database opinion.

## 6b. Manual authoring (drawn tracks)

A track that was never recorded is a first-class track. `TrackDraft` (`core`) is a pure,
undoable point-list editor — append/insert/move/remove, `breakAt` for a pause, `setTimeAt` and
`interpolateTimes` for timing — and `toTrack()` runs the *same* `finalizeTrack` as a recorder,
tagging `origin: "authored"`.

A draft holds `DraftTrackPoint[]`, whose `t` is **optional**, because authoring places vertices
first and times them afterwards. A `TrackPoint` keeps `t` required: a recorded fix always has a
clock reading, and weakening the finalized type to accommodate an intermediate editing state
would push that uncertainty into every consumer. `toTrack()` is the boundary where the invariant
is enforced, and it throws rather than inventing a timestamp (ADR-0018). The renderer contributes only the interaction (`enterDrawMode`,
draggable vertices, `renderDraft`), and React contributes `useTrackDraft`.

The consequence that matters: review, stats, export, offline, and the presentation seam all work
on an authored track with no special cases, because the only difference is one enum field.

## 7. Rendering (MapLibre GL)

- MapLibre GL chosen (ADR-0008, superseding ADR-0002): vector tiles + GPU rendering give
  richer graphics and smooth zoom, and — importantly for marine/outdoor use — proper vector
  **bathymetry / water-depth styling** that raster Leaflet cannot. `core` stays
  renderer-agnostic, so an alternative (e.g. raster) renderer remains a sibling package, not a
  rewrite. PMTiles (ADR-0004) is renderer-neutral and works with either.
- The renderer takes an **ordered `TileSource[]`** (base → overlays → terrain/hillshade), an
  optional base style document, a `Track`, and a `MapEvent[]`, and exposes imperative controls
  (recenter, fit-track/fit-bounds, tap, draw mode) that the React layer wraps. It draws **one
  polyline per segment** — never a line across a pause — plus start, finish, and lap marks.
- **Terrain is first-class**: a `raster-dem` source plus `TerrainOptions` drives MapLibre's 3D
  terrain and hillshade, and `styleLayers` carries contour/bathymetry styling. This is the
  capability ADR-0008 was chosen for, and ADR-0011 is what makes it expressible in the contract.
- Marks come from the consumer's `EventPresentation`; the engine bundles **no image assets** and
  no icon set. Controls are keyboard-accessible and every mark has a consumer-supplied
  accessible name.
- **Attribution is engine-owned, not library-default.** The renderer sets its attribution
  prefix explicitly (neutral, brandable) rather than inheriting a mapping library's built-in
  default — a product must never ship third-party editorial/branding content it did not
  choose (see §8 and ADR-0008).

## 8. Map data & licensing

The engine bundles no tiles. It documents, and consumers must honor:

- **OpenStreetMap** base — © OpenStreetMap contributors, **ODbL**; attribution required.
- **OpenSeaMap** seamark overlay — **ODbL, share-alike**; attribution required; overlay only.
- **Bathymetry is not settled, and no publisher is a blanket answer.** An earlier version of
  this section recorded NOAA charts and bathymetry as blanket US public domain and preferred
  over GEBCO as leaning non-commercial. Both halves are wrong as stated: GEBCO's published
  terms for its gridded bathymetry place it in the public domain and explicitly permit
  commercial exploitation, while NOAA licensing is product- and source-specific — some
  products carry third-party contributions whose terms travel with them. Licensing is decided
  **per named product, after reading its contributor metadata**, and recorded in ADR-0024.
- **Never implement region download against a community tile service.** The OpenStreetMap
  Foundation's tile policy prohibits bulk downloading and offline prefetching from
  `tile.openstreetmap.org`, and instructs applications needing offline maps to self-host or use
  a provider whose terms permit it. This binds the **demo and tests too**, not just production:
  `OfflineRegionStore.download()` must only ever run against a self-hosted or explicitly
  offline-licensed source. Interactive browsing of a public host during development is a
  courtesy question; bulk download is a policy violation.
- Do not point production at public community/gov tile hosts; self-host or use PMTiles.
- **DEM/terrain data is an open decision**, as is bathymetry (above); the elevation
  source backing `raster-dem` contours and hillshade is unchosen. Coverage, vertical datum,
  resolution, archive size, and redistribution rights differ sharply between candidates, so this
  is a product decision to settle before the Phase 4 and Phase 6 exits — not an implementation
  detail.
- **Attribution is data, not chrome.** Every `TileSource` carries `attribution` rendered
  verbatim; a source whose terms cannot be met is not a source we ship in the demo.

## 9. Enforcement (build-time invariants)

- **Import isolation:** `@mapatlas/core` must import nothing from `maplibre-gl`/`react`/DOM/
  consumer packages — an import scan in CI fails the build otherwise (mirrors the isolation
  discipline used by the HookAtlas consumer). `@mapatlas/recorder-web`, `@mapatlas/storage-idb`,
  and `@mapatlas/offline-pmtiles` may use DOM/browser APIs but must not import `react` or
  `maplibre-gl`; `@mapatlas/maplibre` must not import `react`. Browser globals used by `core`'s
  *types only* (e.g. `Blob`) are declared, not imported.
- **No domain tokens:** a scan rejects domain words (fish, species, mushroom, etc.) and
  secret-shaped strings in `core`/`maplibre`.
- **API contract:** any change to a `specs/api.md` interface requires the same PR to update
  that file (checked in review / by the PR template).
- **Gates:** `build`, `typecheck` (strict), `lint`, `test` (seams mocked) must pass per task.
- **Renderer version pinning:** `maplibre-gl` is pinned to an exact version, not a range. The
  renderer is the one dependency whose major-version churn can break terrain, style, and marker
  behaviour at once; upgrades are a deliberate, separately-tested change, never a transitive
  surprise. Any drawing-library integration behind `enterDrawMode` is validated against that
  exact pin before it is adopted.
