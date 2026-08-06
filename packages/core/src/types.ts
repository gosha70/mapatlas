// SPDX-License-Identifier: Apache-2.0

/**
 * Core data model (see specs/api.md §1). Pure type declarations — no runtime,
 * no DOM, no consumer or renderer concepts.
 */

/** Opaque identifier (ULID/UUID). */
export type Id = string;

/** Any value expressible as JSON. */
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
  /** raw kept points */
  points: TrackPoint[];
  /** Douglas–Peucker output for render/export */
  simplified?: TrackPoint[];
  /** derived on finalize (metres) */
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
