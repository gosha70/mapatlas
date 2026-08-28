// SPDX-License-Identifier: Apache-2.0

import type { Id, Track, TrackPoint } from "@mapatlas/core";

/**
 * `Track` → GeoJSON for rendering.
 *
 * Pure, like the source builder: it reads a track and returns features. Two rules from the
 * spec shape it, and both exist because the obvious implementation is wrong.
 */

/** Minimal GeoJSON, declared rather than depended on — same reasoning as `core`'s. */
export type Position2D = [lng: number, lat: number];

export interface LineStringFeature {
  type: "Feature";
  geometry: { type: "LineString"; coordinates: Position2D[] };
  properties: { kind: "track-segment"; trackId: Id; segmentId: Id; segmentIndex: number };
}

export interface PointFeature {
  type: "Feature";
  geometry: { type: "Point"; coordinates: Position2D };
  properties: { kind: "track-start" | "track-finish" | "track-lap"; trackId: Id; label?: string };
}

export interface FeatureCollection<F> {
  type: "FeatureCollection";
  features: F[];
}

const position = (point: TrackPoint): Position2D => [point.lng, point.lat];

/**
 * The points to draw for one segment.
 *
 * `simplifiedSegments[n]` when it is there, raw points otherwise. The cache is disposable
 * by design (ADR-0018) — a track that arrives without it, from import or from a storage
 * migration that dropped it, must still draw rather than render nothing.
 */
export function segmentGeometry(track: Track, segmentIndex: number): TrackPoint[] {
  const simplified = track.simplifiedSegments?.[segmentIndex];
  if (simplified !== undefined) return simplified;

  const segment = track.segments[segmentIndex];
  if (segment === undefined) return [];
  return track.points.slice(segment.startIndex, segment.endIndex + 1);
}

/**
 * One `LineString` per segment, and never one across a pause.
 *
 * A segment holding a single point produces **no feature at all**: a `LineString` needs at
 * least two positions, and emitting a one-position or empty one is invalid GeoJSON that
 * MapLibre will either reject or draw as nothing. The point is still a place the user was,
 * so it keeps its endpoint marker — see {@link buildTrackEndpointFeatures}.
 */
export function buildTrackLineFeatures(track: Track): FeatureCollection<LineStringFeature> {
  const features: LineStringFeature[] = [];

  for (const [segmentIndex, segment] of track.segments.entries()) {
    const points = segmentGeometry(track, segmentIndex);
    if (points.length < 2) continue;

    features.push({
      type: "Feature",
      geometry: { type: "LineString", coordinates: points.map(position) },
      properties: {
        kind: "track-segment",
        trackId: track.id,
        segmentId: segment.id,
        segmentIndex,
      },
    });
  }

  return { type: "FeatureCollection", features };
}

/**
 * Where the trip began and ended.
 *
 * Taken from the **raw** points, not the simplified cache: simplification preserves
 * endpoints, but relying on that would make the marks depend on a cache that is allowed to
 * be absent. A single-point track has one place, which is both start and finish; it is
 * emitted once as the start, since two marks on one coordinate is noise rather than
 * information.
 */
export function buildTrackEndpointFeatures(track: Track): FeatureCollection<PointFeature> {
  const first = track.points[0];
  const last = track.points[track.points.length - 1];
  if (first === undefined || last === undefined) {
    return { type: "FeatureCollection", features: [] };
  }

  const features: PointFeature[] = [
    {
      type: "Feature",
      geometry: { type: "Point", coordinates: position(first) },
      properties: { kind: "track-start", trackId: track.id },
    },
  ];

  if (track.points.length > 1) {
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: position(last) },
      properties: { kind: "track-finish", trackId: track.id },
    });
  }

  return { type: "FeatureCollection", features };
}

/** A mark where each lap ended, labelled with whatever the consumer called it. */
export function buildLapFeatures(track: Track): FeatureCollection<PointFeature> {
  const features: PointFeature[] = [];

  for (const lap of track.laps ?? []) {
    const point = track.points[lap.endIndex];
    if (point === undefined) continue;
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: position(point) },
      properties: {
        kind: "track-lap",
        trackId: track.id,
        ...(lap.label === undefined ? {} : { label: lap.label }),
      },
    });
  }

  return { type: "FeatureCollection", features };
}
