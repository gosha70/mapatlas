<!-- SPDX-License-Identifier: Apache-2.0 -->

# MAP-ATLAS — Public API contract

> The interfaces to **build against**. Treat this as the spec: implementations conform to
> these signatures and contracts. Changing a signature requires updating this file in the
> same change plus an ADR in [`decisions.md`](decisions.md). Types are illustrative
> TypeScript — names and shapes are the contract; bodies are the build.

## 1. Core data types (`@mapatlas/core`)

```ts
export type Id = string;                       // opaque (ULID/UUID)
export type JSONValue =
  | null | boolean | number | string
  | JSONValue[] | { [k: string]: JSONValue };

export interface LatLng { lat: number; lng: number; }

export interface TrackPoint extends LatLng {
  t: number;              // epoch ms
  accuracyM?: number;
  speedMps?: number;
  headingDeg?: number;
}

export type TrackStatus = "recording" | "paused" | "finalized";

export interface Track {
  id: Id;
  startedAt: number;
  endedAt?: number;
  status: TrackStatus;
  points: TrackPoint[];        // raw kept points
  simplified?: TrackPoint[];   // Douglas–Peucker output for render/export
  distanceM?: number;          // derived on finalize
  tags?: string[];
  meta?: Record<string, JSONValue>;
}

export interface MediaAnalysis {
  labels: { label: string; confidence: number }[];
  summary?: string;
  model?: string;
  raw?: JSONValue;
}

export interface MediaRef {
  id: Id;
  mime: string;
  width?: number;
  height?: number;
  blobKey?: string;    // key into StorageAdapter blob store
  url?: string;        // alternative to blobKey (already-hosted media)
  analysis?: MediaAnalysis;
}

export interface MapEvent {
  id: Id;
  trackId?: Id;
  position: LatLng;
  occurredAt: number;
  comment?: string;
  media: MediaRef[];
  tags: string[];
  category?: string;
  fields?: Record<string, JSONValue>;   // consumer-defined domain data
}
```

### 1a. Core utilities (`@mapatlas/core`)

Concrete helpers implemented in Phase 1 against the types above. Additive to the seams
below; adding a helper here never changes an existing interface signature.

```ts
// Ids — ULID (26-char Crockford base32), lexicographically sortable.
export function newId(): Id;
export const ID_LENGTH: number;                 // 26

// Geometry (metres, WGS-84 haversine).
export const EARTH_RADIUS_M: number;
export function haversineMeters(a: LatLng, b: LatLng): number;
export function pathLengthMeters(points: readonly LatLng[]): number;

// Sampling decision (pure). Accuracy filter runs first, so a recorder built on
// this never emits a point that fails the accuracy gate.
export const DEFAULT_SAMPLING_POLICY: SamplingPolicy;   // { 10, 15000, 50 }
export type SampleReason =
  | "first" | "interval" | "distance" | "too-close" | "low-accuracy";
export interface SampleDecision { keep: boolean; reason: SampleReason; }
export function sample(
  prev: TrackPoint | undefined, candidate: TrackPoint, policy: SamplingPolicy,
): SampleDecision;

// Track geometry.
export function simplify(points: TrackPoint[], toleranceM: number): TrackPoint[]; // Douglas–Peucker
export const DEFAULT_SIMPLIFY_TOLERANCE_M: number;      // 5
export interface FinalizedTrack { simplified: TrackPoint[]; distanceM: number; }
export function finalizeTrack(points: TrackPoint[], toleranceM?: number): FinalizedTrack;

// Event log — create/update/delete map events against a StorageAdapter.
export class EventLog {
  constructor(store: StorageAdapter, trackId?: Id);
  list(): Promise<MapEvent[]>;                          // scoped to trackId when given
  create(input: Omit<MapEvent, "id">): Promise<MapEvent>;
  update(event: MapEvent): Promise<void>;
  delete(id: Id): Promise<void>;
}
```

## 2. Track recording

The `TrackRecorder` interface, `SamplingPolicy`, and error types live in
`@mapatlas/core` (framework-agnostic). The **web recorder implementation**
(`createWebTrackRecorder`) uses `navigator.geolocation` + the Screen Wake Lock,
so it ships in a separate DOM-facing package, **`@mapatlas/recorder-web`** — this
keeps `core` DOM-free and passing the import-isolation scan (ADR-0011).

```ts
// @mapatlas/core
export interface SamplingPolicy {
  minDistanceM: number;   // keep a fix only after moving this far (default ~10)
  maxIntervalMs: number;  // ...or after this long (default ~15000)
  maxAccuracyM: number;   // drop fixes worse than this (default ~50)
}

export interface TrackRecorder {
  readonly status: TrackStatus;
  start(opts?: Partial<SamplingPolicy>): Promise<void>;
  pause(): void;
  resume(): void;
  stop(): Promise<Track>;                 // finalizes: simplify + distance
  /** Subscribe to kept points (post-sampling). Returns an unsubscribe fn. */
  onPoint(cb: (p: TrackPoint) => void): () => void;
  onError(cb: (e: TrackRecorderError) => void): () => void;
}

export type TrackRecorderErrorKind =
  | "permission-denied" | "position-unavailable" | "timeout" | "unsupported";
export interface TrackRecorderError { kind: TrackRecorderErrorKind; message: string; }

// @mapatlas/recorder-web — the v1 web (foreground) recorder.
// `deps` is optional and defaults to the ambient `navigator` at start() time
// (never at import, so construction is SSR-safe); tests inject fakes.
export interface WebRecorderDeps {
  geolocation?: Geolocation;
  wakeLock?: { request(type: "screen"): Promise<{ release(): Promise<void> }> } | null;
}
export declare function createWebTrackRecorder(
  store?: StorageAdapter, deps?: WebRecorderDeps,
): TrackRecorder;
/** Native background recorders (Capacitor/Cordova) are out-of-tree adapters
 *  that also implement TrackRecorder and are injected by the consumer. */
```

**Contract:** a recorder never emits a point that fails the accuracy filter; `stop()`
returns a finalized `Track` with `simplified` and `distanceM` populated; the web recorder
requests a Wake Lock on `start` and releases it on `stop`/`pause`.

## 3. Persistence seam (`@mapatlas/core`; default impl in `@mapatlas/storage-idb`)

```ts
export interface StorageAdapter {
  saveTrack(t: Track): Promise<void>;
  getTrack(id: Id): Promise<Track | undefined>;
  listTracks(): Promise<Track[]>;
  deleteTrack(id: Id): Promise<void>;

  saveEvent(e: MapEvent): Promise<void>;
  getEvent(id: Id): Promise<MapEvent | undefined>;
  listEvents(trackId?: Id): Promise<MapEvent[]>;
  deleteEvent(id: Id): Promise<void>;

  putBlob(blob: Blob): Promise<string>;      // returns blobKey
  getBlob(key: string): Promise<Blob | undefined>;
  deleteBlob(key: string): Promise<void>;

  /** Wipe everything — consumers call this on sign-out to leave no local data. */
  clearAll(): Promise<void>;
}
```

**Contract:** all methods are async and side-effect-local by default; `clearAll()` must
remove every track, event, and blob (consumers rely on this for a clean device wipe).

Additive helpers (never change the interface above; ADR-0010):

```ts
// In-memory StorageAdapter — a fake for tests and an SSR/preview fallback.
export function createMemoryStorageAdapter(): StorageAdapter;

// Reusable conformance suite (ships in @mapatlas/core, imported from *.test.ts).
// Verifies any adapter against the contract above; excluded from the built dist
// because it imports the test runner.
export function runStorageAdapterConformance(
  name: string, make: () => StorageAdapter | Promise<StorageAdapter>,
): void;
```

The default IndexedDB implementation ships in `@mapatlas/storage-idb`:

```ts
export function createIdbStorageAdapter(dbName?: string): StorageAdapter;
```

## 4. AI analyzer seam (`@mapatlas/core`)

```ts
export interface AnalyzeInput {
  blob?: Blob;            // the photo bytes...
  url?: string;           // ...or a reference to already-hosted media
  hint?: { tags?: string[]; category?: string };   // optional consumer context
}

export interface MediaAnalyzer {
  readonly id: string;                 // e.g. "onnx-yolo-v8", "remote-vision-llm"
  readonly runsRemotely: boolean;      // true ⇒ egress; consumer must disclose/gate
  analyze(input: AnalyzeInput): Promise<MediaAnalysis>;
}

/** No-op analyzer shipped in v1 so the analysis code path is testable. */
export declare const noopAnalyzer: MediaAnalyzer;
```

**Contract:** the engine calls `analyze` only in response to an explicit user action; if
`runsRemotely`, the React layer surfaces that before sending. The engine never inspects or
acts on label *meaning* — it stores and displays the result; the consumer interprets it.

## 5. Basemap & offline tiles

```ts
export interface TileSource {
  id: string;
  kind: "xyz" | "wms" | "pmtiles";
  url: string;                 // template, WMS endpoint, or .pmtiles location
  attribution: string;         // rendered verbatim (license compliance)
  opacity?: number;
  minZoom?: number; maxZoom?: number;
}

export interface OfflineRegion {
  id: Id; name: string;
  bbox: [west: number, south: number, east: number, north: number];
  minZoom: number; maxZoom: number;
  sizeBytes?: number; downloadedAt?: number;
}

export interface OfflineRegionStore {
  download(region: Omit<OfflineRegion, "id" | "sizeBytes" | "downloadedAt">,
           onProgress?: (fraction: number) => void): Promise<OfflineRegion>;
  list(): Promise<OfflineRegion[]>;
  delete(id: Id): Promise<void>;
  estimateSize(region: Pick<OfflineRegion, "bbox" | "minZoom" | "maxZoom">): Promise<number>;
}
```

## 6. Renderer (`@mapatlas/leaflet`)

```ts
export interface MapControllerOptions {
  container: HTMLElement;
  sources: TileSource[];          // ordered base → overlays
  center?: LatLng; zoom?: number;
}
export interface MapController {
  setSources(sources: TileSource[]): void;
  renderTrack(track: Track | null): void;
  renderEvents(events: MapEvent[]): void;
  showLivePosition(p: TrackPoint | null): void;
  fitTrack(track: Track): void;
  recenter(to: LatLng, zoom?: number): void;
  onMapTap(cb: (at: LatLng) => void): () => void;
  onEventClick(cb: (id: Id) => void): () => void;
  destroy(): void;
}
export declare function createMapController(o: MapControllerOptions): MapController;

// Additive helper: build a Leaflet layer for any TileSource kind (xyz | wms |
// pmtiles). pmtiles renders raster tiles read from the archive by (z, x, y).
export declare function createTileLayer(source: TileSource, mime?: string): L.Layer;
```

Rendering notes: event markers are keyboard-reachable Leaflet `DivIcon`s (no image
assets); a visible-focus stylesheet is injected once; `fitTrack`/`recenter` pass
`animate: false` when `prefers-reduced-motion: reduce` is set.

## 7. React bindings (`@mapatlas/react`)

```ts
export function useTrackRecorder(opts?: {
  recorder?: TrackRecorder; store?: StorageAdapter; sampling?: Partial<SamplingPolicy>;
}): {
  status: TrackStatus; livePoint?: TrackPoint; track?: Track;
  start(): Promise<void>; pause(): void; resume(): void; stop(): Promise<Track>;
  error?: TrackRecorderError;
};

export function useEventLog(store: StorageAdapter, trackId?: Id): {
  events: MapEvent[];
  addEvent(input: Omit<MapEvent, "id">): Promise<MapEvent>;
  updateEvent(e: MapEvent): Promise<void>;
  deleteEvent(id: Id): Promise<void>;
};

export function useOfflineRegions(store: OfflineRegionStore): {
  regions: OfflineRegion[];
  download(r: Parameters<OfflineRegionStore["download"]>[0]): Promise<void>;
  remove(id: Id): Promise<void>;
};

// Components. MapCanvas is SSR-safe (loads Leaflet dynamically on mount, so no
// `window` at import). `className`/`style` are additive, optional layout props.
export function MapCanvas(props: {
  sources: TileSource[]; track?: Track; events?: MapEvent[]; livePoint?: TrackPoint;
  onMapTap?(at: LatLng): void; onEventClick?(id: Id): void;
  className?: string; style?: React.CSSProperties;
}): JSX.Element;

// `store?` is additive (ADR-0012): given a store, captured photos persist via
// putBlob → blobKey (durable across reload); without one, they use object URLs.
export function EventComposer(props: {
  at: LatLng; analyzer?: MediaAnalyzer; store?: StorageAdapter;
  onSave(input: Omit<MapEvent, "id" | "position">): void; onCancel(): void;
}): JSX.Element;   // comment field + in-place photo capture; if analyzer, "Analyze photo" → suggested labels the user confirms (remote analyzers disclosed)

// `store?` is additive: resolves photo previews stored by blobKey.
export function TripReview(props: {
  track: Track; events: MapEvent[]; store?: StorageAdapter;
}): JSX.Element;
```

## 8. Portability (`@mapatlas/core`)

```ts
export function trackToGeoJSON(track: Track, events: MapEvent[]): GeoJSON.FeatureCollection;
export function geoJSONToTrack(fc: GeoJSON.FeatureCollection): { track: Track; events: MapEvent[] };
```

**Contract:** export/import round-trips without losing geometry, timestamps, comments, tags,
`fields`, or `analysis` (media travels by reference + a manifest, not inlined bytes).
