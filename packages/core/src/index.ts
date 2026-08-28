// SPDX-License-Identifier: Apache-2.0

/**
 * `@mapatlas/core` — the framework-agnostic engine.
 *
 * This package depends on nothing: no renderer, no React, no DOM, no consumer domain.
 * Everything variable is an interface here and implemented elsewhere. See
 * specs/architecture.md §1 for the rule and scripts/scan-isolation.mjs for its enforcement.
 */

export type { JSONValue } from "./json.js";
export type { BBox, LatLng } from "./geo.js";
export { geodesicDistanceMeters, haversineDistanceMeters } from "./geo.js";
export type { ChannelAggregate, ChannelDescriptor, ChannelStats } from "./channels.js";
export type { Id, IdFactoryOptions } from "./ids.js";
export { ID_LENGTH, createIdFactory, newId } from "./ids.js";
export type {
  DraftTrackPoint,
  Track,
  TrackLap,
  TrackOrigin,
  TrackPoint,
  TrackSegment,
  TrackStats,
  TrackStatus,
  TrackSummary,
} from "./track.js";
export type { MapEvent, MediaAnalysis, MediaRef } from "./event.js";
export type { MapAssetStore, StorageAdapter } from "./storage.js";
export type {
  EventFeature,
  EventFeatureProperties,
  MediaManifestEntry,
  SegmentProperties,
  TrackExport,
  TrackFeature,
  TrackFeatureProperties,
} from "./portability.js";
export { TrackImportError, geoJSONToTrack, trackToGeoJSON } from "./portability.js";
export type { FeatureCollection, MultiLineString, Point, Position } from "./geojson.js";
export { compareTrackSummaries, summariseTrack } from "./summary.js";
export { listInterruptedTracks, recoverInterruptedTrack } from "./recovery.js";
export type { InterpolateTimesOptions, TrackDraft } from "./draft.js";
export { TrackDraftIncompleteError, createTrackDraft } from "./draft.js";
export type { EventLog } from "./event-log.js";
export { EventNotFoundError, createEventLog } from "./event-log.js";
export type { AnalyzeInput, MediaAnalyzer } from "./analyzer.js";
export { noopAnalyzer } from "./analyzer.js";
export type {
  OfflineRegion,
  OfflineRegionStore,
  TerrainOptions,
  TileSource,
  TileSourceKind,
  TileSourceRole,
  TileSourceTransport,
} from "./tiles.js";
export type {
  SensorMergePolicy,
  SensorSample,
  SensorSource,
  SensorSourceError,
} from "./sensors.js";
export type { PollingSensorSourceOptions } from "./sensors-polling.js";
export { createPollingSensorSource } from "./sensors-polling.js";
export {
  DEFAULT_SENSOR_MAX_AGE_MS,
  DEFAULT_SENSOR_MERGE_POLICY,
  DEFAULT_SENSOR_REDUCE,
  mergeSensorSamples,
  resolveSensorMergePolicy,
} from "./sensors-merge.js";
export type {
  TrackRecorder,
  TrackRecorderError,
  TrackRecorderErrorKind,
  TrackRecorderOptions,
} from "./recorder.js";
export { simplify } from "./simplify.js";
export type { StatsPolicy } from "./stats.js";
export {
  DEFAULT_ELEVATION_HYSTERESIS_M,
  DEFAULT_STATS_POLICY,
  computeLapStats,
  computeStats,
  resolveStatsPolicy,
} from "./stats.js";
export type { FinalizePolicy, LapInput } from "./finalize.js";
export {
  DEFAULT_FINALIZE_POLICY,
  DEFAULT_SIMPLIFY_TOLERANCE_M,
  finalizeTrack,
  resolveFinalizePolicy,
} from "./finalize.js";
export {
  TrackCoverageError,
  TrackLapRangeError,
  TrackSegmentRangeError,
  TrackTemporalOrderError,
  assertValidTrackGeometry,
} from "./validate.js";
export type { SampleDecision, SampleReason, SamplingPolicy } from "./sampling.js";
export {
  DEFAULT_MAX_ACCURACY_M,
  DEFAULT_MAX_INTERVAL_MS,
  DEFAULT_MIN_DISTANCE_M,
  DEFAULT_SAMPLING_POLICY,
  resolveSamplingPolicy,
  sample,
} from "./sampling.js";

/** Package identity, so a consumer can report which engine build it embeds. */
export const PACKAGE_NAME = "@mapatlas/core";
