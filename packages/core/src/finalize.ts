// SPDX-License-Identifier: Apache-2.0

import { newId } from "./ids.js";
import { simplify } from "./simplify.js";
import { computeStats, resolveStatsPolicy, segmentPoints } from "./stats.js";
import type { StatsPolicy } from "./stats.js";
import type { Track } from "./track.js";
import { assertValidTrackGeometry } from "./validate.js";

export interface FinalizePolicy extends StatsPolicy {
  /**
   * Douglas–Peucker tolerance for `simplifiedSegments`, in metres. Affects rendering only:
   * the cache is derived, never exported, and can be regenerated at any tolerance.
   */
  simplifyToleranceM: number;
}

/** Loose enough to shed GPS jitter, tight enough that a rendered line still looks like the route. */
export const DEFAULT_SIMPLIFY_TOLERANCE_M = 5;

export const DEFAULT_FINALIZE_POLICY: Readonly<FinalizePolicy> = Object.freeze({
  ...resolveStatsPolicy(),
  simplifyToleranceM: DEFAULT_SIMPLIFY_TOLERANCE_M,
});

export function resolveFinalizePolicy(partial?: Partial<FinalizePolicy>): FinalizePolicy {
  return { ...DEFAULT_FINALIZE_POLICY, ...partial };
}

/**
 * Turn a track's canonical geometry into a finalized track: validated, simplified for
 * rendering, and with statistics derived.
 *
 * The single canonicalization step shared by recording, authoring and import, so all three
 * produce tracks that are identical in shape and computed the same way — a hand-drawn trip
 * and a recorded one differ only in `origin`. (ADR-0014)
 *
 * **Validation happens before any derivation** (ADR-0020). This either returns a wholly
 * valid track or throws having computed nothing, and it never modifies its input: the
 * returned track is a new object, and a caller that catches the error still holds exactly
 * what it passed in.
 *
 * Simplification is mapped **per segment**, which is where pause semantics live — `simplify`
 * itself knows nothing about them, and running it across the concatenated points would
 * smooth straight through a gap. (ADR-0018)
 */
export function finalizeTrack(
  track: Pick<Track, "points" | "segments"> & Partial<Track>,
  policy?: Partial<FinalizePolicy>,
): Track {
  assertValidTrackGeometry(track);

  const { simplifyToleranceM, ...statsPolicy } = resolveFinalizePolicy(policy);

  const simplifiedSegments = track.segments.map((segment) =>
    simplify(segmentPoints(track.points, segment), simplifyToleranceM),
  );

  const stats = computeStats(track, statsPolicy);

  const firstPoint = track.points[0];
  const lastPoint = track.points[track.points.length - 1];

  const finalized: Track = {
    ...track,
    id: track.id ?? newId(),
    startedAt: track.startedAt ?? firstPoint?.t ?? 0,
    status: "finalized",
    origin: track.origin ?? "recorded",
    points: track.points,
    segments: track.segments,
    simplifiedSegments,
    stats,
  };

  // Assigned rather than spread conditionally: `exactOptionalPropertyTypes` means an
  // absent `endedAt` and one explicitly set to undefined are different things, and only
  // the former is what an unfinished track should look like.
  const endedAt = track.endedAt ?? lastPoint?.t;
  if (endedAt !== undefined) finalized.endedAt = endedAt;

  return finalized;
}
