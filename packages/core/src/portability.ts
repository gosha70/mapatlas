// SPDX-License-Identifier: Apache-2.0

import type { ChannelDescriptor } from "./channels.js";
import type { MapEvent, MediaRef } from "./event.js";
import type { FeatureCollection, MultiLineString, Point, Position } from "./geojson.js";
import type { Id } from "./ids.js";
import type { JSONValue } from "./json.js";
import type { Track, TrackLap, TrackPoint, TrackSegment, TrackStats } from "./track.js";
import { assertValidTrackGeometry } from "./validate.js";

/**
 * Export and import: GeoJSON plus a media manifest.
 *
 * Three rules shape everything here.
 *
 * **Raw geometry only.** `simplifiedSegments` is a derived cache and never belongs in
 * interchange — T1.7 requires a lossless round-trip, and decimated points cannot be that.
 * It is regenerated on the far side. (ADR-0018)
 *
 * **Structural alignment, never compaction.** Timestamps and every per-point field travel
 * as arrays parallel to the coordinates, one per segment. A point missing a value
 * contributes `null`, so index *i* always means the same point. Compacting would make the
 * arrays unreadable without the very data they encode.
 *
 * **Media by reference.** The manifest carries keys and metadata; bytes never enter the
 * document. A trip's photos can be gigabytes, and base64 in a JSON file helps nobody.
 */

export interface MediaManifestEntry {
  id: Id;
  mime: string;
  blobKey?: string;
  url?: string;
  width?: number;
  height?: number;
  bytes?: number;
}

export interface TrackExport {
  geojson: FeatureCollection<TrackFeature | EventFeature>;
  /** Sorted by id: the set is what matters, not the order it was discovered in. */
  media: MediaManifestEntry[];
}

/** A per-point field carried as one array per segment, aligned to the coordinates. */
type ParallelArray = (number | null)[][];

export interface TrackFeatureProperties {
  kind: "track";
  id: Id;
  startedAt: number;
  endedAt?: number;
  status: Track["status"];
  origin: Track["origin"];
  /** Segment metadata. Indices are implied by the `MultiLineString` members' lengths. */
  segments: SegmentProperties[];
  coordTimes: number[][];
  accuracyM?: ParallelArray;
  altitudeAccuracyM?: ParallelArray;
  speedMps?: ParallelArray;
  headingDeg?: ParallelArray;
  /** Channel key to one array per segment. Keys are emitted in sorted order. */
  channels?: Record<string, ParallelArray>;
  channelDescriptors?: ChannelDescriptor[];
  laps?: TrackLap[];
  stats?: TrackStats;
  tags?: string[];
  meta?: Record<string, JSONValue>;
}

export interface SegmentProperties {
  id: Id;
  startedAt: number;
  endedAt?: number;
  distanceM?: number;
}

export interface EventFeatureProperties {
  kind: "event";
  id: Id;
  trackId?: Id;
  occurredAt: number;
  comment?: string;
  media: MediaRef[];
  tags: string[];
  category?: string;
  fields?: Record<string, JSONValue>;
}

export type TrackFeature = {
  type: "Feature";
  geometry: MultiLineString;
  properties: TrackFeatureProperties;
};

export type EventFeature = {
  type: "Feature";
  geometry: Point;
  properties: EventFeatureProperties;
};

/** A document that is not shaped the way import requires. */
export class TrackImportError extends Error {
  constructor(detail: string) {
    super(`cannot import this document: ${detail}`);
    this.name = "TrackImportError";
  }
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

// ---------------------------------------------------------------------------- export

/** Per-point field, as one array per segment with `null` where the point lacks it. */
function parallel(
  points: readonly TrackPoint[],
  segments: readonly TrackSegment[],
  read: (p: TrackPoint) => number | undefined,
): ParallelArray | undefined {
  let anyPresent = false;

  const arrays = segments.map((segment) => {
    const values: (number | null)[] = [];
    for (let i = segment.startIndex; i <= segment.endIndex; i += 1) {
      const point = points[i];
      const value = point === undefined ? undefined : read(point);
      if (value !== undefined) anyPresent = true;
      values.push(value ?? null);
    }
    return values;
  });

  // Omit the property entirely when nothing carries the field, rather than emitting a
  // document full of nulls.
  return anyPresent ? arrays : undefined;
}

export function trackToGeoJSON(track: Track, events: readonly MapEvent[]): TrackExport {
  assertValidTrackGeometry(track);

  const { points, segments } = track;

  const coordinates: Position[][] = segments.map((segment) => {
    const line: Position[] = [];
    for (let i = segment.startIndex; i <= segment.endIndex; i += 1) {
      const point = points[i];
      if (point === undefined) continue;
      line.push(
        point.altitudeM === undefined
          ? [point.lng, point.lat]
          : [point.lng, point.lat, point.altitudeM],
      );
    }
    return line;
  });

  const coordTimes: number[][] = segments.map((segment) => {
    const times: number[] = [];
    for (let i = segment.startIndex; i <= segment.endIndex; i += 1) {
      const point = points[i];
      if (point !== undefined) times.push(point.t);
    }
    return times;
  });

  // Sorted so the serialised document does not depend on the order keys happened to be
  // inserted into a Map somewhere upstream.
  const channelKeys = [...new Set(points.flatMap((p) => Object.keys(p.channels ?? {})))].sort();

  const channels: Record<string, ParallelArray> = {};
  for (const key of channelKeys) {
    const arrays = parallel(points, segments, (p) => p.channels?.[key]);
    if (arrays !== undefined) channels[key] = arrays;
  }

  const properties: TrackFeatureProperties = {
    kind: "track",
    id: track.id,
    startedAt: track.startedAt,
    ...(track.endedAt === undefined ? {} : { endedAt: track.endedAt }),
    status: track.status,
    origin: track.origin,
    segments: segments.map((segment) => ({
      id: segment.id,
      startedAt: segment.startedAt,
      ...(segment.endedAt === undefined ? {} : { endedAt: segment.endedAt }),
      ...(segment.distanceM === undefined ? {} : { distanceM: segment.distanceM }),
    })),
    coordTimes,
  };

  const accuracyM = parallel(points, segments, (p) => p.accuracyM);
  if (accuracyM !== undefined) properties.accuracyM = accuracyM;
  const altitudeAccuracyM = parallel(points, segments, (p) => p.altitudeAccuracyM);
  if (altitudeAccuracyM !== undefined) properties.altitudeAccuracyM = altitudeAccuracyM;
  const speedMps = parallel(points, segments, (p) => p.speedMps);
  if (speedMps !== undefined) properties.speedMps = speedMps;
  const headingDeg = parallel(points, segments, (p) => p.headingDeg);
  if (headingDeg !== undefined) properties.headingDeg = headingDeg;

  if (Object.keys(channels).length > 0) properties.channels = channels;
  if (track.channels !== undefined) properties.channelDescriptors = copy(track.channels);
  if (track.laps !== undefined) properties.laps = copy(track.laps);
  if (track.stats !== undefined) properties.stats = copy(track.stats);
  if (track.tags !== undefined) properties.tags = [...track.tags];
  if (track.meta !== undefined) properties.meta = copy(track.meta);

  // The same total order EventLog imposes, so a document does not depend on the order the
  // caller happened to hand events over in.
  const ordered = [...events].sort(
    (a, b) => a.occurredAt - b.occurredAt || a.id.localeCompare(b.id),
  );

  const eventFeatures: EventFeature[] = ordered.map((event) => ({
    type: "Feature",
    geometry: { type: "Point", coordinates: [event.position.lng, event.position.lat] },
    properties: {
      kind: "event",
      id: event.id,
      ...(event.trackId === undefined ? {} : { trackId: event.trackId }),
      occurredAt: event.occurredAt,
      ...(event.comment === undefined ? {} : { comment: event.comment }),
      media: copy(event.media),
      tags: [...event.tags],
      ...(event.category === undefined ? {} : { category: event.category }),
      ...(event.fields === undefined ? {} : { fields: copy(event.fields) }),
    },
  }));

  const manifest = new Map<Id, MediaManifestEntry>();
  for (const event of ordered) {
    for (const media of event.media) {
      // Keyed by id, so two events referencing the same media yield one entry.
      manifest.set(media.id, {
        id: media.id,
        mime: media.mime,
        ...(media.blobKey === undefined ? {} : { blobKey: media.blobKey }),
        ...(media.url === undefined ? {} : { url: media.url }),
        ...(media.width === undefined ? {} : { width: media.width }),
        ...(media.height === undefined ? {} : { height: media.height }),
      });
    }
  }

  const trackFeature: TrackFeature = {
    type: "Feature",
    geometry: { type: "MultiLineString", coordinates },
    properties,
  };

  return {
    geojson: { type: "FeatureCollection", features: [trackFeature, ...eventFeatures] },
    media: [...manifest.values()].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

// ---------------------------------------------------------------------------- import

function assertAligned(
  name: string,
  arrays: readonly unknown[] | undefined,
  coordinates: readonly Position[][],
): void {
  if (arrays === undefined) return;

  if (!Array.isArray(arrays) || arrays.length !== coordinates.length) {
    throw new TrackImportError(
      `${name} has ${Array.isArray(arrays) ? arrays.length : "no"} segments but the geometry has ${coordinates.length}`,
    );
  }

  for (const [i, member] of arrays.entries()) {
    const expected = coordinates[i]?.length ?? 0;
    if (!Array.isArray(member) || member.length !== expected) {
      throw new TrackImportError(
        `${name}[${i}] has ${Array.isArray(member) ? member.length : "no"} values but segment ${i} has ${expected} coordinates`,
      );
    }
  }
}

function readParallel(
  arrays: ParallelArray | undefined,
  segment: number,
  index: number,
): number | undefined {
  const value = arrays?.[segment]?.[index];
  return value === null || value === undefined ? undefined : value;
}

export function geoJSONToTrack(exported: TrackExport): { track: Track; events: MapEvent[] } {
  const features = exported.geojson?.features;
  if (!Array.isArray(features) || features.length === 0) {
    throw new TrackImportError("the feature collection is empty");
  }

  const trackFeatures = features.filter((f): f is TrackFeature => f.properties?.kind === "track");
  if (trackFeatures.length !== 1) {
    throw new TrackImportError(`expected exactly one track feature, found ${trackFeatures.length}`);
  }

  const [trackFeature] = trackFeatures;
  if (trackFeature === undefined) throw new TrackImportError("the track feature is missing");

  const { geometry, properties } = trackFeature;
  if (geometry?.type !== "MultiLineString") {
    throw new TrackImportError(
      `the track geometry is ${geometry?.type ?? "absent"}, not a MultiLineString`,
    );
  }

  const coordinates = geometry.coordinates;
  if (!Array.isArray(coordinates))
    throw new TrackImportError("the track geometry has no coordinates");

  if (properties.segments?.length !== coordinates.length) {
    throw new TrackImportError(
      `${properties.segments?.length ?? 0} segment properties for ${coordinates.length} geometry members`,
    );
  }

  assertAligned("coordTimes", properties.coordTimes, coordinates);
  assertAligned("accuracyM", properties.accuracyM, coordinates);
  assertAligned("altitudeAccuracyM", properties.altitudeAccuracyM, coordinates);
  assertAligned("speedMps", properties.speedMps, coordinates);
  assertAligned("headingDeg", properties.headingDeg, coordinates);
  for (const [key, arrays] of Object.entries(properties.channels ?? {})) {
    assertAligned(`channels.${key}`, arrays, coordinates);
  }

  const points: TrackPoint[] = [];
  const segments: TrackSegment[] = [];

  for (const [segmentIndex, line] of coordinates.entries()) {
    const meta = properties.segments[segmentIndex];
    if (meta === undefined) throw new TrackImportError(`segment ${segmentIndex} has no properties`);

    const startIndex = points.length;

    for (const [i, position] of line.entries()) {
      const lng = position[0];
      const lat = position[1];
      const altitude = position[2];
      const t = properties.coordTimes[segmentIndex]?.[i];

      if (typeof lng !== "number" || typeof lat !== "number") {
        throw new TrackImportError(`coordinate [${segmentIndex}][${i}] is not a position`);
      }
      if (typeof t !== "number") {
        throw new TrackImportError(`coordTimes[${segmentIndex}][${i}] is missing`);
      }

      const channels: Record<string, number> = {};
      for (const [key, arrays] of Object.entries(properties.channels ?? {})) {
        const value = readParallel(arrays, segmentIndex, i);
        if (value !== undefined) channels[key] = value;
      }

      const accuracyM = readParallel(properties.accuracyM, segmentIndex, i);
      const altitudeAccuracyM = readParallel(properties.altitudeAccuracyM, segmentIndex, i);
      const speedMps = readParallel(properties.speedMps, segmentIndex, i);
      const headingDeg = readParallel(properties.headingDeg, segmentIndex, i);

      points.push({
        lat,
        lng,
        t,
        ...(accuracyM === undefined ? {} : { accuracyM }),
        ...(altitude === undefined ? {} : { altitudeM: altitude }),
        ...(altitudeAccuracyM === undefined ? {} : { altitudeAccuracyM }),
        ...(speedMps === undefined ? {} : { speedMps }),
        ...(headingDeg === undefined ? {} : { headingDeg }),
        ...(Object.keys(channels).length === 0 ? {} : { channels }),
      });
    }

    segments.push({
      id: meta.id,
      startIndex,
      endIndex: points.length - 1,
      startedAt: meta.startedAt,
      ...(meta.endedAt === undefined ? {} : { endedAt: meta.endedAt }),
      ...(meta.distanceM === undefined ? {} : { distanceM: meta.distanceM }),
    });
  }

  const track: Track = {
    id: properties.id,
    startedAt: properties.startedAt,
    ...(properties.endedAt === undefined ? {} : { endedAt: properties.endedAt }),
    status: properties.status,
    origin: properties.origin,
    points,
    segments,
    ...(properties.channelDescriptors === undefined
      ? {}
      : { channels: copy(properties.channelDescriptors) }),
    ...(properties.laps === undefined ? {} : { laps: copy(properties.laps) }),
    ...(properties.stats === undefined ? {} : { stats: copy(properties.stats) }),
    ...(properties.tags === undefined ? {} : { tags: [...properties.tags] }),
    ...(properties.meta === undefined ? {} : { meta: copy(properties.meta) }),
  };

  // The same invariants a recorded track must satisfy. Import surfaces malformed temporal
  // or segment structure rather than repairing it. (ADR-0020)
  assertValidTrackGeometry(track);

  const events: MapEvent[] = features
    .filter((f): f is EventFeature => f.properties?.kind === "event")
    .map((feature) => {
      const position = feature.geometry?.coordinates;
      const lng = position?.[0];
      const lat = position?.[1];
      if (typeof lng !== "number" || typeof lat !== "number") {
        throw new TrackImportError(`event ${feature.properties.id} has no position`);
      }

      const p = feature.properties;
      return {
        id: p.id,
        ...(p.trackId === undefined ? {} : { trackId: p.trackId }),
        position: { lat, lng },
        occurredAt: p.occurredAt,
        ...(p.comment === undefined ? {} : { comment: p.comment }),
        media: copy(p.media ?? []),
        tags: [...(p.tags ?? [])],
        ...(p.category === undefined ? {} : { category: p.category }),
        ...(p.fields === undefined ? {} : { fields: copy(p.fields) }),
      };
    });

  return { track, events };
}
