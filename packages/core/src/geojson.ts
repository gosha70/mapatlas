// SPDX-License-Identifier: Apache-2.0

import type { MapEvent, Track, TrackPoint } from "./types.js";

/**
 * Portability (api.md §8, tasks T1.7): loss-free export/import between the
 * engine's model and standard GeoJSON.
 *
 * Design: each feature carries a meaningful GeoJSON geometry (a track is a
 * `LineString`, an event is a `Point`) so external tools can read the file,
 * *and* a canonical copy of the engine object under a namespaced foreign
 * member (`mapatlas:track` / `mapatlas:event`). Round-tripping reconstructs
 * from the foreign member, so geometry, timestamps, comment, tags, `fields`,
 * and `analysis` are all preserved exactly.
 *
 * Media travels **by reference**: `MediaRef` carries `blobKey`/`url` (a
 * manifest), never inlined bytes.
 */

const KIND = "mapatlas:kind";
const TRACK_KEY = "mapatlas:track";
const EVENT_KEY = "mapatlas:event";

interface TrackProps {
  [KIND]: "track";
  [TRACK_KEY]: Track;
  [k: string]: unknown;
}

interface EventProps {
  [KIND]: "event";
  [EVENT_KEY]: MapEvent;
  [k: string]: unknown;
}

function pointToPosition(p: { lat: number; lng: number }): GeoJSON.Position {
  return [p.lng, p.lat];
}

/**
 * Build a spec-valid geometry for a track. A track with ≥2 points is a
 * `LineString`; a single point degrades to a `Point`; an empty track uses an
 * (empty) `GeometryCollection` so the geometry is never null. The canonical
 * track lives in the foreign member, so this is purely for external readers.
 */
function trackGeometry(track: Track): GeoJSON.Geometry {
  const line = (track.simplified ?? track.points).map(pointToPosition);
  if (line.length >= 2) return { type: "LineString", coordinates: line };
  if (line.length === 1) return { type: "Point", coordinates: line[0]! };
  return { type: "GeometryCollection", geometries: [] };
}

function trackToFeature(track: Track): GeoJSON.Feature {
  const props: TrackProps = { [KIND]: "track", [TRACK_KEY]: track };
  return {
    type: "Feature",
    geometry: trackGeometry(track),
    properties: props as unknown as GeoJSON.GeoJsonProperties,
  };
}

function eventToFeature(event: MapEvent): GeoJSON.Feature {
  const props: EventProps = { [KIND]: "event", [EVENT_KEY]: event };
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: pointToPosition(event.position) },
    properties: props as unknown as GeoJSON.GeoJsonProperties,
  };
}

/** Export a track and its events to a GeoJSON FeatureCollection. */
export function trackToGeoJSON(
  track: Track,
  events: MapEvent[],
): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: [trackToFeature(track), ...events.map(eventToFeature)],
  };
}

function propsOf(feature: GeoJSON.Feature): Record<string, unknown> | null {
  return (feature.properties ?? null) as Record<string, unknown> | null;
}

/** Import a GeoJSON FeatureCollection back into a track + its events. */
export function geoJSONToTrack(fc: GeoJSON.FeatureCollection): {
  track: Track;
  events: MapEvent[];
} {
  let track: Track | undefined;
  const events: MapEvent[] = [];

  for (const feature of fc.features) {
    const props = propsOf(feature);
    if (!props) continue;
    const kind = props[KIND];
    if (kind === "track" && track === undefined) {
      track = props[TRACK_KEY] as Track;
    } else if (kind === "event") {
      events.push(props[EVENT_KEY] as MapEvent);
    }
  }

  if (track === undefined) {
    // No engine track feature: fall back to reading a bare LineString so
    // externally-authored GeoJSON still imports as a minimal track.
    track = trackFromBareLineString(fc);
  }

  return { track, events };
}

function trackFromBareLineString(fc: GeoJSON.FeatureCollection): Track {
  const points: TrackPoint[] = [];
  for (const feature of fc.features) {
    if (feature.geometry?.type === "LineString") {
      for (const pos of feature.geometry.coordinates) {
        const lng = pos[0];
        const lat = pos[1];
        if (typeof lng === "number" && typeof lat === "number") {
          points.push({ lat, lng, t: 0 });
        }
      }
      break;
    }
  }
  return {
    id: "",
    startedAt: points[0]?.t ?? 0,
    status: "finalized",
    points,
  };
}
