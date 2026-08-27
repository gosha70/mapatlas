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

/**
 * WGS84 reference ellipsoid — the datum GPS reports positions in, so measuring on it needs
 * no transformation.
 */
const WGS84_SEMI_MAJOR_M = 6_378_137;
const WGS84_FLATTENING = 1 / 298.257223563;
const WGS84_SEMI_MINOR_M = (1 - WGS84_FLATTENING) * WGS84_SEMI_MAJOR_M;

/** Vincenty converges in a handful of iterations for anything that is not near-antipodal. */
const VINCENTY_MAX_ITERATIONS = 100;
/** ~0.06 mm of arc at the equator: past the point where GPS has anything to say. */
const VINCENTY_CONVERGENCE = 1e-12;

/**
 * Geodesic distance in metres on the WGS84 ellipsoid, by Vincenty's inverse method.
 *
 * **This is the engine's definition of recorded distance** — the only source of
 * `stats.distanceM` and `TrackSegment.distanceM`. Unlike {@link haversineDistanceMeters} it
 * measures on the ellipsoid rather than a sphere, which matters because a distance total is
 * durable and user-visible: the sphere's systematic ~0.3% bias compounds to roughly 126 m
 * over a marathon. (ADR-0019)
 *
 * Vincenty rather than Karney: Karney is more robust, but correctly implementing it is far
 * more machinery than this needs. Vincenty's weakness is the near-antipodal case, where the
 * iteration converges slowly or not at all — a case that cannot arise between adjacent
 * points of a GPS track. When it does fail to converge this falls back to the spherical
 * approximation rather than returning NaN, so the function is total for every input.
 */
export function geodesicDistanceMeters(a: LatLng, b: LatLng): number {
  // Short-circuit before the iteration: identical points make sinSigma zero, and atan2(0, 0)
  // would take the algorithm somewhere it has no need to go.
  if (a.lat === b.lat && a.lng === b.lng) return 0;

  const f = WGS84_FLATTENING;
  const L = (b.lng - a.lng) * DEGREES_TO_RADIANS;

  const U1 = Math.atan((1 - f) * Math.tan(a.lat * DEGREES_TO_RADIANS));
  const U2 = Math.atan((1 - f) * Math.tan(b.lat * DEGREES_TO_RADIANS));
  const sinU1 = Math.sin(U1);
  const cosU1 = Math.cos(U1);
  const sinU2 = Math.sin(U2);
  const cosU2 = Math.cos(U2);

  let lambda = L;
  let sinSigma = 0;
  let cosSigma = 0;
  let sigma = 0;
  let cosSqAlpha = 0;
  let cos2SigmaM = 0;
  let converged = false;

  for (let iteration = 0; iteration < VINCENTY_MAX_ITERATIONS; iteration += 1) {
    const sinLambda = Math.sin(lambda);
    const cosLambda = Math.cos(lambda);

    sinSigma = Math.hypot(cosU2 * sinLambda, cosU1 * sinU2 - sinU1 * cosU2 * cosLambda);

    // Coincident after the ellipsoidal reduction — two positions that differ only below
    // the resolution the algorithm can express.
    if (sinSigma === 0) return 0;

    cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosLambda;
    sigma = Math.atan2(sinSigma, cosSigma);

    const sinAlpha = (cosU1 * cosU2 * sinLambda) / sinSigma;
    cosSqAlpha = 1 - sinAlpha * sinAlpha;

    // On an equatorial line cosSqAlpha is 0 and cos2SigmaM is undefined; the standard
    // treatment is to take it as 0, which the series below handles correctly.
    cos2SigmaM = cosSqAlpha === 0 ? 0 : cosSigma - (2 * sinU1 * sinU2) / cosSqAlpha;

    const C = (f / 16) * cosSqAlpha * (4 + f * (4 - 3 * cosSqAlpha));
    const previous = lambda;
    lambda =
      L +
      (1 - C) *
        f *
        sinAlpha *
        (sigma + C * sinSigma * (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM)));

    if (Math.abs(lambda - previous) < VINCENTY_CONVERGENCE) {
      converged = true;
      break;
    }
  }

  // Near-antipodal, and therefore not two adjacent points of a track. Degrade to the
  // sphere rather than returning NaN: a total function is worth more here than the last
  // fraction of a percent on a case the engine does not produce.
  if (!converged) return haversineDistanceMeters(a, b);

  const bSemi = WGS84_SEMI_MINOR_M;
  const uSq =
    (cosSqAlpha * (WGS84_SEMI_MAJOR_M * WGS84_SEMI_MAJOR_M - bSemi * bSemi)) / (bSemi * bSemi);

  const A = 1 + (uSq / 16384) * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)));
  const B = (uSq / 1024) * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)));

  const deltaSigma =
    B *
    sinSigma *
    (cos2SigmaM +
      (B / 4) *
        (cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM) -
          (B / 6) *
            cos2SigmaM *
            (-3 + 4 * sinSigma * sinSigma) *
            (-3 + 4 * cos2SigmaM * cos2SigmaM)));

  return bSemi * A * (sigma - deltaSigma);
}
