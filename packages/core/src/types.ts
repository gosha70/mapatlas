// SPDX-License-Identifier: Apache-2.0

/**
 * Core data types (api.md §1).
 *
 * These are the domain-agnostic primitives every consumer builds on. No
 * consumer-specific concept may enter this file — such data rides in the
 * neutral bags `tags`, `category`, and `fields`.
 */

/** Opaque identifier (ULID/UUID). */
export type Id = string;

/** A JSON-serializable value — the type of everything in `fields`/`meta`. */
export type JSONValue =
  null | boolean | number | string | JSONValue[] | { [k: string]: JSONValue };

export interface LatLng {
  lat: number;
  lng: number;
}

export interface TrackPoint extends LatLng {
  /** epoch ms */
  t: number;
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
  /** raw kept points (post-sampling) */
  points: TrackPoint[];
  /** Douglas–Peucker output for render/export */
  simplified?: TrackPoint[];
  /** derived on finalize (haversine, meters) */
  distanceM?: number;
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
  /** key into StorageAdapter blob store */
  blobKey?: string;
  /** alternative to blobKey (already-hosted media) */
  url?: string;
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
  /** consumer-defined domain data */
  fields?: Record<string, JSONValue>;
}
