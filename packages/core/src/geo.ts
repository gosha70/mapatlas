// SPDX-License-Identifier: Apache-2.0

import type { LatLng } from "./types.js";
import { toRadians } from "./id.js";

/** Mean Earth radius in meters (WGS84 authalic sphere). */
export const EARTH_RADIUS_M = 6_371_008.8;

/**
 * Great-circle distance between two coordinates, in meters (haversine).
 */
export function haversineM(a: LatLng, b: LatLng): number {
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);

  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);
  const h =
    sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLng * sinDLng;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Cumulative haversine length of a polyline, in meters. */
export function polylineLengthM(points: readonly LatLng[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += haversineM(points[i - 1]!, points[i]!);
  }
  return total;
}

/**
 * Local equirectangular projection to meters relative to a reference latitude.
 * Adequate for the small extents involved in track simplification, where it
 * avoids the distortion of treating raw lng/lat degrees as planar coordinates.
 */
export function projectMeters(
  p: LatLng,
  refLatDeg: number,
): { x: number; y: number } {
  const cosRef = Math.cos(toRadians(refLatDeg));
  return {
    x: EARTH_RADIUS_M * toRadians(p.lng) * cosRef,
    y: EARTH_RADIUS_M * toRadians(p.lat),
  };
}
