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

/** A named numeric telemetry stream carried per track point. Keys are consumer-defined
 *  ("heartRateBpm", "cadenceRpm", "depthM", "waterTempC"); the engine never interprets them. */
export interface ChannelDescriptor {
  key: string;                 // matches a key in TrackPoint.channels
  label: string;               // rendered verbatim; the consumer owns the wording
  unit: string;                // rendered verbatim ("bpm", "rpm", "m", "°C")
  min?: number; max?: number;  // display bounds only — never used to reject samples
  aggregate?: "avg" | "sum" | "min" | "max" | "last";   // roll-up used by computeStats (default "avg")
  precision?: number;          // decimal places for display
}

/** A point being authored by hand (§4). Its timestamp may not exist yet: vertices are
 *  placed first and timed later. `toTrack()` is the boundary where every invariant a
 *  finalized track guarantees — a timestamp on every point above all — must hold. A
 *  recorded point is never timeless, which is why `TrackPoint.t` stays required. */
export interface DraftTrackPoint extends LatLng {
  t?: number;
  accuracyM?: number;
  altitudeM?: number;
  altitudeAccuracyM?: number;
  speedMps?: number;
  headingDeg?: number;
  channels?: Record<string, number>;
}

export interface TrackPoint extends LatLng {
  t: number;              // epoch ms
  accuracyM?: number;
  altitudeM?: number;             // WGS84 ellipsoidal metres, when the fix provides it
  altitudeAccuracyM?: number;
  speedMps?: number;
  headingDeg?: number;
  channels?: Record<string, number>;   // sensor values merged at this point (see §3)
}

export type TrackStatus = "recording" | "paused" | "finalized";

/** A contiguous span of *active* recording. The gap between consecutive segments is a
 *  pause: renderers draw one polyline per segment and never bridge the gap. */
export interface TrackSegment {
  id: Id;
  startIndex: number;     // inclusive index into Track.points
  endIndex: number;       // inclusive
  startedAt: number;
  endedAt?: number;
  distanceM?: number;
}

/** A user- or consumer-marked split ("Lap 3", "Drift 2"). Laps subdivide active recording
 *  and may span segments. `label` is consumer text; the engine never generates domain names. */
export interface TrackLap {
  id: Id;
  index: number;          // 0-based order
  startIndex: number; endIndex: number;   // inclusive indices into Track.points
  startedAt: number; endedAt?: number;
  label?: string;
  stats?: TrackStats;
}

export interface ChannelStats { min: number; max: number; avg: number; sum: number; last?: number; count: number; }

export interface TrackStats {
  distanceM: number;
  durationMs: number;         // endedAt - startedAt (elapsed, including pauses)
  movingTimeMs: number;       // sum of segment durations (excludes pauses)
  avgSpeedMps?: number;       // distanceM / movingTimeMs
  maxSpeedMps?: number;
  elevationGainM?: number;    // sum of positive altitude deltas, hysteresis-filtered
  elevationLossM?: number;
  minAltitudeM?: number; maxAltitudeM?: number;
  channels?: Record<string, ChannelStats>;   // one entry per ChannelDescriptor with data
}

export type TrackOrigin = "recorded" | "authored" | "imported";

export interface Track {
  id: Id;
  startedAt: number;
  endedAt?: number;
  status: TrackStatus;
  origin: TrackOrigin;         // "authored" ⇒ drawn by hand (§4), not recorded from GPS
  points: TrackPoint[];        // raw kept points — the single source of truth
  segments: TrackSegment[];    // active spans; a recording with no pause has exactly one
  /** Douglas–Peucker output for rendering, one member per `segments[n]` and in the same
   *  order. Simplification is per segment: a raw index means nothing in a decimated array,
   *  and simplifying the concatenated points would smooth a pause into continuous
   *  geometry. Never used for export — see §10.
   *
   *  **A disposable cache.** Deleting this field must never change what the track means:
   *  `finalizeTrack` regenerates it deterministically from `points` + `segments`, so the
   *  same input yields byte-identical output. That is what makes a storage migration or a
   *  change of simplification algorithm safe — drop the cache and rebuild (ADR-0018). */
  simplifiedSegments?: TrackPoint[][];
  laps?: TrackLap[];
  channels?: ChannelDescriptor[];   // descriptors for the keys present in points[].channels
  stats?: TrackStats;               // derived on finalize
  tags?: string[];
  meta?: Record<string, JSONValue>;
}

/** The list projection. `listTrackSummaries()` must not hydrate point arrays — a consumer
 *  showing a trip list of hundreds of tracks pays only for what it displays. */
export interface TrackSummary {
  id: Id;
  startedAt: number; endedAt?: number;
  status: TrackStatus;
  origin: TrackOrigin;
  stats?: TrackStats;
  pointCount: number;
  eventCount?: number;
  bbox?: [west: number, south: number, east: number, north: number];
  start?: LatLng; finish?: LatLng;
  channelKeys?: string[];
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
  category?: string;                    // the presentation seam (§8) keys off this
  fields?: Record<string, JSONValue>;   // consumer-defined domain data
}
```

## 2. Track recording (`@mapatlas/core` interface · `@mapatlas/recorder-web` implementation)

```ts
export interface SamplingPolicy {
  minDistanceM: number;   // keep a fix only after moving this far (default 10)
  maxIntervalMs: number;  // ...or after this long (default 15000)
  maxAccuracyM: number;   // drop fixes worse than this (default 50)
}

export declare const DEFAULT_SAMPLING_POLICY: Readonly<SamplingPolicy>;
export declare function resolveSamplingPolicy(partial?: Partial<SamplingPolicy>): SamplingPolicy;

export type SampleReason =
  | "inaccurate"        // rejected: worse than maxAccuracyM
  | "first-point"       // kept: nothing to compare against
  | "moved"             // kept: travelled further than minDistanceM
  | "interval-elapsed"  // kept: maxIntervalMs has elapsed
  | "too-close";        // rejected: too near the last kept point, and too soon

export interface SampleDecision {
  keep: boolean;
  reason: SampleReason;
  distanceM?: number;   // from the previous kept point; absent for the first
  elapsedMs?: number;   // since the previous kept point; absent for the first
}

/** Pure: no clock, no state, no I/O. The caller owns which point was last kept. */
export declare function sample(
  previous: TrackPoint | undefined,
  candidate: TrackPoint,
  policy?: SamplingPolicy,
): SampleDecision;

/** Spherical, closed-form. For cheap geometric decisions like sampling — never for
 *  recorded distance, whose 0.3% bias would compound into a user-visible error (ADR-0019). */
export declare function haversineDistanceMeters(a: LatLng, b: LatLng): number;

/** Vincenty's inverse on WGS84, falling back to haversine if it fails to converge.
 *  The only source of `stats.distanceM` and `TrackSegment.distanceM`. (ADR-0019) */
export declare function geodesicDistanceMeters(a: LatLng, b: LatLng): number;
```

**Sampling contract.** Accuracy is checked **first and is absolute** — a fix worse than
`maxAccuracyM` is dropped even when the interval has elapsed, because recording a known-bad
position is worse than recording nothing. The boundary comparisons are asymmetric, and
deliberately so: a fix is dropped when `accuracyM > maxAccuracyM` (so exactly at the limit is
kept), admitted when it moved `> minDistanceM` (so exactly the minimum is not far enough), and
admitted once `maxIntervalMs` has *elapsed* (so exactly on the interval counts). A fix that
reports no `accuracyM` is not "worse than the limit" and passes — some devices never report it.
Changing any of these means changing `architecture.md §6` first; the implementation follows those
words and the tests pin them.

```ts
export interface TrackRecorder {
  readonly status: TrackStatus;
  start(opts?: Partial<SamplingPolicy>): Promise<void>;
  pause(): void;                          // closes the current segment
  resume(): void;                         // opens a new segment
  markLap(label?: string): void;          // splits the current lap at the latest point
  stop(): Promise<Track>;                 // finalizes: segments + simplify + stats
  /** Subscribe to kept points (post-sampling, with merged sensor channels). */
  onPoint(cb: (p: TrackPoint) => void): () => void;
  onError(cb: (e: TrackRecorderError) => void): () => void;
}

export type TrackRecorderErrorKind =
  | "permission-denied" | "position-unavailable" | "timeout" | "unsupported" | "sensor"
  | "storage";   // an autosave failed; the recording continues
export interface TrackRecorderError { kind: TrackRecorderErrorKind; message: string; sourceId?: string; }

export interface TrackRecorderOptions {
  store?: StorageAdapter;
  sampling?: Partial<SamplingPolicy>;
  sensors?: SensorSource[];                 // §3 — merged into each kept point
  sensorMerge?: Partial<SensorMergePolicy>;
  /** Persist the in-progress track this often so a crash/tab-kill loses at most one interval.
   *  Requires `store`. Default ~10000; 0 disables. */
  autosaveMs?: number;
  /** Continue a track a previous session left unfinished (what `recoverInterruptedTrack`
   *  returns). Its id, points, laps, channels and original `startedAt` carry over; a **new
   *  segment always opens**, because the crash interval is an unobserved gap. */
  resumeFrom?: Track;
}

/** Web (foreground) recorder: watchPosition + Screen Wake Lock. Ships in v1
 *  as `@mapatlas/recorder-web` — it touches the DOM, so it is not part of `core`.
 *
 *  The browser it talks to is injected internally for determinism and deliberately kept off
 *  this contract: a geolocation watch, a wake lock and a timer are implementation machinery,
 *  and naming them here would mean owning their shapes forever. */
export declare function createWebTrackRecorder(o?: TrackRecorderOptions): TrackRecorder;

/** Autosave interval used when a `store` is supplied and `autosaveMs` is omitted. */
export declare const DEFAULT_AUTOSAVE_MS: 10_000;

/** Two configured sensors describe one channel key differently. */
export class ChannelConflictError extends Error {
  readonly channelKey: string;
}

/** The track offered to `resumeFrom` cannot be continued. */
export class RecorderResumeError extends Error {
  readonly reason:
    | "not-interrupted"   // status is not recording/paused, or origin is not "recorded"
    | "temporal-order"    // a timestamp runs backwards, within a segment or across a pause
    | "geometry"          // segment ranges, coverage or lap ranges do not describe the points
    | "channel-conflict"; // a recovered channel is redefined by a configured sensor
}
```

**What `createWebTrackRecorder` throws.** All three are exported from `@mapatlas/recorder-web`, so
a consumer handles them by type rather than by matching a message.

`ChannelConflictError` is a *configuration* fault — the sensors as supplied disagree — and carries
the `channelKey`. It is raised whether or not a track is being resumed, which is why it is not a
`RecorderResumeError`.

`RecorderResumeError` is a *restored-state* fault and carries a `reason`. Where the underlying
check lives in `core`, the original is preserved as `cause`: a `geometry` reason carries a
`TrackSegmentRangeError`, `TrackCoverageError` or `TrackLapRangeError`, and a `temporal-order`
reason carries a `TrackTemporalOrderError` when the regression fell inside a segment. The reason is
what a consumer should branch on — a backwards timestamp is one fault whether it falls inside a
segment or across a pause, even though two different checks catch it.

An invalid `autosaveMs` is an ordinary `RangeError`: it is neither a configuration conflict nor a
restored-state fault, just a number outside its documented domain.

```ts

/** A track left in `recording`/`paused` state by a previous session, so the consumer can
 *  offer resume-or-discard. Reads **summaries**, hydrating only the one candidate, and
 *  returns the most recently started when a device crashed more than once. */
export declare function recoverInterruptedTrack(store: StorageAdapter): Promise<Track | undefined>;
/** All of them, newest first, for a consumer that wants to present a choice. */
export declare function listInterruptedTracks(store: StorageAdapter): Promise<Track[]>;

/** Native background recorders (Capacitor/Cordova) are out-of-tree adapters
 *  that also implement TrackRecorder and are injected by the consumer. */
```

**Contract:** a recorder never emits a point that fails the accuracy filter; `pause()`/`resume()`
open and close `segments` so a paused span is a real gap, never a straight line; `stop()` returns a
finalized `Track` with `segments`, `simplifiedSegments`, and `stats` populated; the web recorder requests a
Wake Lock on `start` and releases it on `stop`/`pause`. With `autosaveMs` and a `store`, an
interrupted recording is recoverable via `recoverInterruptedTrack`.

## 3. Sensor channels (`@mapatlas/core`)

The seam for non-GPS telemetry — heart rate, cadence, power, temperature, water depth. The
engine ships no device driver; it ships the interface, a polling adapter, and the merge.

```ts
export interface SensorSample { t: number; values: Record<string, number>; }

export interface SensorSourceError { kind: "unsupported" | "permission-denied" | "disconnected" | "read-failed"; message: string; }

export interface SensorSource {
  readonly id: string;                     // e.g. "ble-hr", "depth-sounder"
  readonly channels: ChannelDescriptor[];  // what this source produces
  start(): Promise<void>;
  stop(): Promise<void>;
  onSample(cb: (s: SensorSample) => void): () => void;
  onError(cb: (e: SensorSourceError) => void): () => void;
}

export interface SensorMergePolicy {
  /** A sample older than this is not merged into a point (default ~10000). */
  maxAgeMs: number;
  /** How to combine multiple samples that arrived since the previous kept point. */
  reduce: "last" | "avg" | "max" | "min";
}

/** Sample a consumer-supplied read function on a fixed interval — the neutral primitive for
 *  "take the heart rate every N seconds". The consumer's `read` owns the device (Web
 *  Bluetooth, a native bridge, HealthKit); the engine owns only the cadence and the merge. */
export declare function createPollingSensorSource(opts: {
  id: string;
  channels: ChannelDescriptor[];
  intervalMs: number;
  read(): Promise<Record<string, number> | undefined>;
}): SensorSource;

/** Reduce the samples gathered since the previous kept point into this point's channels. */
export declare function mergeSensorSamples(
  samples: readonly SensorSample[],
  pointT: number,
  policy: SensorMergePolicy,
): Record<string, number>;
export declare const DEFAULT_SENSOR_MERGE_POLICY: Readonly<SensorMergePolicy>;  // last, 10s
export declare function resolveSensorMergePolicy(p?: Partial<SensorMergePolicy>): SensorMergePolicy;
```

**Polling contract.** `intervalMs` must be positive and finite, and duplicate descriptor keys
fail construction. **At most one `read()` is ever in flight**: a tick arriving while one is still
running is *skipped, never queued* — the interval is a desired cadence, not a promise that every
invocation runs, and a backlog would accumulate stale telemetry whose timestamps no longer
resemble when it was observed. A sample is stamped **when the read resolves**, the closest moment
to the observation the engine knows; a device with authoritative sample times should implement
`SensorSource` directly instead. Values must be finite and their keys **declared** — an undeclared
key raises `read-failed` rather than being stored, because silently accepting `hearRate` for
`heartRate` produces telemetry nothing can chart. Supplying only some declared channels is fine.
A rejected read raises `read-failed` and polling continues on the next eligible tick. `start()`
and `stop()` are both idempotent; `stop()` clears future ticks at once and **disowns a read still
in flight**, so `read A starts → stop() → start() → read A resolves` cannot inject A's sample into
the new session.

**Merge contract.** Reduction is **per channel, over the samples that carry that key** — a channel
absent from a sample is absent, not zero. Samples older than `maxAgeMs` before the point are
dropped as stale, and samples *newer* than the point belong to the next one.

`createFakeSensorSource` lives on the testing entry point (§5c) beside the memory adapter: a
first-party fake for a seam is worth shipping, but it is not production API.

**Contract:** the recorder merges the reduced sample values into `TrackPoint.channels` of each
**kept** point and unions the sources' `channels` into `Track.channels`; a sensor failure raises
`onError` and never aborts the recording; `simplify()` preserves the channel values of the points
it keeps, and `computeStats` rolls each channel up per its `aggregate`. The engine assigns no
meaning to a channel key — a consumer that stores `heartRateBpm` and one that stores `depthM` use
the same code path.

## 4. Manual track authoring (`@mapatlas/core`)

A `Track` may be **drawn** rather than recorded — for reconstructing a trip after the fact.
Pure, framework-free, undoable; the renderer's draw mode (§8) is the interaction on top.

```ts
export interface TrackDraft {
  readonly points: DraftTrackPoint[];
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  /** A timestamp supplied with the point is validated exactly as `setTimeAt` validates one. */
  append(p: DraftTrackPoint): void;
  insertAt(index: number, p: DraftTrackPoint): void;
  moveAt(index: number, to: LatLng): void;
  removeAt(index: number): void;
  setTimeAt(index: number, t: number): void;
  /** Fill timestamps left unset. Anchored points (those with an explicit `t`) are preserved
   *  and the gaps between them are filled proportionally to distance travelled; with no
   *  interior anchors, `speedMps` (or `startedAt`→`endedAt`) drives a constant-rate fill.
   *
   *  **Requires both points either side of every break to be anchored.** A pause has a
   *  duration only the author knows, and the leg across it was never travelled — leaving it
   *  in the distance would let a large relocation during a lunch break absorb the whole
   *  afternoon. Rather than invent a number, this refuses and names the two points. */
  interpolateTimes(o: { startedAt: number; endedAt?: number; speedMps?: number }): void;
  /** Split the draft so `index` **begins** a new segment — the authored equivalent of a
   *  pause. The break vertex belongs to the later segment and is never duplicated:
   *  points 0..5 broken at 3 give segments 0..2 and 3..5, since overlapping ranges would
   *  fail the coverage invariant. Inserting a vertex at a boundary places it in the
   *  *earlier* segment; removing one shifts later boundaries down, and a boundary left at
   *  either end of the shortened array separates nothing and is dropped. */
  breakAt(index: number): void;
  undo(): void;
  redo(): void;
  onChange(cb: (points: DraftTrackPoint[]) => void): () => void;
  /** Finalizes exactly like `stop()`: segments + simplify + stats, `origin: "authored"`.
   *  Throws `TrackDraftIncompleteError` if any point still has no timestamp — call
   *  `interpolateTimes` first. This is the one place the draft/track boundary is enforced. */
  toTrack(meta?: { id?: Id; tags?: string[]; meta?: Record<string, JSONValue> }): Track;
}

export class TrackDraftIncompleteError extends Error {
  readonly untimedIndices: number[];
}

/** New draft, or an editable draft seeded from an existing track (recorded or authored). */
export declare function createTrackDraft(from?: Track): TrackDraft;

/** The shared finalize used by recorders, drafts, and import. */
/** Non-decreasing timestamps within a segment; time may stall but never run backwards. */
export class TrackTemporalOrderError extends Error {
  readonly previousIndex: number; readonly index: number;
  readonly previousT: number; readonly t: number;
}
/** A segment range that does not describe the point array: out of bounds, inverted, overlapping. */
export class TrackSegmentRangeError extends Error {
  readonly segmentIndex: number; readonly segmentId: string;
}
/** Assert every invariant a finalized track must satisfy. Throws on the first violation,
 *  never modifies the input. Ranges are checked before timestamps. */
export declare function assertValidTrackGeometry(
  t: Pick<Track, "points" | "segments"> & { laps?: readonly LapInput[] },
): void;

/** What a caller supplies for a lap. `index`, `startedAt`, `endedAt` and `stats` are
 *  **derived** by `finalizeTrack` — a value computable from the geometry is never stored
 *  beside it, because it would go stale on the next edit and be shared by reference with
 *  wherever it came from. (ADR-0022) */
export type LapInput = Pick<TrackLap, "id" | "startIndex" | "endIndex"> & { label?: string };

/** A lap range that does not describe a span of the point array. */
export class TrackLapRangeError extends Error {
  readonly lapIndex: number; readonly lapId: string;
}

/** Statistics over one lap's own span, with the track's segments clipped to that range so a
 *  lap crossing a pause is measured correctly. */
export declare function computeLapStats(
  t: Pick<Track, "points" | "segments" | "channels">,
  lap: Pick<TrackLap, "startIndex" | "endIndex">,
  policy?: Partial<StatsPolicy>,
): TrackStats;

/** Validates first (ADR-0020), then derives. Either returns a wholly valid finalized track
 *  or throws having computed nothing — no partial stats, no partial simplification. */
export declare function finalizeTrack(
  t: Pick<Track, "points" | "segments"> &
    Omit<Partial<Track>, "laps"> & { laps?: readonly LapInput[] },
  policy?: Partial<FinalizePolicy>,
): Track;
/** Knobs for derived statistics. A policy rather than a constant because the right value
 *  depends on where the altitude came from, and the engine cannot know. (ADR-0021) */
export interface StatsPolicy {
  /** Vertical deadband for elevation gain/loss, metres. Default 5. `0` accumulates raw movement. */
  elevationHysteresisM: number;
}
export interface FinalizePolicy extends StatsPolicy {
  /** Douglas–Peucker tolerance for `simplifiedSegments`, metres. Default 5. Rendering only. */
  simplifyToleranceM: number;
}
export declare const DEFAULT_STATS_POLICY: Readonly<StatsPolicy>;
export declare const DEFAULT_FINALIZE_POLICY: Readonly<FinalizePolicy>;
export declare function resolveStatsPolicy(p?: Partial<StatsPolicy>): StatsPolicy;
export declare function resolveFinalizePolicy(p?: Partial<FinalizePolicy>): FinalizePolicy;

/** Every quantity is computed per segment and summed, never across a pause. Elevation uses a
 *  rolling, trend-aware deadband — not pairwise thresholding, which reports zero for a long
 *  climb taken in small steps. A pair sharing a millisecond yields no instantaneous speed. */
export declare function computeStats(
  t: Pick<Track, "points" | "segments" | "channels">,
  policy?: Partial<StatsPolicy>,
): TrackStats;
/** Ramer–Douglas–Peucker over one continuous run of points.
 *
 *  Generic by design: it knows nothing about segments or pauses. `finalizeTrack` maps it
 *  across `Track.segments` to build `simplifiedSegments`, which is where pause semantics
 *  belong — keeping the primitive ignorant of them is what stops a caller from simplifying
 *  a concatenated `points[]` and smoothing through a gap.
 *
 *  Endpoints always survive, and every dropped point is guaranteed to lie within
 *  `toleranceM` of the returned polyline — that bound, not any reduction ratio, is the
 *  correctness contract. Retained points are unchanged in value, `t`/`altitudeM`/`channels`
 *  included; reference identity is an implementation detail, not a promise. The input is
 *  never mutated.
 *
 *  A tolerance of `0` means zero-error geometry, not "keep everything": a point with any
 *  deviation survives, an exactly collinear one may be dropped. Throws `RangeError` on a
 *  negative or non-finite tolerance rather than giving it accidental semantics. */
export declare function simplify(points: readonly TrackPoint[], toleranceM: number): TrackPoint[];
```

**Contract — transactional.** Every public edit is **one** undo step, `interpolateTimes` included
even though it rewrites many timestamps. A rejected mutation throws having changed nothing: no
state change, no undo entry, no cleared redo, no `onChange`. Validation happens before the
snapshot, so the draft is never left half-edited. History is bounded internally; the limit is
deliberately not configurable, since it is implementation policy and the snapshots can become
structural sharing later without any public change.

**Contract — events.** One `onChange` per successful mutation, undo, or redo; none for an
unavailable undo or redo. Listeners and `points` receive defensive copies, nested `channels`
included.

**Contract — `toTrack()`.** A projection, not an edit: it adds no undo entry, clears no redo,
fires no listener, and leaves the draft untouched — calling it twice yields equivalent tracks. It
produces a `Track` indistinguishable in shape from a recorded one except for `origin`, and the
returned points are **deep copies**: mutating the finalized track cannot reach back into the draft.

A draft seeded from a track carries that track's `id`, `tags`, `meta`, `channels` descriptors and
`laps`, so an unedited round trip through `createTrackDraft(track).toTrack()` preserves them; an
argument to `toTrack()` overrides what was seeded. Laps are shifted by insertions and removals and
dropped once they no longer describe a span. **Segment ids are minted fresh** — a draft's segments
are defined by its breaks, and an edit can merge or split them, so carrying the old ids would
attach stale identity to spans that no longer correspond to anything. Editing a seeded draft never
mutates the source track. A draft may hold untimed points for as long as it likes; a `Track` may
never — this is where that stops being allowed.

## 5. Persistence seam (`@mapatlas/core`; default impl in `@mapatlas/storage-idb`)

```ts
export interface StorageAdapter {
  saveTrack(t: Track): Promise<void>;
  getTrack(id: Id): Promise<Track | undefined>;
  /** List projection — must NOT hydrate `points`. */
  /** Ordered by `startedAt` ascending, ties broken by id. Required, not optional. */
  listTrackSummaries(): Promise<TrackSummary[]>;
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

**Contract:** all methods are async and side-effect-local by default; `listTrackSummaries()`
returns a summary per stored track without loading its points, ordered by **`startedAt` ascending
with ties broken by id** — required rather than optional, because an unspecified order pushes the
sort into every consumer and the obvious wrong answer (id order) looks right until an imported
trip appears, ids being mint order; `deleteTrack` also deletes that
track's events and any blob referenced only by them; `clearAll()` must remove every track, event,
and blob (consumers rely on this for a clean device wipe).

## 5b. Event log (`@mapatlas/core`)

```ts
export interface EventLog {
  add(input: Omit<MapEvent, "id">): Promise<MapEvent>;
  update(event: MapEvent): Promise<void>;   // throws EventNotFoundError if absent
  get(id: Id): Promise<MapEvent | undefined>;
  list(trackId?: Id): Promise<MapEvent[]>;  // by occurredAt, ties broken by id
  remove(id: Id): Promise<void>;
}
export class EventNotFoundError extends Error { readonly eventId: Id; }
export declare function createEventLog(store: StorageAdapter): EventLog;
```

**Contract:** `add` assigns the id. `update` reads before writing and throws rather than
inserting — a save-through-update turns "I edited the wrong id" into a duplicate. `list` imposes
a total order (`occurredAt`, then id) because adapters are not required to return one and an
unstable order flickers between renders. `remove` is idempotent.

## 5c. First-party test utilities (`@mapatlas/core/testing`)

```ts
export declare function createMemoryStorageAdapter(): MemoryStorageAdapter;
export declare function createMemoryMapAssetStore(): MapAssetStore;
export declare function createFakeSensorSource(opts: {
  id: string; channels: ChannelDescriptor[]; samples?: SensorSample[];
}): FakeSensorSource;   // adds emit() and fail(), so a test can drive timing and failure

/** The executable StorageAdapter contract — framework-neutral by construction. */
export interface StorageContractCase { name: string; run(): Promise<void>; }
export declare function storageAdapterContract(
  createAdapter: () => StorageAdapter | Promise<StorageAdapter>,
): readonly StorageContractCase[];
```

**The conformance contract.** `StorageAdapter` is deliberately third-party implementable, so the
engine publishes the cases it holds its own adapters to. Each case is a name and an async function
that throws an ordinary `Error` on failure — nothing here imports a test runner, and adopting the
contract does not drag a project onto ours:

```ts
for (const { name, run } of storageAdapterContract(() => createMyAdapter())) {
  it(name, run);   // or test(), or node:test, or a for-loop
}
```

Every case takes a **fresh adapter** from the factory, so cases cannot leak state into one another
and may run in any order or alone. The factory must return a fresh, **empty backing store** — not
merely a new adapter object over the same one; a wrapper around shared storage leaks state between
cases and produces failures that look like contract violations. Equality is compared
structurally, with object keys unordered and array elements ordered, so an adapter that rebuilds
an equal object with its keys elsewhere is not failed for it. The cases cover round-tripping, the copy semantics real
persistence has and a naive in-memory store does not, the summary projection's observable shape,
chronological ordering from `startedAt` rather than id, cascade deletion including blob orphaning,
idempotent deletes, and `clearAll`.

A **separate entry point**, deliberately not re-exported from the main barrel: useful enough to
ship, but not part of the production-facing API and with no business in a consumer's bundle.

`StorageAdapter` is a seam, so shipping the same reference implementation the engine validates
itself against means a consumer can unit-test without IndexedDB, an adapter author gets a
canonical executable example, and nobody invents a subtly different storage mock.

**Contract:** it models the *interface's semantics*, not IndexedDB's architecture — summaries are
derived in memory, and the projection's observable shape (no point array) is what matters here,
while `@mapatlas/storage-idb` is where avoiding the point-blob read is proven. It copies values in
and out, so mutating a returned track does not reach into the store: without that, code passes
against memory and fails against real persistence, which serialises. It obeys the same purity
boundary as the rest of `core` — no React, no MapLibre, no IndexedDB, no DOM runtime.

## 6. AI analyzer seam (`@mapatlas/core`)

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

## 7. Basemap, terrain & offline tiles

A `TileSource` is any layer the renderer composites: raster, vector, or an elevation raster
driving hillshade and 3D terrain. `kind` and `transport` are **independent axes** — `kind` says
what the tiles contain, `transport` says how to fetch them — so PMTiles-of-vector and
PMTiles-of-raster are both expressible and neither has to be inferred (ADR-0023). `styleLayers`
is an opaque JSON passthrough so `core` can describe a vector layer without depending on a
renderer's style types.

```ts
/** What the tiles contain. */
export type TileSourceKind = "raster" | "vector" | "raster-dem";
/** How to fetch them. */
export type TileSourceTransport = "template" | "wms" | "tilejson" | "pmtiles";
export type TileSourceRole = "base" | "overlay" | "terrain" | "hillshade";

export interface TileSource {
  id: string;
  kind: TileSourceKind;
  transport: TileSourceTransport;
  url: string;                 // tile template, WMS request, TileJSON url, or pmtiles:// archive
  attribution: string;         // rendered verbatim (license compliance)
  role?: TileSourceRole;       // default "overlay" (the first source defaults to "base")
  opacity?: number;
  minZoom?: number; maxZoom?: number;
  tileSize?: number;
  encoding?: "mapbox" | "terrarium";   // raster-dem only
  /** For "vector"/"raster-dem": renderer style layers applied to this source, verbatim.
   *  Opaque to `core`; this is how contours, hillshade, and bathymetry styling are expressed. */
  styleLayers?: JSONValue[];
}

export interface TerrainOptions {
  sourceId: string;            // a TileSource with kind "raster-dem"
  exaggeration?: number;       // default 1
}

export interface OfflineRegion {
  id: Id; name: string;
  bbox: [west: number, south: number, east: number, north: number];
  minZoom: number; maxZoom: number;
  sourceIds?: string[];        // which TileSources this region covers (default: all base+overlay)
  sizeBytes?: number; downloadedAt?: number;
}

export interface OfflineRegionStore {
  download(region: Omit<OfflineRegion, "id" | "sizeBytes" | "downloadedAt">,
           onProgress?: (fraction: number) => void): Promise<OfflineRegion>;
  list(): Promise<OfflineRegion[]>;
  delete(id: Id): Promise<void>;
  estimateSize(region: Pick<OfflineRegion, "bbox" | "minZoom" | "maxZoom" | "sourceIds">): Promise<number>;
}

/** Persistence for downloaded **map assets** — deliberately NOT the trip `StorageAdapter`.
 *  Map bytes are large, replaceable, and evictable; tracks and photos are irreplaceable.
 *  Neither may be destroyed by the other's wipe. This is lifecycle isolation and a bounded
 *  blast radius, **not** quota isolation — browsers evict per origin (ADR-0016). */
export interface MapAssetStore {
  put(key: string, data: Blob): Promise<void>;
  get(key: string): Promise<Blob | undefined>;
  delete(key: string): Promise<void>;
  list(): Promise<string[]>;
  estimateBytes(): Promise<number>;
  /** Wipes downloaded map assets only. `StorageAdapter.clearAll()` must not touch them. */
  clear(): Promise<void>;
}

/** Default implementation, shipped as `@mapatlas/offline-pmtiles`. */
export declare function createPMTilesRegionStore(o: { sources: TileSource[]; assets: MapAssetStore }): OfflineRegionStore;
```

**Contract (`TileSource`):** `kind` describes content, `transport` describes how the source is
obtained, and `url` is the transport's underlying location or template. A renderer combines the
three and **guesses nothing**. `template` and `wms` name individual tiles (`tiles: [url]`);
`tilejson` and `pmtiles` name a document or archive describing the whole set (`url`).

A renderer adapter may translate a transport into a renderer-specific mechanism — for MapLibre,
PMTiles becomes the `pmtiles://` protocol it registers, so `@mapatlas/maplibre` prefixes the
archive location itself. That scheme never appears in a `TileSource`: Leaflet's PMTiles
integration constructs `PMTiles(url)` from the plain location and OpenLayers has its own source
abstraction, so a url carrying it would be unreadable to every renderer but one. Write
`url: "https://cdn.example/map.pmtiles"` with `transport: "pmtiles"`.

Rejected as unrenderable rather than rendered wrong: `wms` with a non-`raster` kind (GetMap
returns an image), a `wms` url with no bbox placeholder, and a url already carrying `pmtiles://`
under any transport.

Style layer ids are namespaced `<sourceId>__<layerId>`, so two sources each carrying a layer
called `labels` yield `a__labels` and `b__labels` instead of one silently replacing the other.

**Contract (`OfflineRegionStore`):** `download()` **copies bytes into the `MapAssetStore`** and
resolves the region from local storage thereafter. A `.pmtiles` URL served by range requests is *remote* PMTiles, not an
offline region — a region that still needs the network to draw has not been downloaded. The
implementation must also honor the tile source's terms: see the licensing rule in
`architecture.md §8`, which forbids region download against community tile services.

## 8. Renderer (`@mapatlas/maplibre`)

```ts
/** How an event, a track, and its endpoints are drawn. This is the presentation seam: the
 *  engine knows nothing about categories, so the consumer maps them to marks. */
export interface MarkerStyle {
  html?: string;               // marker content, inserted verbatim — see the contract below
  className?: string;
  iconUrl?: string;            // consumer-supplied asset; the engine bundles none
  color?: string;
  sizePx?: [w: number, h: number];
  anchor?: "center" | "bottom";
  ariaLabel: string;           // required: the accessible name for this mark
}

export interface TrackLineStyle { color?: string; widthPx?: number; dashed?: boolean; opacity?: number; }

export interface EventPresentation {
  /** Called per event; keyed off `category`/`tags`/`fields` by the consumer. */
  marker(e: MapEvent): MarkerStyle;
  startMarker?(t: Track): MarkerStyle | null;    // default: a neutral built-in start mark
  finishMarker?(t: Track): MarkerStyle | null;   // default: a neutral built-in finish mark
  lapMarker?(l: TrackLap, t: Track): MarkerStyle | null;
  /** Called per segment, so pauses/laps can be styled differently. */
  trackLine?(t: Track, segmentIndex: number): TrackLineStyle;
}

export interface DrawModeHandlers {
  onVertexAdd(at: LatLng): void;
  onVertexMove(index: number, to: LatLng): void;
  onVertexClick?(index: number): void;
}

export interface MapControllerOptions {
  container: HTMLElement;
  sources: TileSource[];          // ordered base → overlays
  style?: string | JSONValue;     // base MapLibre style (URL or document); sources composite on top
  terrain?: TerrainOptions | null;
  presentation?: EventPresentation;
  center?: LatLng; zoom?: number;
  attributionPrefix?: string;     // engine-owned, neutral; never a library default (ADR-0008)
}

export interface MapController {
  setSources(sources: TileSource[]): void;
  setTerrain(t: TerrainOptions | null): void;
  setPresentation(p: EventPresentation): void;
  /** Draws one polyline per `track.segments` — never a line across a pause — plus the
   *  start/finish/lap marks from the presentation. */
  renderTrack(track: Track | null): void;
  renderEvents(events: MapEvent[]): void;
  /** The in-progress authored line (§4), drawn with draggable vertices while in draw mode. */
  renderDraft(points: DraftTrackPoint[] | null): void;
  showLivePosition(p: TrackPoint | null): void;
  fitTrack(track: Track): void;
  fitBounds(bbox: [number, number, number, number], paddingPx?: number): void;
  recenter(to: LatLng, zoom?: number): void;
  onMapTap(cb: (at: LatLng) => void): () => void;
  onEventClick(cb: (id: Id) => void): () => void;
  /** Enter vertex-editing interaction; the returned fn exits it. */
  enterDrawMode(h: DrawModeHandlers): () => void;
  destroy(): void;
}
export declare function createMapController(o: MapControllerOptions): MapController;
```

**Contract:** `MarkerStyle.html` is inserted into the DOM verbatim — it is **consumer-authored
markup and must never be built from untrusted input** (see `SECURITY.md`). Every mark carries an
`ariaLabel`; the engine supplies none, because only the consumer knows what a mark means. With no
`presentation`, the renderer draws neutral built-in marks and no consumer branding.

## 9. React bindings (`@mapatlas/react`)

```ts
export function useTrackRecorder(opts?: {
  recorder?: TrackRecorder; store?: StorageAdapter; sampling?: Partial<SamplingPolicy>;
  sensors?: SensorSource[];
}): {
  status: TrackStatus; livePoint?: TrackPoint; track?: Track;
  channels: Record<string, number>;      // latest merged sensor values, for a live readout
  start(): Promise<void>; pause(): void; resume(): void; markLap(label?: string): void;
  stop(): Promise<Track>;
  recovered?: Track;                     // an interrupted track found at mount
  error?: TrackRecorderError;
};

export function useTrackList(store: StorageAdapter): {
  tracks: TrackSummary[]; loading: boolean;
  refresh(): Promise<void>; remove(id: Id): Promise<void>;
};

export function useTrackDraft(opts?: { from?: Track; store?: StorageAdapter }): {
  points: DraftTrackPoint[]; canUndo: boolean; canRedo: boolean;
  /** Indices still lacking a timestamp — `save()` rejects while this is non-empty. */
  untimedIndices: number[];
  append(p: LatLng): void; insertAt(i: number, p: LatLng): void;
  moveAt(i: number, to: LatLng): void; removeAt(i: number): void;
  setTimeAt(i: number, t: number): void;
  interpolateTimes(o: { startedAt: number; endedAt?: number; speedMps?: number }): void;
  breakAt(i: number): void;
  undo(): void; redo(): void;
  save(): Promise<Track>;
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

/** A consumer-defined input rendered by <EventComposer> into `MapEvent.fields`.
 *  The engine renders the label and stores the value; it assigns no meaning. */
export interface FieldSpec {
  key: string; label: string;
  type: "text" | "number" | "boolean" | "select" | "date";
  options?: { value: string; label: string }[];
  unit?: string; required?: boolean; placeholder?: string;
}

// Components
export function MapCanvas(props: {
  sources: TileSource[]; style?: string | JSONValue; terrain?: TerrainOptions | null;
  presentation?: EventPresentation;
  track?: Track; events?: MapEvent[]; livePoint?: TrackPoint;
  draft?: DraftTrackPoint[]; drawMode?: boolean; onDraw?: DrawModeHandlers;
  onMapTap?(at: LatLng): void; onEventClick?(id: Id): void;
}): JSX.Element;

export function EventComposer(props: {
  at: LatLng;
  store: StorageAdapter;                 // captured photos are written here as blobs
  analyzer?: MediaAnalyzer;
  /** Which affordance opens first — the comment field or the camera. Drives the
   *  "one tap → note" vs "one tap → photo" consumer choice. */
  mode?: "comment" | "photo";
  fields?: FieldSpec[];                  // consumer-defined inputs → MapEvent.fields
  categories?: { value: string; label: string }[];
  occurredAt?: number;                   // defaults to now; settable when re-creating a trip
  onSave(input: Omit<MapEvent, "id" | "position">): void; onCancel(): void;
}): JSX.Element;

export function TripReview(props: {
  track: Track; events: MapEvent[];
  sources: TileSource[]; style?: string | JSONValue; terrain?: TerrainOptions | null;
  presentation?: EventPresentation;
  /** Channel keys to chart under the map (e.g. ["heartRateBpm"]); defaults to all. */
  channels?: string[];
  onEventClick?(id: Id): void;
}): JSX.Element;
```

## 10. Portability (`@mapatlas/core`)

```ts
export interface MediaManifestEntry {
  id: Id; mime: string;
  blobKey?: string; url?: string;
  width?: number; height?: number; bytes?: number;
}

export interface TrackExport {
  geojson: GeoJSON.FeatureCollection;   // MultiLineString (one per segment) + Point features
  media: MediaManifestEntry[];          // media travels by reference, never inlined
}

export class TrackImportError extends Error {}

export function trackToGeoJSON(track: Track, events: readonly MapEvent[]): TrackExport;
export function geoJSONToTrack(e: TrackExport): { track: Track; events: MapEvent[] };
```

The track feature's per-point data travels as arrays **parallel to the coordinates, one per
segment**: `coordTimes`, and optionally `accuracyM`, `altitudeAccuracyM`, `speedMps`, `headingDeg`
and `channels` (a record of key to parallel array). A point missing a value contributes `null`, so
index *i* always names the same point — compaction would make the arrays unreadable without the
very data they encode. Altitude rides in the coordinate itself as `[lng, lat, altitude]`. A
property is omitted entirely when no point carries the field.

**Determinism.** The same track and events produce byte-identical output regardless of the order
they were handed over: channel keys are emitted sorted, the manifest is sorted by id, and events
are ordered by `occurredAt` then id — the total order `EventLog.list` imposes. Order that *is*
data — segments, laps, coordinates, tags, and an event's own media array — is preserved as given.

**Import fails closed.** A parallel array whose shape disagrees with the geometry, a missing
timestamp, segment properties that do not match the members, more than one track feature, or a
track violating the temporal or coverage invariants all raise rather than being truncated or
repaired. Both directions copy defensively, so neither a document nor a track can reach into the
other.

**Contract:** the track feature is a `MultiLineString` whose members are `track.segments`
**at raw fidelity — never `simplifiedSegments`**. Equality after a round trip is defined over the
**canonical state** — `points + segments + laps + channels + stats + origin + tags + meta` and the
events — not over every property, precisely because the derived cache is omitted by design and
regenerated on the far side. Export is a portability format, and T1.7
requires a lossless round-trip; shipping decimated geometry would quietly fail that. Simplified
geometry is a rendering projection and is recomputed on import, not carried. Each member carries
per-coordinate timestamps in `properties.coordTimes` and per-coordinate telemetry in
`properties.channels` (`Record<string, (number | null)[]>`, aligned to the coordinates) plus
`properties.channelDescriptors`, `properties.laps`, `properties.stats`, and `properties.origin`.

**Lap ranges are validated, not trusted.** `0 <= startIndex <= endIndex < points.length`, both
integers, checked before anything is derived — array slicing is forgiving in all the wrong ways,
so an out-of-bounds range would yield a short slice, an inverted one nothing, and a fractional
index a plausible-looking distance over the wrong points. Laps *may* overlap and need not cover
the points: unlike segments they are markers over the geometry, not a partition of it.
Export/import round-trips without losing geometry, segmentation, timestamps, altitude, channels,
laps, stats, comments, tags, `fields`, or `analysis`.
