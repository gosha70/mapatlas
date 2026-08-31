// SPDX-License-Identifier: Apache-2.0

/**
 * An independently written Web-Mercator projection, for tests only.
 *
 * Not a `.test.mjs` file, so the runner does not pick it up as a suite. It exists so the suites
 * that check `mercator.mjs` do not check it against a restatement of its own formulas.
 *
 * `mercator.mjs` inverts with `atan(sinh(...))` and projects with `ln(tan(φ) + sec(φ))`. This
 * uses the Gudermannian's `2·atan(exp(y)) − π/2` and `ln(tan(π/4 + φ/2))`. The two are
 * mathematically equal and textually unrelated, so a transcription slip in one does not
 * reproduce itself in the other — which is the only sense in which a second implementation is
 * worth having. Two published anchors are asserted against both, because two formulas that agree
 * with each other can still both be wrong.
 */

/** @param {number} lon @param {number} zoom */
export function lonToX(lon, zoom) {
  return (2 ** zoom * (lon + 180)) / 360;
}

/** @param {number} lat @param {number} zoom */
export function latToY(lat, zoom) {
  const mercator = Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  return 2 ** zoom * (0.5 - mercator / (2 * Math.PI));
}

/** @param {number} x @param {number} zoom */
export function xToLon(x, zoom) {
  return (360 * x) / 2 ** zoom - 180;
}

/** @param {number} y @param {number} zoom */
export function yToLat(y, zoom) {
  const mercator = 2 * Math.PI * (0.5 - y / 2 ** zoom);
  return ((2 * Math.atan(Math.exp(mercator)) - Math.PI / 2) * 180) / Math.PI;
}

/**
 * The lon/lat of a tile pixel's centre, computed without `mercator.mjs`.
 *
 * @param {number} zoom @param {number} x @param {number} y @param {number} col @param {number} row
 */
export function pixelCentre(zoom, x, y, col, row, tileSize = 256) {
  return {
    lon: xToLon((x * tileSize + col + 0.5) / tileSize, zoom),
    lat: yToLat((y * tileSize + row + 0.5) / tileSize, zoom),
  };
}
