// SPDX-License-Identifier: Apache-2.0

import type { TrackPoint } from "./types.js";
import { polylineLengthM } from "./geo.js";
import { simplify } from "./simplify.js";

/** Default simplification tolerance (meters) used by `finalizeTrack`. */
export const DEFAULT_SIMPLIFY_TOLERANCE_M = 10;

export interface FinalizedTrack {
  /** Douglas–Peucker output for render/export */
  simplified: TrackPoint[];
  /** total haversine length of the raw points, in meters */
  distanceM: number;
}

/**
 * Finalize a set of kept points (tasks T1.4): produce the simplified polyline
 * and the total distance.
 *
 * Distance is measured over the *raw* points (not the simplified line) so it
 * reflects the true traveled length; simplification is for rendering/export.
 */
export function finalizeTrack(
  points: readonly TrackPoint[],
  toleranceM: number = DEFAULT_SIMPLIFY_TOLERANCE_M,
): FinalizedTrack {
  return {
    simplified: simplify(points, toleranceM),
    distanceM: polylineLengthM(points),
  };
}
