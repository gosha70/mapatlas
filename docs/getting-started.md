<!-- SPDX-License-Identifier: Apache-2.0 -->

# Getting started with MAP-ATLAS

Embed a record → pin → review map loop in an afternoon. MAP-ATLAS is a
**domain-agnostic** engine: it records GPS tracks, drops events where they
happened, and (optionally) runs a photo analyzer you supply. It knows nothing
about your domain — you store your data in the neutral `tags` / `category` /
`fields` bags. The enforceable contract is [`specs/api.md`](../specs/api.md);
this guide is the fast path through it.

## 1. Install

Pick the packages you need. `@mapatlas/react` is the integration face; the rest
are swappable implementations behind the engine's seams.

```bash
npm install @mapatlas/core @mapatlas/react @mapatlas/maplibre \
            @mapatlas/storage-idb @mapatlas/recorder-web @mapatlas/offline-pmtiles \
            react react-dom maplibre-gl
```

Load MapLibre GL's stylesheet once (self-host it in production):

```html
<link rel="stylesheet" href="/assets/maplibre-gl.css" />
```

| Package | Provides | Seam it implements |
| --- | --- | --- |
| `@mapatlas/core` | types, sampling/simplify, `EventLog`, GeoJSON, `noopAnalyzer`, `createMemoryStorageAdapter` | — |
| `@mapatlas/react` | `<MapCanvas>`, `<EventComposer>`, `<TripReview>`, hooks | — |
| `@mapatlas/maplibre` | `createMapController`, `createTileLayer`, `createOfflineTileLayer` | renderer |
| `@mapatlas/storage-idb` | `createIdbStorageAdapter` | `StorageAdapter` |
| `@mapatlas/recorder-web` | `createWebTrackRecorder` | `TrackRecorder` |
| `@mapatlas/offline-pmtiles` | `createPMTilesOfflineRegionStore`, persistence helpers | `OfflineRegionStore` |

## 2. Choose a basemap

A `TileSource` is an XYZ/WMS template or a PMTiles archive plus **verbatim
attribution** (the renderer shows it exactly, for license compliance). Never
point production at a public community tile host — self-host or ship PMTiles
(see [`specs/architecture.md §8`](../specs/architecture.md)).

```ts
import type { TileSource } from "@mapatlas/core";

const sources: TileSource[] = [
  { id: "base", kind: "xyz", url: "https://tiles.example/{z}/{x}/{y}.png",
    attribution: "© OpenStreetMap contributors (ODbL)" },
];
```

## 3. Record a track

`useTrackRecorder` defaults to the web recorder (`watchPosition` + Screen Wake
Lock). It never emits a fix that fails the accuracy gate; `stop()` returns a
finalized `Track` (simplified geometry + distance) and persists it if you pass a
store.

```tsx
import { createIdbStorageAdapter } from "@mapatlas/storage-idb";
import { useTrackRecorder } from "@mapatlas/react";

const store = createIdbStorageAdapter("my-app");

function Recorder() {
  const rec = useTrackRecorder({ store });
  return (
    <div>
      <span>{rec.status}</span>
      <button onClick={() => rec.start()}>Start</button>
      <button onClick={() => rec.stop()}>Stop</button>
      {rec.error && <span role="alert">{rec.error.kind}</span>}
    </div>
  );
}
```

## 4. Show the map and drop events

`<MapCanvas>` is SSR-safe (it loads MapLibre GL on mount). Tap the map to place an
event with `<EventComposer>` — a comment plus in-place photo capture. Pass a
`store` so photos persist by `blobKey` (durable across reload). Pass an
`analyzer` to offer "Analyze photo"; if it `runsRemotely`, a disclosure is shown
before anything leaves the device. `analyzer` defaults to nothing — use
`noopAnalyzer` to exercise the path with no model.

```tsx
import { useState } from "react";
import { noopAnalyzer, type LatLng } from "@mapatlas/core";
import { MapCanvas, EventComposer, useEventLog } from "@mapatlas/react";

function FieldLogger() {
  const rec = useTrackRecorder({ store });
  const events = useEventLog(store, rec.track?.id);
  const [at, setAt] = useState<LatLng | null>(null);

  return (
    <>
      <MapCanvas
        sources={sources}
        track={rec.track}
        events={events.events}
        livePoint={rec.livePoint}
        onMapTap={setAt}
      />
      {at && (
        <EventComposer
          at={at}
          store={store}
          analyzer={noopAnalyzer}
          onSave={(input) => {
            void events.addEvent({ ...input, position: at, trackId: rec.track?.id });
            setAt(null);
          }}
          onCancel={() => setAt(null)}
        />
      )}
    </>
  );
}
```

## 5. Review and export

`<TripReview>` replays the track and browses events, photos, and stats. Export
is a lossless GeoJSON round-trip (media travels by reference + a manifest, not
inlined bytes).

```tsx
import { trackToGeoJSON } from "@mapatlas/core";
import { TripReview } from "@mapatlas/react";

<TripReview track={rec.track!} events={events.events} store={store} />;

const geojson = JSON.stringify(trackToGeoJSON(rec.track!, events.events));
// …offer `geojson` as a .geojson download.
```

## 6. Go offline

Download a bbox × zoom region, then render it with the network down.
`OfflineRegionStore` is renderer-neutral; wire its `readTile` into the MapLibre
offline layer.

```ts
import {
  createPMTilesOfflineRegionStore, pmtilesTileByteSource,
  requestPersistentStorage, installGuidance,
} from "@mapatlas/offline-pmtiles";
import { createOfflineTileLayer } from "@mapatlas/maplibre";

const offline = createPMTilesOfflineRegionStore({
  source: pmtilesTileByteSource("https://cdn.example/region.pmtiles"),
  cache: myTileCache, // e.g. an IndexedDB-backed TileCache
});

const region = await offline.download({
  name: "Trailhead", bbox: [-122.36, 47.59, -122.31, 47.63], minZoom: 12, maxZoom: 15,
});

const layer = createOfflineTileLayer(
  (z, x, y) => offline.readTile(region.id, z, x, y),
  { attribution: "© OpenStreetMap contributors (ODbL)" },
);
```

On mobile, tiles and data can be evicted unless storage is persistent — usually
after the app is installed to the home screen:

```ts
await requestPersistentStorage();     // navigator.storage.persist()
const help = installGuidance();       // platform-specific "add to home screen" steps
```

## 7. Swap any seam

Everything variable is an interface — supply your own to change behaviour
without touching the engine:

- **Storage** — implement `StorageAdapter` (a remote/sync store). Verify it with
  the shipped conformance suite: `runStorageAdapterConformance("mine", makeAdapter)`.
- **Analyzer** — implement `MediaAnalyzer` (on-device ONNX, or a remote vision
  model); set `runsRemotely` truthfully so the UI can disclose egress.
- **Recorder** — implement `TrackRecorder` (e.g. a native background recorder).
- **Renderer** — the engine is renderer-agnostic; MapLibre GL is one implementation.

See [`specs/api.md`](../specs/api.md) for every signature and
[`specs/architecture.md`](../specs/architecture.md) for the why.
