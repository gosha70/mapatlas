<!-- SPDX-License-Identifier: Apache-2.0 -->

# Getting started with MAP-ATLAS

Embed the **record → pin → photo → review** loop in an afternoon. This guide is
derived from the public contract in [`specs/api.md`](../specs/api.md); every type
and function referenced here is exported from a `@mapatlas/*` package.

MAP-ATLAS is a **domain-agnostic** engine: it knows about tracks, events, media,
and maps — never about fish, plants, products, users, or a database. Your domain
rides in the neutral bags `tags`, `category`, and `fields`, and everything
variable (AI, storage, geolocation, basemaps) sits behind an interface you can
swap.

## 1. Install

```bash
npm install @mapatlas/core @mapatlas/react @mapatlas/leaflet @mapatlas/storage-idb
```

- `@mapatlas/core` — framework-agnostic data model, seams, geometry, GeoJSON.
- `@mapatlas/leaflet` — the Leaflet renderer (`MapController`) + PMTiles offline.
- `@mapatlas/react` — hooks and components (`<MapCanvas>`, `<EventComposer>`, …).
- `@mapatlas/storage-idb` — the default IndexedDB `StorageAdapter`.

Leaflet needs its stylesheet. Add it once in your HTML `<head>`:

```html
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
```

## 2. The smallest map + event loop

`<MapCanvas>` is SSR-safe: Leaflet is loaded lazily inside an effect, so importing
`@mapatlas/react` never touches `window`.

```tsx
import { useMemo, useState } from "react";
import type { LatLng, MapEvent } from "@mapatlas/core";
import {
  MapCanvas,
  EventComposer,
  useEventLog,
  useTrackRecorder,
} from "@mapatlas/react";
import { IdbStorageAdapter } from "@mapatlas/storage-idb";

const SOURCES = [
  {
    id: "osm",
    kind: "xyz" as const,
    url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: "© OpenStreetMap contributors", // rendered verbatim (ODbL)
  },
];

export function FieldLogger() {
  const storage = useMemo(() => new IdbStorageAdapter(), []);
  const rec = useTrackRecorder({ store: storage });
  const { events, addEvent } = useEventLog(storage, rec.track?.id);
  const [at, setAt] = useState<LatLng | null>(null);

  return (
    <>
      <button onClick={() => rec.start()}>Start</button>
      <button onClick={() => rec.stop()}>Stop</button>

      <div style={{ height: 420 }}>
        <MapCanvas
          sources={SOURCES}
          track={rec.track}
          events={events}
          livePoint={rec.livePoint}
          onMapTap={setAt}
        />
      </div>

      {at && (
        <EventComposer
          at={at}
          store={storage}
          onSave={async (input: Omit<MapEvent, "id" | "position">) => {
            await addEvent({ ...input, position: at });
            setAt(null);
          }}
          onCancel={() => setAt(null)}
        />
      )}
    </>
  );
}
```

That is the whole loop: **start** a recording (the web recorder uses
`watchPosition` + a Screen Wake Lock), **tap** the map to pin an event, capture a
photo in place, and **stop** to get a finalized `Track` (simplified line +
distance). All writes are local and durable — recording never needs the network.

## 3. The seams you can swap

Everything variable is an interface (see [`specs/api.md`](../specs/api.md)):

| Seam | Interface | Default |
|---|---|---|
| Persistence | `StorageAdapter` | `IdbStorageAdapter` (`@mapatlas/storage-idb`) |
| Geolocation | `TrackRecorder` | `createWebTrackRecorder` (`@mapatlas/core`) |
| Photo AI | `MediaAnalyzer` | `noopAnalyzer` (`@mapatlas/core`) |
| Basemap/tiles | `TileSource` | you provide (XYZ / WMS / PMTiles) |
| Offline regions | `OfflineRegionStore` | `PmtilesOfflineRegionStore` (`@mapatlas/leaflet`) |

Pass a fake to any of them in tests. Core ships a reusable conformance suite for
storage:

```ts
import { runStorageAdapterConformance } from "@mapatlas/core/testing";
runStorageAdapterConformance("my-adapter", () => new MyAdapter());
```

## 4. Photo analysis (optional, opt-in, egress-aware)

Give `<EventComposer>` a `MediaAnalyzer` and an **Analyze photo** action appears.
The analyzer returns *suggested* labels the user explicitly confirms; confirmed
labels become the event's `tags`. If the analyzer `runsRemotely`, the composer
shows a disclosure before any bytes leave the device (ADR-0005). The engine never
interprets label meaning — it stores and displays; your app decides what a label
means.

```tsx
<EventComposer at={at} store={storage} analyzer={myAnalyzer} onSave={…} onCancel={…} />
```

## 5. Review a trip

```tsx
import { TripReview } from "@mapatlas/react";

<TripReview track={finalizedTrack} events={events} />;
```

`<TripReview>` shows stats (distance, points, events, duration), a scrubbable /
playable replay of the track, and the events with their photos. It takes only
`{ track, events }`; resolve any `blobKey` to an object URL (via
`StorageAdapter.getBlob`) before passing events in.

## 6. Offline maps

Download a bounding box × zoom range as PMTiles and render it with the network
off:

```ts
import { PmtilesOfflineRegionStore } from "@mapatlas/leaflet";

const regions = new PmtilesOfflineRegionStore({ archiveUrl: "/basemap.pmtiles" });
await regions.download({
  name: "Home bay",
  bbox: [-0.2, 51.4, 0.0, 51.6], // [west, south, east, north]
  minZoom: 10,
  maxZoom: 15,
});
```

On iOS especially, ask for durable storage and guide the user to install to the
home screen so the OS does not evict your data:

```ts
import { requestPersistentStorage, installPromptGuidance } from "@mapatlas/react";

if ((await requestPersistentStorage()) !== "persisted") {
  showBanner(installPromptGuidance()); // platform-aware copy
}
```

## 7. Export / import (portability)

```ts
import { trackToGeoJSON, geoJSONToTrack } from "@mapatlas/core";

const fc = trackToGeoJSON(track, events); // standard geometry + canonical foreign member
const { track: t2, events: e2 } = geoJSONToTrack(fc); // loss-free round-trip
```

Export is a standard GeoJSON `FeatureCollection` (a track is a `LineString`, an
event is a `Point`) with a canonical engine copy under a `mapatlas:` foreign
member, so round-trips lose nothing while third-party GeoJSON still imports as a
minimal track. Media travels **by reference** (`blobKey`/`url`), never inlined
(ADR-0008).

## 8. Licensing your basemap

The engine bundles no tiles. Honor your data source's terms and render its
`attribution` verbatim: OpenStreetMap (ODbL), OpenSeaMap seamarks (ODbL,
share-alike, overlay only), NOAA charts/bathymetry (US public domain). Do not
point production at public community tile hosts — self-host or use PMTiles
(architecture.md §8).

## Where next

- The full working example: [`apps/demo`](../apps/demo) — the generic field
  logger wiring recorder + map + event + storage + offline.
- The contract: [`specs/api.md`](../specs/api.md).
- The rationale: [`specs/architecture.md`](../specs/architecture.md) and the ADR
  log in [`specs/decisions.md`](../specs/decisions.md).
