// SPDX-License-Identifier: Apache-2.0
import type { LatLng } from "./types";

/** Mean Earth radius in metres (IUGG). */
export const EARTH_RADIUS_M = 6371008.8;

const DEG_TO_RAD = Math.PI / 180;

/** Great-circle distance between two coordinates, in metres (haversine). */
export function haversineMeters(a: LatLng, b: LatLng): number {
  const dLat = (b.lat - a.lat) * DEG_TO_RAD;
  const dLng = (b.lng - a.lng) * DEG_TO_RAD;
  const lat1 = a.lat * DEG_TO_RAD;
  const lat2 = b.lat * DEG_TO_RAD;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Summed great-circle length of a polyline, in metres. */
export function pathLengthMeters(points: readonly LatLng[]): number {
  let total = 0;
  let prev: LatLng | undefined;
  for (const p of points) {
    if (prev) total += haversineMeters(prev, p);
    prev = p;
  }
  return total;
}
