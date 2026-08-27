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
export { haversineDistanceMeters } from "./geo.js";
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
