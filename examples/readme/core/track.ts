// SPDX-License-Identifier: Apache-2.0
import { haversineDistanceMeters, newId, trackToGeoJSON, type Track } from "@mapatlas/core";

// The engine's data model is plain data: a track is points on a timeline, no class required.
const startedAt = Date.now();
const track: Track = {
  id: newId(),
  startedAt,
  endedAt: startedAt + 60_000,
  status: "finalized",
  origin: "authored",
  points: [
    { lat: 45.9, lng: 7, t: startedAt },
    { lat: 45.91, lng: 7.01, t: startedAt + 60_000 },
  ],
  segments: [{ id: newId(), startIndex: 0, endIndex: 1, startedAt, endedAt: startedAt + 60_000 }],
};

export const metres = haversineDistanceMeters(track.points[0]!, track.points[1]!);
// Portable, with its events: the GeoJSON a consumer can hand to anything else.
export const exported = trackToGeoJSON(track, []);
