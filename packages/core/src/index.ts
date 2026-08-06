// SPDX-License-Identifier: Apache-2.0

/**
 * MAP-ATLAS core — framework-agnostic data model, seams, and track logic.
 *
 * The engine depends on nothing consumer-, renderer-, or domain-specific:
 * everything variable lives behind an interface (see ./seams). Consumers depend
 * on these types; this package depends only on the language and standard
 * platform types.
 */

// Data model (api.md §1)
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
} from "./types";

// Ids & geo utilities
export { newId, ID_LENGTH } from "./id";
export { EARTH_RADIUS_M, haversineMeters, pathLengthMeters } from "./geo";

// Sampling (api.md §2)
export type { SamplingPolicy, SampleReason, SampleDecision } from "./sampling";
export { DEFAULT_SAMPLING_POLICY, sample } from "./sampling";

// Track geometry
export { simplify } from "./simplify";
export type { FinalizedTrack } from "./track";
export { DEFAULT_SIMPLIFY_TOLERANCE_M, finalizeTrack } from "./track";

// Event log
export { EventLog } from "./event-log";

// In-memory persistence (a StorageAdapter fake / SSR fallback; api.md §3)
export { createMemoryStorageAdapter } from "./memory-storage";

// Seams (api.md §3–5)
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
} from "./seams";
export { noopAnalyzer } from "./seams";

// Portability (api.md §8)
export { trackToGeoJSON, geoJSONToTrack } from "./geojson";
