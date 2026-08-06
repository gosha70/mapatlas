// SPDX-License-Identifier: Apache-2.0
import type { TrackPoint } from "./types";
import { pathLengthMeters } from "./geo";
import { simplify } from "./simplify";

/** Default Douglas–Peucker tolerance (metres) used when finalizing a track. */
export const DEFAULT_SIMPLIFY_TOLERANCE_M = 5;

export interface FinalizedTrack {
  simplified: TrackPoint[];
  distanceM: number;
}

/**
 * Finalize a raw point stream: produce the simplified geometry (for render /
 * export) and the great-circle distance (metres) measured along it. Simplifying
 * first removes GPS jitter so the distance reflects the travelled path rather
 * than accumulated noise.
 */
export function finalizeTrack(
  points: TrackPoint[],
  toleranceM: number = DEFAULT_SIMPLIFY_TOLERANCE_M,
): FinalizedTrack {
  const simplified = simplify(points, toleranceM);
  return { simplified, distanceM: pathLengthMeters(simplified) };
}
