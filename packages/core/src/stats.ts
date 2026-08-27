// SPDX-License-Identifier: Apache-2.0

import type { ChannelDescriptor, ChannelStats } from "./channels.js";
import { geodesicDistanceMeters } from "./geo.js";
import type { Track, TrackLap, TrackPoint, TrackSegment, TrackStats } from "./track.js";

/**
 * Knobs for derived statistics. A policy rather than a constant because the right value
 * depends on where the altitude came from, and the engine does not know: phone GPS,
 * barometric altimeter, imported FIT/GPX, and DEM-derived elevation have very different
 * noise. Seams over features. (ADR-0021)
 */
export interface StatsPolicy {
  /**
   * Vertical deadband for elevation gain and loss, in metres. `0` disables filtering and
   * accumulates raw movement.
   *
   * Rough guidance for a consumer that knows its source: 1–3 m for barometric, 5 m for
   * ordinary phone GPS, 8–10 m for a known-noisy device, 0 for pre-smoothed DEM data.
   */
  elevationHysteresisM: number;
}

/**
 * Conservative by design. Consumer GPS altitude oscillates by several metres while
 * stationary, and a smaller deadband manufactures climb from that noise — a flat route can
 * accumulate hundreds of metres of invented ascent.
 */
export const DEFAULT_ELEVATION_HYSTERESIS_M = 5;

export const DEFAULT_STATS_POLICY: Readonly<StatsPolicy> = Object.freeze({
  elevationHysteresisM: DEFAULT_ELEVATION_HYSTERESIS_M,
});

export function resolveStatsPolicy(partial?: Partial<StatsPolicy>): StatsPolicy {
  return { ...DEFAULT_STATS_POLICY, ...partial };
}

/**
 * Elevation gain and loss over one run of altitudes, with rolling hysteresis.
 *
 * The filter is trend-aware, not pairwise. Pairwise thresholding — "count a step only if it
 * exceeds the deadband" — reports zero for a steady climb of 100 m taken in 1 m steps,
 * because no single step clears the bar. This instead tracks the extreme reached since the
 * last confirmed turning point and commits a leg only when the altitude reverses by more
 * than the deadband, which is what distinguishes a real trend from oscillation.
 *
 * So `100, 101, 102, 103, 104, 105, 106` yields 6 m of gain at a 5 m deadband, while
 * `100, 103, 98, 102, 99, 101, 97, 100` yields nothing: the first is a trend, the second
 * never travels far enough from its anchor to confirm one.
 */
function elevationChange(
  altitudes: readonly number[],
  hysteresisM: number,
): { gainM: number; lossM: number } {
  const first = altitudes[0];
  if (first === undefined) return { gainM: 0, lossM: 0 };

  let gainM = 0;
  let lossM = 0;

  /** The last confirmed turning point: everything is measured from here. */
  let anchor = first;
  /** Direction of the leg in progress, once one is confirmed. */
  let direction: "up" | "down" | "unknown" = "unknown";
  /** The extreme reached since the anchor, in the direction of the current leg. */
  let extreme = first;
  /** While direction is unknown, both extremes are candidates. */
  let highest = first;
  let lowest = first;

  for (let i = 1; i < altitudes.length; i += 1) {
    const altitude = altitudes[i];
    if (altitude === undefined) continue;

    if (direction === "unknown") {
      highest = Math.max(highest, altitude);
      lowest = Math.min(lowest, altitude);

      if (highest - anchor >= hysteresisM && highest > anchor) {
        direction = "up";
        extreme = highest;
      } else if (anchor - lowest >= hysteresisM && lowest < anchor) {
        direction = "down";
        extreme = lowest;
      }
      continue;
    }

    if (direction === "up") {
      if (altitude > extreme) {
        extreme = altitude;
      } else if (extreme - altitude >= hysteresisM && extreme > altitude) {
        // Confirmed reversal: bank the climb we just finished and start descending.
        gainM += extreme - anchor;
        anchor = extreme;
        direction = "down";
        extreme = altitude;
      }
      continue;
    }

    if (altitude < extreme) {
      extreme = altitude;
    } else if (altitude - extreme >= hysteresisM && altitude > extreme) {
      lossM += anchor - extreme;
      anchor = extreme;
      direction = "up";
      extreme = altitude;
    }
  }

  // Flush the leg still in progress. Without this a climb that never reverses — walking up
  // a hill and stopping at the top — would report nothing at all.
  if (direction === "up") gainM += extreme - anchor;
  else if (direction === "down") lossM += anchor - extreme;

  return { gainM, lossM };
}

function rollUpChannel(values: readonly number[], descriptor: ChannelDescriptor): ChannelStats {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let sum = 0;

  for (const value of values) {
    min = Math.min(min, value);
    max = Math.max(max, value);
    sum += value;
  }

  const count = values.length;
  const last = values[count - 1];

  // `aggregate` describes how a consumer wants the channel summarised; every component is
  // reported regardless, so a renderer can show the average of a heart rate and the sum of
  // something cumulative without the engine deciding which is meaningful.
  void descriptor;

  return {
    min,
    max,
    avg: sum / count,
    sum,
    ...(last === undefined ? {} : { last }),
    count,
  };
}

/**
 * Derive statistics from a valid track. Every quantity is computed **per segment and summed**,
 * never across a pause: a boat that drifts for an hour between two casts has not travelled
 * the straight line between them, and neither its distance nor its climb should say so.
 *
 * Assumes the geometry invariants already hold — `finalizeTrack` validates before calling
 * this (ADR-0020).
 */
export function computeStats(
  track: Pick<Track, "points" | "segments" | "channels">,
  policy?: Partial<StatsPolicy>,
): TrackStats {
  const { elevationHysteresisM } = resolveStatsPolicy(policy);
  const { points, segments } = track;

  let distanceM = 0;
  let movingTimeMs = 0;
  let maxSpeedMps = 0;
  let sawSpeed = false;
  let elevationGainM = 0;
  let elevationLossM = 0;
  let minAltitudeM = Number.POSITIVE_INFINITY;
  let maxAltitudeM = Number.NEGATIVE_INFINITY;
  let sawAltitude = false;

  const channelValues = new Map<string, number[]>();
  for (const descriptor of track.channels ?? []) channelValues.set(descriptor.key, []);

  for (const segment of segments) {
    const altitudes: number[] = [];

    for (let i = segment.startIndex; i <= segment.endIndex; i += 1) {
      const point = points[i];
      if (point === undefined) continue;

      if (point.altitudeM !== undefined) {
        altitudes.push(point.altitudeM);
        minAltitudeM = Math.min(minAltitudeM, point.altitudeM);
        maxAltitudeM = Math.max(maxAltitudeM, point.altitudeM);
        sawAltitude = true;
      }

      for (const [key, collected] of channelValues) {
        const value = point.channels?.[key];
        if (value !== undefined) collected.push(value);
      }

      if (i === segment.startIndex) continue;

      const previous = points[i - 1];
      if (previous === undefined) continue;

      const legM = geodesicDistanceMeters(previous, point);
      distanceM += legM;

      // Guard the degenerate pair the non-decreasing invariant permits: two fixes sharing a
      // millisecond would otherwise divide by zero and report infinite speed. (ADR-0020)
      const legMs = point.t - previous.t;
      if (legMs > 0) {
        maxSpeedMps = Math.max(maxSpeedMps, legM / (legMs / 1000));
        sawSpeed = true;
      }
    }

    const start = points[segment.startIndex];
    const end = points[segment.endIndex];
    if (start !== undefined && end !== undefined) movingTimeMs += end.t - start.t;

    const { gainM, lossM } = elevationChange(altitudes, elevationHysteresisM);
    elevationGainM += gainM;
    elevationLossM += lossM;
  }

  const firstPoint = points[0];
  const lastPoint = points[points.length - 1];
  const durationMs =
    firstPoint === undefined || lastPoint === undefined ? 0 : lastPoint.t - firstPoint.t;

  const channels: Record<string, ChannelStats> = {};
  for (const descriptor of track.channels ?? []) {
    const values = channelValues.get(descriptor.key);
    if (values !== undefined && values.length > 0) {
      channels[descriptor.key] = rollUpChannel(values, descriptor);
    }
  }

  return {
    distanceM,
    durationMs,
    movingTimeMs,
    ...(movingTimeMs > 0 ? { avgSpeedMps: distanceM / (movingTimeMs / 1000) } : {}),
    ...(sawSpeed ? { maxSpeedMps } : {}),
    ...(sawAltitude ? { elevationGainM, elevationLossM, minAltitudeM, maxAltitudeM } : {}),
    ...(Object.keys(channels).length > 0 ? { channels } : {}),
  };
}

/**
 * Statistics for one lap, computed over that lap's own span.
 *
 * A lap may cross a pause, so its segments are the track's segments clipped to the lap's
 * range; the points are sliced and the ranges rebased, which is what makes `durationMs`
 * describe the lap rather than the whole track.
 */
export function computeLapStats(
  track: Pick<Track, "points" | "segments" | "channels">,
  lap: Pick<TrackLap, "startIndex" | "endIndex">,
  policy?: Partial<StatsPolicy>,
): TrackStats {
  const points = track.points.slice(lap.startIndex, lap.endIndex + 1);

  const segments: TrackSegment[] = [];
  for (const segment of track.segments) {
    const startIndex = Math.max(segment.startIndex, lap.startIndex);
    const endIndex = Math.min(segment.endIndex, lap.endIndex);
    if (endIndex < startIndex) continue;

    const start = track.points[startIndex];
    segments.push({
      id: segment.id,
      startIndex: startIndex - lap.startIndex,
      endIndex: endIndex - lap.startIndex,
      startedAt: start?.t ?? segment.startedAt,
    });
  }

  return computeStats(
    { points, segments, ...(track.channels === undefined ? {} : { channels: track.channels }) },
    policy,
  );
}

/** Segment-local view of the points, used by `finalizeTrack` when simplifying. */
export function segmentPoints(points: readonly TrackPoint[], segment: TrackSegment): TrackPoint[] {
  return points.slice(segment.startIndex, segment.endIndex + 1);
}
