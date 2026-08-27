// SPDX-License-Identifier: Apache-2.0

import type { Track, TrackPoint, TrackSegment } from "./track.js";

/**
 * Validation of the canonical track invariants, run **before** anything is derived.
 *
 * `finalizeTrack` either produces a wholly valid finalized track or throws having derived
 * nothing — no half-computed stats, no partial simplification. A caller that catches the
 * error still holds exactly the input it passed in.
 *
 * Why validate rather than repair: `finalizeTrack` is the one canonicalization step shared
 * by recorded, authored and imported tracks, and silently sorting points there would change
 * geometry semantics. Segment and lap ranges index the original point order, and sensor
 * samples are attached to specific points, so reordering to fix time would corrupt the
 * route. A fix arriving out of order may also be a genuinely stale GPS observation rather
 * than an array-order mistake, and only the recorder knows which. So the layers divide:
 * `sample()` observes and reports negative elapsed times without judging them,
 * `recorder-web` drops a stale fix before it is ever kept, `TrackDraft` catches bad timing
 * before `toTrack()`, import surfaces malformed order rather than rewriting it, and this is
 * where the canonical invariant is enforced. (ADR-0020)
 */

/** A point's timestamp precedes its predecessor's. Time may stall, but never run backwards. */
export class TrackTemporalOrderError extends Error {
  readonly previousIndex: number;
  readonly index: number;
  readonly previousT: number;
  readonly t: number;

  constructor(previousIndex: number, index: number, previousT: number, t: number) {
    super(
      `track timestamps run backwards: points[${index}].t (${t}) precedes ` +
        `points[${previousIndex}].t (${previousT}), by ${previousT - t} ms`,
    );
    this.name = "TrackTemporalOrderError";
    this.previousIndex = previousIndex;
    this.index = index;
    this.previousT = previousT;
    this.t = t;
  }
}

/** A segment's range does not describe a real span of the point array. */
export class TrackSegmentRangeError extends Error {
  readonly segmentIndex: number;
  readonly segmentId: string;

  constructor(segmentIndex: number, segmentId: string, detail: string) {
    super(`segments[${segmentIndex}] (${segmentId}) is not a valid range: ${detail}`);
    this.name = "TrackSegmentRangeError";
    this.segmentIndex = segmentIndex;
    this.segmentId = segmentId;
  }
}

/**
 * Timestamps must be **non-decreasing**: `points[i].t >= points[i - 1].t`.
 *
 * Equal milliseconds are degenerate but not corrupt — two fixes can legitimately share a
 * millisecond, and an imported file often rounds to the second — so only a strict decrease
 * throws. `computeStats` is responsible for not deriving an instantaneous speed from a pair
 * whose `dt` is zero.
 *
 * Checked within each segment, never across a boundary: the gap between two segments is a
 * pause, and expecting continuity across it would be a category error.
 */
function assertTemporalOrder(
  points: readonly TrackPoint[],
  segments: readonly TrackSegment[],
): void {
  for (const segment of segments) {
    for (let i = segment.startIndex + 1; i <= segment.endIndex; i += 1) {
      const previous = points[i - 1];
      const current = points[i];
      if (previous === undefined || current === undefined) continue;
      if (current.t < previous.t) {
        throw new TrackTemporalOrderError(i - 1, i, previous.t, current.t);
      }
    }
  }
}

/**
 * Segment ranges must actually describe the point array: within bounds, not inverted, and
 * not overlapping a neighbour. A malformed range would silently produce wrong geometry and
 * wrong statistics, so it fails closed here rather than being interpreted charitably.
 */
function assertSegmentRanges(
  points: readonly TrackPoint[],
  segments: readonly TrackSegment[],
): void {
  let previousEnd = -1;

  for (const [index, segment] of segments.entries()) {
    const { startIndex, endIndex } = segment;

    if (!Number.isInteger(startIndex) || !Number.isInteger(endIndex)) {
      throw new TrackSegmentRangeError(index, segment.id, "indices must be integers");
    }
    if (startIndex < 0 || endIndex >= points.length) {
      throw new TrackSegmentRangeError(
        index,
        segment.id,
        `[${startIndex}, ${endIndex}] falls outside points[0, ${points.length - 1}]`,
      );
    }
    if (endIndex < startIndex) {
      throw new TrackSegmentRangeError(
        index,
        segment.id,
        `[${startIndex}, ${endIndex}] is inverted`,
      );
    }
    if (startIndex <= previousEnd) {
      throw new TrackSegmentRangeError(
        index,
        segment.id,
        `starts at ${startIndex}, inside the preceding segment which ends at ${previousEnd}`,
      );
    }

    previousEnd = endIndex;
  }
}

/** A point belongs to no segment, so nothing describes when it was recorded. */
export class TrackCoverageError extends Error {
  readonly unclaimedIndex: number;

  constructor(unclaimedIndex: number, detail: string) {
    super(`points[${unclaimedIndex}] belongs to no segment: ${detail}`);
    this.name = "TrackCoverageError";
    this.unclaimedIndex = unclaimedIndex;
  }
}

/**
 * Segments must cover every point, contiguously, from the first to the last.
 *
 * A point outside every segment has no meaning: a segment is a span of *active* recording
 * and the gap between two is a pause, during which nothing is kept. An unclaimed point is
 * therefore either a construction bug or data that no statistic will count and no renderer
 * will draw — and it would vanish silently on export, since interchange is segmented
 * geometry. Failing closed here makes losslessness a property of the model rather than
 * something export has to work around.
 */
function assertSegmentsCoverPoints(
  points: readonly TrackPoint[],
  segments: readonly TrackSegment[],
): void {
  if (points.length === 0) {
    if (segments.length > 0) throw new TrackCoverageError(0, "the track has no points at all");
    return;
  }

  if (segments.length === 0) {
    throw new TrackCoverageError(0, "the track has points but no segments");
  }

  let expected = 0;
  for (const segment of segments) {
    if (segment.startIndex !== expected) {
      throw new TrackCoverageError(
        expected,
        `the next segment starts at ${segment.startIndex}, leaving a gap`,
      );
    }
    expected = segment.endIndex + 1;
  }

  if (expected !== points.length) {
    throw new TrackCoverageError(expected, "it falls after the last segment ends");
  }
}

/**
 * Assert every invariant a finalized track must satisfy. Throws on the first violation and
 * never modifies the input.
 */
export function assertValidTrackGeometry(track: Pick<Track, "points" | "segments">): void {
  assertSegmentRanges(track.points, track.segments);
  assertSegmentsCoverPoints(track.points, track.segments);
  assertTemporalOrder(track.points, track.segments);
}
