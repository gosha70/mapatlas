// SPDX-License-Identifier: Apache-2.0

/** WGS84 degrees. The engine has exactly one coordinate system (PRD §5 non-goals). */
export interface LatLng {
  lat: number;
  lng: number;
}

/** [west, south, east, north] in WGS84 degrees. */
export type BBox = [west: number, south: number, east: number, north: number];

/** Mean Earth radius (IUGG). */
const EARTH_RADIUS_M = 6_371_008.8;

const DEGREES_TO_RADIANS = Math.PI / 180;

/**
 * Great-circle distance in metres on a sphere. **For cheap geometric decisions, not for
 * recorded distance.**
 *
 * Measured against Vincenty's inverse on WGS84, this runs about 0.26% short over long
 * distances and up to ~0.56% on a meridian near the equator. That is irrelevant to what it
 * is for — deciding whether a fix moved roughly ten metres, where GPS error dwarfs the
 * difference — and it buys a closed-form calculation with no iteration and no dependency.
 *
 * It is deliberately **not** the engine's definition of distance. `stats.distanceM` is a
 * durable, user-visible number, and a systematic 0.3% bias compounds: ~30 m over 10 km,
 * ~126 m over a marathon, more over an all-day trip. That value comes from
 * `geodesicDistanceMeters` instead. The names are distinct so neither can quietly become
 * the other. (ADR-0019)
 */
export function haversineDistanceMeters(a: LatLng, b: LatLng): number {
  const lat1 = a.lat * DEGREES_TO_RADIANS;
  const lat2 = b.lat * DEGREES_TO_RADIANS;
  const deltaLat = (b.lat - a.lat) * DEGREES_TO_RADIANS;
  const deltaLng = (b.lng - a.lng) * DEGREES_TO_RADIANS;

  const h =
    Math.sin(deltaLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2;

  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}
