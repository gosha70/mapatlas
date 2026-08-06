// SPDX-License-Identifier: Apache-2.0

/**
 * @mapatlas/core — framework-agnostic engine.
 *
 * The domain-agnostic data model, seams (interfaces), and geometry. Imports
 * nothing from the DOM, Leaflet, or React (isolation scan enforced).
 */

export const VERSION = "0.1.0";

// §1 Core data types
export type {
  Id,
  JSONValue,
  LatLng,
  TrackPoint,
  TrackStatus,
  Track,
  MediaAnalysis,
  MediaRef,
  MapEvent,
} from "./types.js";

// id + small utilities
export { newId, clamp, toRadians } from "./id.js";

// geometry helpers
export {
  EARTH_RADIUS_M,
  haversineM,
  polylineLengthM,
  projectMeters,
} from "./geo.js";

// §2 sampling
export type {
  SamplingPolicy,
  SampleReason,
  SampleDecision,
} from "./sampling.js";
export { DEFAULT_SAMPLING_POLICY, sample } from "./sampling.js";

// simplify + finalize
export { simplify } from "./simplify.js";
export type { FinalizedTrack } from "./track.js";
export { finalizeTrack, DEFAULT_SIMPLIFY_TOLERANCE_M } from "./track.js";

// §2–§5 seams
export type {
  StorageAdapter,
  AnalyzeInput,
  MediaAnalyzer,
  TileSource,
  OfflineRegion,
  OfflineRegionStore,
  TrackRecorder,
  TrackRecorderError,
  TrackRecorderErrorKind,
} from "./interfaces.js";
export { noopAnalyzer } from "./analyzer.js";

// web (foreground) recorder
export { createWebTrackRecorder } from "./web-recorder.js";

// event log
export { EventLog } from "./event-log.js";

// reference in-memory StorageAdapter (tests, demos, conformance)
export { InMemoryStorageAdapter } from "./fake-storage.js";

// §8 portability
export { trackToGeoJSON, geoJSONToTrack } from "./geojson.js";
