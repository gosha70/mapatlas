// SPDX-License-Identifier: Apache-2.0

import type { ChannelDescriptor, ChannelStats } from "./channels.js";
import type { BBox, LatLng } from "./geo.js";
import type { Id } from "./ids.js";
import type { JSONValue } from "./json.js";

/**
 * A point being authored by hand. Its timestamp may not exist yet: vertices are placed
 * first and timed later.
 *
 * This is deliberately a different type from {@link TrackPoint}, whose `t` is required.
 * A recorded fix always has a clock reading, and widening the finalized type to admit an
 * intermediate editing state would push that uncertainty into every consumer that ever
 * reads a track. `TrackDraft.toTrack()` is the boundary where the invariant is enforced.
 * (ADR-0018)
 */
export interface DraftTrackPoint extends LatLng {
  t?: number;
  accuracyM?: number;
  altitudeM?: number;
  altitudeAccuracyM?: number;
  speedMps?: number;
  headingDeg?: number;
  channels?: Record<string, number>;
}

/** A kept fix: a position, a time, and whatever the device and sensors reported with it. */
export interface TrackPoint extends LatLng {
  /** Epoch milliseconds. Always present — see {@link DraftTrackPoint}. */
  t: number;
  accuracyM?: number;
  /** WGS84 ellipsoidal metres, when the fix provides it. */
  altitudeM?: number;
  altitudeAccuracyM?: number;
  speedMps?: number;
  headingDeg?: number;
  /** Sensor values merged at this point. Keys are described by {@link Track.channels}. */
  channels?: Record<string, number>;
}

export type TrackStatus = "recording" | "paused" | "finalized";

export type TrackOrigin = "recorded" | "authored" | "imported";

/**
 * A contiguous span of *active* recording, addressed as a range into {@link Track.points}
 * rather than a copy of them. The gap between consecutive segments is a pause: renderers
 * draw one polyline per segment and never bridge it. (ADR-0010)
 */
export interface TrackSegment {
  id: Id;
  /** Inclusive index into `Track.points`. */
  startIndex: number;
  /** Inclusive index into `Track.points`. */
  endIndex: number;
  startedAt: number;
  endedAt?: number;
  distanceM?: number;
}

/**
 * A user- or consumer-marked split ("Lap 3", "Drift 2"). Laps subdivide active recording
 * and may span segments. `label` is consumer text; the engine never generates domain names.
 */
export interface TrackLap {
  id: Id;
  /** 0-based order. */
  index: number;
  startIndex: number;
  endIndex: number;
  startedAt: number;
  endedAt?: number;
  label?: string;
  stats?: TrackStats;
}

/** Derived, never authored. Produced by `computeStats`; recorders, drafts and import share it. */
export interface TrackStats {
  distanceM: number;
  /** endedAt - startedAt, including pauses. */
  durationMs: number;
  /** Sum of segment durations, excluding pauses. */
  movingTimeMs: number;
  avgSpeedMps?: number;
  maxSpeedMps?: number;
  /** Sum of positive altitude deltas, hysteresis-filtered so GPS noise does not inflate it. */
  elevationGainM?: number;
  elevationLossM?: number;
  minAltitudeM?: number;
  maxAltitudeM?: number;
  /** One entry per {@link ChannelDescriptor} that has data. */
  channels?: Record<string, ChannelStats>;
}

export interface Track {
  id: Id;
  startedAt: number;
  endedAt?: number;
  status: TrackStatus;
  /** "authored" ⇒ drawn by hand, not recorded from GPS. */
  origin: TrackOrigin;
  /** Raw kept points — the single source of truth, and what gets exported. */
  points: TrackPoint[];
  /** Active spans; a recording with no pause has exactly one. */
  segments: TrackSegment[];
  /**
   * Douglas–Peucker output for rendering: one member per `segments[n]`, same order.
   * Simplification is per segment because a raw index means nothing inside a decimated
   * array, and simplifying the concatenated points would smooth a pause into continuous
   * geometry.
   *
   * **A disposable cache.** Deleting this field must never change what the track means:
   * `finalizeTrack` regenerates it deterministically from `points` + `segments`. That is
   * what makes a storage migration or a change of simplification algorithm safe — drop
   * the cache and rebuild. Never exported. (ADR-0018)
   */
  simplifiedSegments?: TrackPoint[][];
  laps?: TrackLap[];
  /** Descriptors for the keys present in `points[].channels`. */
  channels?: ChannelDescriptor[];
  /** Derived on finalize. */
  stats?: TrackStats;
  tags?: string[];
  meta?: Record<string, JSONValue>;
}

/**
 * The list projection. `listTrackSummaries()` must not hydrate point arrays — a consumer
 * showing hundreds of trips pays only for what it displays. (ADR-0014)
 */
export interface TrackSummary {
  id: Id;
  startedAt: number;
  endedAt?: number;
  status: TrackStatus;
  origin: TrackOrigin;
  stats?: TrackStats;
  pointCount: number;
  eventCount?: number;
  bbox?: BBox;
  start?: LatLng;
  finish?: LatLng;
  channelKeys?: string[];
  tags?: string[];
  meta?: Record<string, JSONValue>;
}
