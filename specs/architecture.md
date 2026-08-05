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
│ @mapatlas/leaflet   Leaflet renderer: layered basemap, track,  │
│                     event markers, offline-region UI           │
├───────────────────────────────────────────────────────────────┤
│ @mapatlas/core      framework-agnostic: data model, TrackRecorder,│
│                     EventLog, sampling+simplify, interfaces:    │
│                     StorageAdapter · MediaAnalyzer · TileSource ·│
│                     OfflineRegionStore                          │
└───────────────────────────────────────────────────────────────┘
   │ default implementations (swappable)
   ▼
@mapatlas/storage-idb (IndexedDB)   ·   PMTiles offline regions   ·   web TrackRecorder
```

**The invariant:** arrows only point downward and outward. `core` imports nothing from
`leaflet`, `react`, the DOM, or any consumer. This is what makes the engine reusable and
testable, and it is CI-enforceable with an import scan (see §8).

## 2. Packages

| Package | Depends on | Responsibility |
|---|---|---|
| `@mapatlas/core` | nothing (pure TS) | Types, `TrackRecorder` interface + web recorder, `EventLog`, GPS sampling + `simplify`, `StorageAdapter`/`MediaAnalyzer`/`TileSource`/`OfflineRegionStore` interfaces, GeoJSON export/import |
| `@mapatlas/leaflet` | `core`, `leaflet` | `MapController`: mount a Leaflet map, layered `TileSource` stack, render live position + track polyline + event markers, region-download UX hooks |
| `@mapatlas/react` | `core`, `leaflet`, `react` | `<MapCanvas>`, `<EventComposer>`, `<TripReview>`, `useTrackRecorder`, `useEventLog`, `useOfflineRegions` |
| `@mapatlas/storage-idb` | `core`, `idb` | Default `StorageAdapter` over IndexedDB (tracks, events, media blobs) |
| `apps/demo` | all above | A generic field-logger (no real domain) proving the loop; also the manual test bed |

Monorepo via npm/pnpm workspaces. Each package is independently publishable ESM with types.

## 3. Data model (domain-neutral)

All ids are opaque strings (ULID/UUID). Coordinates are WGS84 `{ lat, lng }`.

- **`Track`** — one recording session: `id`, `startedAt`, `endedAt?`, `status`
  (`recording|paused|finalized`), `points: TrackPoint[]` (raw) and `simplified?: TrackPoint[]`,
  derived `distanceM?`, plus consumer `tags`/`meta`.
- **`TrackPoint`** — `lat`, `lng`, `t` (epoch ms), `accuracyM?`, `speedMps?`, `headingDeg?`.
- **`MapEvent`** — a pinned moment: `id`, `trackId?`, `position`, `occurredAt`, `comment?`,
  `media: MediaRef[]`, `tags: string[]`, `fields?: Record<string, JSONValue>` (consumer-defined),
  `category?: string`.
- **`MediaRef`** — `id`, `mime`, `width?`, `height?`, a `blobKey` (into the `StorageAdapter`)
  and/or `url`, and `analysis?: MediaAnalysis`.
- **`MediaAnalysis`** — analyzer output: `labels: { label: string; confidence: number }[]`,
  `summary?: string`, `model?: string`, `raw?: JSONValue`. The engine never interprets labels.

`fields`, `tags`, `category` are the domain seam in the *data*: HookAtlas stores `species`,
a foraging app stores `mushroomGenus`, the engine stores neither — just typed bags.

## 4. Key seams (interfaces, see `api.md` for signatures)

- **`TrackRecorder`** — `start/stop/pause/resume`, emits `TrackPoint`s. Web implementation
  wraps `navigator.geolocation.watchPosition` and holds a Screen Wake Lock while recording.
  A **native** recorder (Capacitor/Cordova background geolocation) is an out-of-tree adapter
  a consumer registers — the seam exists precisely so background tracking can be added without
  touching the engine. Sampling policy (distance/time/accuracy filter) is configurable.
- **`StorageAdapter`** — persistence for tracks, events, and media blobs. Default:
  IndexedDB (`@mapatlas/storage-idb`). A consumer can supply a remote/sync adapter. The
  engine treats storage as async CRUD and never assumes locality beyond the default.
- **`MediaAnalyzer`** — `analyze(input) => Promise<MediaAnalysis>`. Optional; absent → no
  analysis UI. Implementations may run on-device (ONNX/TF.js/Core ML via a native bridge) or
  call a remote vision model. **This is an egress boundary** — see `SECURITY.md`.
- **`TileSource`** — a basemap or overlay layer: an XYZ/WMS URL template or a PMTiles archive,
  plus attribution. The renderer composites an ordered stack. No provider is hardcoded.
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
- **Simplification**: keep raw points; also maintain a Douglas–Peucker–simplified line
  (via an embedded `simplify` routine) for rendering and export.
- **Geometry**: internally an array of points; **export** as GeoJSON `LineString` (track) +
  `Point` features (events). A consumer with PostGIS stores this as `geography(LineString)` —
  but the engine has no database opinion.

## 7. Rendering (Leaflet)

- Leaflet chosen over MapLibre: the engine's dynamic content is one track + a handful of
  markers (trivial for Leaflet, lighter on an all-day mobile battery), and expected overlays
  (nautical charts, seamarks) are raster. PMTiles keeps a future MapLibre renderer possible
  as a sibling package without changing `core`. (ADR-0002.)
- The renderer takes an **ordered `TileSource[]`** (base → overlays), a `Track`, and a
  `MapEvent[]`, and exposes imperative controls (recenter, fit-track, add/tap event) that the
  React layer wraps. Markers use DivIcons (no image assets). Controls are keyboard-accessible.

## 8. Map data & licensing

The engine bundles no tiles. It documents, and consumers must honor:

- **OpenStreetMap** base — © OpenStreetMap contributors, **ODbL**; attribution required.
- **OpenSeaMap** seamark overlay — **ODbL, share-alike**; attribution required; overlay only.
- **NOAA** charts (NCDS/ENC) and bathymetry — **US public domain**; preferred for a commercial
  consumer over GEBCO (whose terms lean non-commercial).
- Do not point production at public community/gov tile hosts; self-host or use PMTiles.

## 9. Enforcement (build-time invariants)

- **Import isolation:** `@mapatlas/core` must import nothing from `leaflet`/`react`/DOM/
  consumer packages — an import scan in CI fails the build otherwise (mirrors the isolation
  discipline used by the HookAtlas consumer).
- **No domain tokens:** a scan rejects domain words (fish, species, mushroom, etc.) and
  secret-shaped strings in `core`/`leaflet`.
- **API contract:** any change to a `specs/api.md` interface requires the same PR to update
  that file (checked in review / by the PR template).
- **Gates:** `build`, `typecheck` (strict), `lint`, `test` (seams mocked) must pass per task.
