// SPDX-License-Identifier: Apache-2.0

/** WGS84 degrees. The engine has exactly one coordinate system (PRD §5 non-goals). */
export interface LatLng {
  lat: number;
  lng: number;
}

/** [west, south, east, north] in WGS84 degrees. */
export type BBox = [west: number, south: number, east: number, north: number];
