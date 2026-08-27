<!-- SPDX-License-Identifier: Apache-2.0 -->

# MAP-ATLAS — Product Requirements

> Canonical, harness-neutral. This is the "what" and "for whom." The "how" is
> [`architecture.md`](architecture.md); the contract is [`api.md`](api.md).

## 1. One-line

An open-source engine that lets any app record a field trip on an interactive map — a GPS
track plus events (a place + comment + photos) — offline-first, with optional pluggable AI
analysis of the photos.

## 2. Problem

People who do things *in the field* — anglers, foragers, birders, surveyors, hikers,
citizen scientists — want to remember **where** something happened and **what** it was,
in the moment, without fighting their phone. Existing options are either heavyweight GIS,
closed consumer apps welded to one domain, or a notes app plus a separate map. There is no
clean, embeddable, domain-neutral building block for "map + track + timestamped
photo-event + optional AI ID," especially one that works with no signal.

MAP-ATLAS is that building block. It is **not** an end-user product; it is the engine other
products embed.

## 3. Users

- **Primary: developers** building a field-observation app who want to embed mapping +
  tracking + event logging instead of rebuilding it. They supply the domain (species,
  categories) and any AI analyzer.
- **Secondary: the end users** of those apps, who operate the map: start a trip, drop a
  pin, add a note and a photo, review the trip later — on the water, in the woods, off-grid.
- **Reference consumer:** HookAtlas (a private fishing journal) is the first real consumer
  and validates the seams, but MAP-ATLAS ships nothing fishing-specific.

## 4. Core user stories (engine capabilities)

1. **Start / stop a trip** and see my live position and a growing track on the map.
2. **Drop an event** at my current location (or a tapped location) in one action.
3. **Attach a comment and one or more photos** to an event without leaving the map.
4. **Tag / categorize** an event with consumer-defined labels and custom fields.
5. **Work fully offline** — record a whole trip with no connectivity; nothing is lost.
6. **Download a map region** ahead of time so the basemap is available off-grid.
7. **Review a past trip** on a high-detail basemap — including **topographic** terrain,
   contours, hillshade or bathymetry — with the start and finish clearly marked, the route
   drawn per active segment (pauses are gaps, not straight lines), and every pinpoint on it.
8. **See a pinpoint as the right kind of mark**: the consumer decides what a category looks
   like (a comment bubble, a photo thumbnail, a custom sign for a particular feature); the
   engine draws what it is told and knows nothing about the meaning.
9. **Review the numbers**: distance, elapsed vs moving time, pace/speed, elevation gain, laps,
   and any sensor channel recorded along the way.
10. **Record sensor telemetry alongside the track** — heart rate, cadence, water depth,
    temperature — sampled on an interval or pushed by a device, carried per track point.
11. **Split a trip into laps/segments** while recording, and pause and resume without
    corrupting the geometry.
12. **Re-create a trip by hand**: draw the route on the map, add and drag vertices, undo,
    set or interpolate the times, and drop pinpoints on it — producing a track
    indistinguishable from a recorded one.
13. **(Optional) Analyze a photo**: if the consumer provided an analyzer, get suggested
    labels/summary for an event's photo (e.g. species ID), which the user confirms.
14. **Export / import** a trip in a portable format (GeoJSON + media manifest).
15. **Resume after a crash**: an interrupted recording is recoverable, not lost.

## 5. Scope (v1 = the engine)

**In:**
- Framework-agnostic core (data model, track recorder abstraction, sensor-channel seam,
  segments/laps, derived stats, manual track authoring, event log, storage interface,
  offline-region interface, analyzer interface, GPS sampling + track simplification).
- A MapLibre GL renderer with a layered source stack (raster, vector, and elevation/terrain),
  3D terrain + hillshade support, track/event rendering, a **consumer-owned presentation seam**
  for marks, and a draw/edit interaction mode.
- React bindings (components + hooks) as the primary integration surface, including a trip
  list, a track editor, a configurable event composer, and a trip review with channel charts.
- A default IndexedDB storage adapter and a PMTiles offline-region implementation.
- A generic demo app (a plain "field logger" — no real domain) proving the whole loop,
  including a fake sensor channel and hand-drawn track authoring.
- Export/import to GeoJSON + media manifest, preserving segments, altitude, and channels.

**Out (v1 non-goals):**
- Any specific domain (fish/plant/mushroom taxonomies) — that's a consumer.
- Any bundled AI model — analyzers are injected; the repo ships only the interface + a no-op.
- Accounts, auth, servers, multi-user sync, or a hosted backend — consumer concerns.
- Privacy/sharing transforms on data (coarsening, fuzzing) — the engine exposes raw
  primitives; a consumer applies its own privacy rules before anything leaves a device.
- Native background GPS *implementation* — v1 defines the `TrackRecorder` seam and ships the
  web (foreground) recorder; a native adapter is a documented extension point (see roadmap).
- Any **device driver** for a sensor (BLE heart-rate, ANT+, depth sounder, HealthKit) — v1
  defines the `SensorSource` seam plus a polling adapter and a fake; the consumer owns the
  device. The engine is never taught what a channel *means*.
- Bundled marker icon assets or a marker icon set — the presentation seam takes consumer
  markup/assets; the engine bundles no imagery.
- Turn-by-turn navigation, routing, or nautical-navigation certification.
- **Geocoding / place search.** No `Geocoder` interface ships in v1 — no v1 use case needs one,
  and a seam nobody consumes is speculation. A consumer wires its own provider; the engine must
  never bake in a public geocoding endpoint.
- **Coordinate systems other than WGS84.** The data model is WGS84 `{lat, lng}` and the renderer
  is Web Mercator. Consumers needing national grids, UTM, or arbitrary projected CRS are a
  documented escape hatch — an OpenLayers renderer sibling against the same `core` — not a v1
  capability. This bounds what "surveyors" in §3 means: they collect WGS84 positions in the
  field; they do not get projected-CRS map authoring from v1.

## 6. Success criteria

- A developer can embed the React `<MapCanvas>` + recorder + event composer and get the
  full record→pin→photo→review loop working in an afternoon, reading only `api.md`.
- The demo app records a trip and events **fully offline**, persists across reload, and
  exports valid GeoJSON.
- Swapping in a `MediaAnalyzer` (even a stub) adds photo-analysis with **zero core changes**.
- Adding a `SensorSource` (even the fake) attaches a telemetry channel to every track point,
  charts it in review, and exports it — with **zero core changes**.
- A consumer supplies an `EventPresentation` and its categories render as its own marks —
  with **zero renderer changes** and no engine knowledge of the categories.
- A trip drawn by hand is byte-for-byte the same shape as a recorded one: same review, same
  stats, same export.
- The core package has **no** dependency on MapLibre, React, a browser, or any domain — it
  is unit-testable in Node with fakes.

## 7. Constraints & principles

- **TypeScript strict**, tree-shakeable ESM, minimal runtime deps.
- **Offline-first**, not offline-capable-as-an-afterthought.
- **Seams over features**: anything a consumer might vary is an interface, not a fork point.
- **Accessible & themeable**: keyboard-operable controls, visible focus, no hardcoded brand.
- **Apache-2.0 + DCO**; SPDX headers on every source file.
