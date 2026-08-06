// SPDX-License-Identifier: Apache-2.0
import type {
  Id,
  JSONValue,
  MapEvent,
  MediaRef,
  Track,
  TrackPoint,
  TrackStatus,
} from "./types";

/**
 * Portability (specs/api.md §8). Export/import round-trips a track and its
 * events through GeoJSON without losing geometry, timestamps, comments, tags,
 * `fields`, or `analysis`. Media travels *by reference* (a `MediaRef` carries a
 * `blobKey`/`url`, never inlined bytes) plus a collection-level manifest.
 */

const TRACK_KIND = "mapatlas:track";
const EVENT_KIND = "mapatlas:event";
const MANIFEST_KIND = "mapatlas:manifest";

/** Per-point metadata carried alongside the LineString coordinates. */
interface PointMeta {
  t: number;
  accuracyM?: number;
  speedMps?: number;
  headingDeg?: number;
}

interface TrackProps {
  kind: typeof TRACK_KIND;
  id: Id;
  startedAt: number;
  endedAt?: number;
  status: TrackStatus;
  distanceM?: number;
  tags?: string[];
  meta?: Record<string, JSONValue>;
  pointMeta: PointMeta[];
  simplified?: TrackPoint[];
}

interface EventProps {
  kind: typeof EVENT_KIND;
  id: Id;
  trackId?: Id;
  occurredAt: number;
  comment?: string;
  tags: string[];
  category?: string;
  fields?: Record<string, JSONValue>;
  media: MediaRef[];
}

interface ManifestProps {
  kind: typeof MANIFEST_KIND;
  media: MediaRef[];
}

function toPointMeta(p: TrackPoint): PointMeta {
  const m: PointMeta = { t: p.t };
  if (p.accuracyM !== undefined) m.accuracyM = p.accuracyM;
  if (p.speedMps !== undefined) m.speedMps = p.speedMps;
  if (p.headingDeg !== undefined) m.headingDeg = p.headingDeg;
  return m;
}

function toTrackPoint(coord: GeoJSON.Position, meta: PointMeta): TrackPoint {
  const lng = coord[0];
  const lat = coord[1];
  if (typeof lng !== "number" || typeof lat !== "number") {
    throw new Error("geoJSONToTrack: track coordinate must be [lng, lat]");
  }
  const p: TrackPoint = { lat, lng, t: meta.t };
  if (meta.accuracyM !== undefined) p.accuracyM = meta.accuracyM;
  if (meta.speedMps !== undefined) p.speedMps = meta.speedMps;
  if (meta.headingDeg !== undefined) p.headingDeg = meta.headingDeg;
  return p;
}

export function trackToGeoJSON(
  track: Track,
  events: MapEvent[],
): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];

  const trackProps: TrackProps = {
    kind: TRACK_KIND,
    id: track.id,
    startedAt: track.startedAt,
    status: track.status,
    pointMeta: track.points.map(toPointMeta),
  };
  if (track.endedAt !== undefined) trackProps.endedAt = track.endedAt;
  if (track.distanceM !== undefined) trackProps.distanceM = track.distanceM;
  if (track.tags !== undefined) trackProps.tags = track.tags;
  if (track.meta !== undefined) trackProps.meta = track.meta;
  if (track.simplified !== undefined) trackProps.simplified = track.simplified;

  features.push({
    type: "Feature",
    geometry: {
      type: "LineString",
      coordinates: track.points.map((p) => [p.lng, p.lat]),
    },
    properties: trackProps as GeoJSON.GeoJsonProperties,
  });

  for (const ev of events) {
    const props: EventProps = {
      kind: EVENT_KIND,
      id: ev.id,
      occurredAt: ev.occurredAt,
      tags: ev.tags,
      media: ev.media,
    };
    if (ev.trackId !== undefined) props.trackId = ev.trackId;
    if (ev.comment !== undefined) props.comment = ev.comment;
    if (ev.category !== undefined) props.category = ev.category;
    if (ev.fields !== undefined) props.fields = ev.fields;

    features.push({
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: [ev.position.lng, ev.position.lat],
      },
      properties: props as GeoJSON.GeoJsonProperties,
    });
  }

  const manifest: ManifestProps = {
    kind: MANIFEST_KIND,
    media: events.flatMap((e) => e.media),
  };
  features.push({
    type: "Feature",
    geometry: { type: "GeometryCollection", geometries: [] },
    properties: manifest as GeoJSON.GeoJsonProperties,
  });

  return { type: "FeatureCollection", features };
}

function trackFromFeature(feature: GeoJSON.Feature, props: TrackProps): Track {
  const geom = feature.geometry;
  const coords = geom && geom.type === "LineString" ? geom.coordinates : [];
  const pointMeta = props.pointMeta ?? [];
  const points = coords.map((c, i) =>
    toTrackPoint(c, pointMeta[i] ?? { t: 0 }),
  );

  const track: Track = {
    id: props.id,
    startedAt: props.startedAt,
    status: props.status,
    points,
  };
  if (props.endedAt !== undefined) track.endedAt = props.endedAt;
  if (props.distanceM !== undefined) track.distanceM = props.distanceM;
  if (props.tags !== undefined) track.tags = props.tags;
  if (props.meta !== undefined) track.meta = props.meta;
  if (props.simplified !== undefined) track.simplified = props.simplified;
  return track;
}

function eventFromFeature(
  feature: GeoJSON.Feature,
  props: EventProps,
): MapEvent {
  const geom = feature.geometry;
  if (!geom || geom.type !== "Point") {
    throw new Error("geoJSONToTrack: event feature must have Point geometry");
  }
  const lng = geom.coordinates[0];
  const lat = geom.coordinates[1];
  if (typeof lng !== "number" || typeof lat !== "number") {
    throw new Error("geoJSONToTrack: event coordinate must be [lng, lat]");
  }

  const ev: MapEvent = {
    id: props.id,
    position: { lat, lng },
    occurredAt: props.occurredAt,
    tags: props.tags ?? [],
    media: props.media ?? [],
  };
  if (props.trackId !== undefined) ev.trackId = props.trackId;
  if (props.comment !== undefined) ev.comment = props.comment;
  if (props.category !== undefined) ev.category = props.category;
  if (props.fields !== undefined) ev.fields = props.fields;
  return ev;
}

export function geoJSONToTrack(fc: GeoJSON.FeatureCollection): {
  track: Track;
  events: MapEvent[];
} {
  let track: Track | undefined;
  const events: MapEvent[] = [];

  for (const feature of fc.features) {
    const props = feature.properties;
    if (!props || typeof props.kind !== "string") continue;
    if (props.kind === TRACK_KIND) {
      track = trackFromFeature(feature, props as TrackProps);
    } else if (props.kind === EVENT_KIND) {
      events.push(eventFromFeature(feature, props as EventProps));
    }
    // MANIFEST_KIND is informational; ignored on import.
  }

  if (!track) {
    throw new Error("geoJSONToTrack: no track feature found");
  }
  return { track, events };
}
