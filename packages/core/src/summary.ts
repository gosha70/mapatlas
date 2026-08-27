// SPDX-License-Identifier: Apache-2.0

import type { BBox, LatLng } from "./geo.js";
import type { Track, TrackSummary } from "./track.js";

/**
 * Derive the list projection from a track.
 *
 * Shared rather than reimplemented per adapter. Two adapters computing a bbox or an
 * `eventCount` slightly differently would satisfy the same contract while disagreeing about
 * what a trip list shows, and the divergence would surface as a rendering bug rather than a
 * storage one. (ADR-0014)
 *
 * Computing the projection is separate from *storing* it: an adapter that keeps summaries
 * in their own index calls this when writing, so listing never has to read a point array.
 */
export function summariseTrack(track: Track, eventCount?: number): TrackSummary {
  const first = track.points[0];
  const last = track.points[track.points.length - 1];

  let bounds: { bbox?: BBox; start?: LatLng; finish?: LatLng } = {};
  if (first !== undefined && last !== undefined) {
    let west = first.lng;
    let east = first.lng;
    let south = first.lat;
    let north = first.lat;

    for (const point of track.points) {
      west = Math.min(west, point.lng);
      east = Math.max(east, point.lng);
      south = Math.min(south, point.lat);
      north = Math.max(north, point.lat);
    }

    bounds = {
      bbox: [west, south, east, north],
      start: { lat: first.lat, lng: first.lng },
      finish: { lat: last.lat, lng: last.lng },
    };
  }

  const channelKeys = track.channels?.map((channel) => channel.key);

  return {
    id: track.id,
    startedAt: track.startedAt,
    ...(track.endedAt === undefined ? {} : { endedAt: track.endedAt }),
    status: track.status,
    origin: track.origin,
    ...(track.stats === undefined ? {} : { stats: structuredClone(track.stats) }),
    pointCount: track.points.length,
    ...(eventCount === undefined ? {} : { eventCount }),
    ...bounds,
    ...(channelKeys === undefined || channelKeys.length === 0 ? {} : { channelKeys }),
    ...(track.tags === undefined ? {} : { tags: [...track.tags] }),
    ...(track.meta === undefined ? {} : { meta: structuredClone(track.meta) }),
  };
}

/** The order `listTrackSummaries` must return: `startedAt` ascending, ties broken by id. */
export function compareTrackSummaries(a: TrackSummary, b: TrackSummary): number {
  return a.startedAt - b.startedAt || a.id.localeCompare(b.id);
}
