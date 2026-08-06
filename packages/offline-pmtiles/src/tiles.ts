// SPDX-License-Identifier: Apache-2.0

/** A slippy-map tile coordinate. */
export interface TileCoord {
  z: number;
  x: number;
  y: number;
}

function lngToTileX(lng: number, z: number): number {
  return Math.floor(((lng + 180) / 360) * 2 ** z);
}

function latToTileY(lat: number, z: number): number {
  const rad = (lat * Math.PI) / 180;
  return Math.floor(
    ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** z,
  );
}

function clamp(v: number, z: number): number {
  return Math.max(0, Math.min(2 ** z - 1, v));
}

/**
 * Enumerate every XYZ tile covering `bbox` across the inclusive zoom range
 * `[minZoom, maxZoom]`. `bbox` is `[west, south, east, north]` in WGS-84 degrees.
 */
export function tilesForRegion(
  bbox: [west: number, south: number, east: number, north: number],
  minZoom: number,
  maxZoom: number,
): TileCoord[] {
  const [west, south, east, north] = bbox;
  const out: TileCoord[] = [];
  for (let z = minZoom; z <= maxZoom; z++) {
    const xMin = clamp(lngToTileX(west, z), z);
    const xMax = clamp(lngToTileX(east, z), z);
    // North latitude maps to the smaller tile-Y.
    const yMin = clamp(latToTileY(north, z), z);
    const yMax = clamp(latToTileY(south, z), z);
    for (let x = Math.min(xMin, xMax); x <= Math.max(xMin, xMax); x++) {
      for (let y = Math.min(yMin, yMax); y <= Math.max(yMin, yMax); y++) {
        out.push({ z, x, y });
      }
    }
  }
  return out;
}

/** Number of tiles a region occupies, without enumerating them. */
export function countTiles(
  bbox: [west: number, south: number, east: number, north: number],
  minZoom: number,
  maxZoom: number,
): number {
  return tilesForRegion(bbox, minZoom, maxZoom).length;
}
