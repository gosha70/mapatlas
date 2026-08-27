// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import type { ChannelDescriptor } from "./channels.js";
import { newId } from "./ids.js";
import {
  DEFAULT_ELEVATION_HYSTERESIS_M,
  DEFAULT_STATS_POLICY,
  computeStats,
  resolveStatsPolicy,
} from "./stats.js";
import type { Track, TrackPoint, TrackSegment } from "./track.js";

const T0 = 1_700_000_000_000;
const ORIGIN = { lat: 59.33, lng: 18.06 };
const DEG_PER_M = 1 / 111_195;

/** A point `north` metres along, at `afterMs`, optionally with altitude and channels. */
function at(north: number, afterMs: number, extra: Partial<TrackPoint> = {}): TrackPoint {
  return { lat: ORIGIN.lat + north * DEG_PER_M, lng: ORIGIN.lng, t: T0 + afterMs, ...extra };
}

const wholeTrack = (points: TrackPoint[]): TrackSegment[] => [
  { id: newId(), startIndex: 0, endIndex: points.length - 1, startedAt: points[0]?.t ?? T0 },
];

/** A track from a run of altitudes, one point every 10 m and 10 s. */
function altitudeTrack(altitudes: number[]): Pick<Track, "points" | "segments" | "channels"> {
  const points = altitudes.map((altitudeM, i) => at(i * 10, i * 10_000, { altitudeM }));
  return { points, segments: wholeTrack(points) };
}

describe("elevation: rolling hysteresis, not pairwise", () => {
  it("reports a steady climb that no single step could clear", () => {
    // The case pairwise thresholding gets wrong: six 1 m steps under a 5 m deadband would
    // report zero, because no individual step exceeds the bar. The trend is real.
    const stats = computeStats(altitudeTrack([100, 101, 102, 103, 104, 105, 106]));
    expect(stats.elevationGainM).toBeCloseTo(6, 6);
    expect(stats.elevationLossM).toBeCloseTo(0, 6);
  });

  it("reports nothing for oscillation that never establishes a trend", () => {
    const stats = computeStats(altitudeTrack([100, 103, 98, 102, 99, 101, 97, 100]));
    expect(stats.elevationGainM).toBeCloseTo(0, 6);
    expect(stats.elevationLossM).toBeCloseTo(0, 6);
  });

  it("reports ~0 for a flat route carrying ±3-4 m of GPS noise", () => {
    const noisy = Array.from({ length: 200 }, (_, i) => 100 + Math.sin(i * 1.7) * 3.5);
    const stats = computeStats(altitudeTrack(noisy));
    expect(stats.elevationGainM).toBeLessThan(3);
    expect(stats.elevationLossM).toBeLessThan(3);
  });

  it("reports a gradual 100 m climb taken in 1 m steps", () => {
    const climb = Array.from({ length: 101 }, (_, i) => 100 + i);
    const stats = computeStats(altitudeTrack(climb));
    expect(stats.elevationGainM).toBeCloseTo(100, 6);
    expect(stats.elevationLossM).toBeCloseTo(0, 6);
  });

  it("reports both directions of a climb and descent", () => {
    const up = Array.from({ length: 101 }, (_, i) => 100 + i);
    const down = Array.from({ length: 100 }, (_, i) => 199 - i);
    const stats = computeStats(altitudeTrack([...up, ...down]));
    expect(stats.elevationGainM).toBeCloseTo(100, 6);
    expect(stats.elevationLossM).toBeCloseTo(100, 6);
  });

  it("stays close to the real climb when noise is superimposed on it", () => {
    const noisyClimb = Array.from({ length: 201 }, (_, i) => 100 + i * 0.5 + Math.sin(i * 2.1) * 3);
    const stats = computeStats(altitudeTrack(noisyClimb));
    // The underlying rise is 100 m. Noise must not inflate it much, nor suppress it.
    expect(stats.elevationGainM).toBeGreaterThan(95);
    expect(stats.elevationLossM).toBeLessThan(10);
  });

  it("captures a climb that never reverses — walking uphill and stopping at the top", () => {
    const stats = computeStats(altitudeTrack([100, 120, 140, 160]));
    expect(stats.elevationGainM).toBeCloseTo(60, 6);
  });

  it("records min and max altitude regardless of the deadband", () => {
    const stats = computeStats(altitudeTrack([100, 103, 98, 102]));
    expect(stats.minAltitudeM).toBe(98);
    expect(stats.maxAltitudeM).toBe(103);
  });
});

describe("elevation: the deadband is a policy", () => {
  it("defaults to 5 m", () => {
    expect(DEFAULT_STATS_POLICY.elevationHysteresisM).toBe(5);
    expect(DEFAULT_ELEVATION_HYSTERESIS_M).toBe(5);
    expect(Object.isFrozen(DEFAULT_STATS_POLICY)).toBe(true);
  });

  it("accumulates raw movement at 0, for pre-smoothed sources", () => {
    const stats = computeStats(altitudeTrack([100, 101, 100, 101]), { elevationHysteresisM: 0 });
    expect(stats.elevationGainM).toBeCloseTo(2, 6);
    expect(stats.elevationLossM).toBeCloseTo(1, 6);
  });

  it("lets a barometric consumer tighten it and a noisy one loosen it", () => {
    const wobble = altitudeTrack([100, 104, 100, 104, 100]);
    expect(computeStats(wobble, { elevationHysteresisM: 2 }).elevationGainM).toBeGreaterThan(4);
    expect(computeStats(wobble, { elevationHysteresisM: 10 }).elevationGainM).toBeCloseTo(0, 6);
  });

  it("fills a partial policy from the defaults", () => {
    expect(resolveStatsPolicy()).toEqual(DEFAULT_STATS_POLICY);
    expect(resolveStatsPolicy({ elevationHysteresisM: 1 })).toEqual({ elevationHysteresisM: 1 });
  });
});

describe("elevation: missing and segmented data", () => {
  it("skips points with no altitude rather than fabricating a transition", () => {
    const points = [
      at(0, 0, { altitudeM: 100 }),
      at(10, 10_000),
      at(20, 20_000),
      at(30, 30_000, { altitudeM: 110 }),
    ];
    const stats = computeStats({ points, segments: wholeTrack(points) });
    expect(stats.elevationGainM).toBeCloseTo(10, 6);
  });

  it("reports no altitude fields at all when no point carries one", () => {
    const points = [at(0, 0), at(10, 10_000)];
    const stats = computeStats({ points, segments: wholeTrack(points) });
    expect(stats.elevationGainM).toBeUndefined();
    expect(stats.minAltitudeM).toBeUndefined();
  });

  it("does not bridge a pause: no gain is invented across a segment boundary", () => {
    // 100 m up in the first segment, then the recording pauses and resumes 500 m lower.
    // The drop happened while paused and is not a descent the user made.
    const points = [
      at(0, 0, { altitudeM: 100 }),
      at(50, 50_000, { altitudeM: 200 }),
      at(1000, 3_600_000, { altitudeM: 700 }),
      at(1050, 3_650_000, { altitudeM: 800 }),
    ];
    const segments: TrackSegment[] = [
      { id: newId(), startIndex: 0, endIndex: 1, startedAt: T0 },
      { id: newId(), startIndex: 2, endIndex: 3, startedAt: T0 + 3_600_000 },
    ];
    const stats = computeStats({ points, segments });
    // 100 m in each segment, and nothing for the 500 m step across the gap.
    expect(stats.elevationGainM).toBeCloseTo(200, 6);
  });
});

describe("distance and time", () => {
  it("sums leg distances within a segment", () => {
    const points = [at(0, 0), at(100, 10_000), at(200, 20_000)];
    const stats = computeStats({ points, segments: wholeTrack(points) });
    expect(stats.distanceM).toBeCloseTo(200, 0);
  });

  it("does not bridge a pause", () => {
    const points = [at(0, 0), at(100, 10_000), at(5000, 3_600_000), at(5100, 3_610_000)];
    const segments: TrackSegment[] = [
      { id: newId(), startIndex: 0, endIndex: 1, startedAt: T0 },
      { id: newId(), startIndex: 2, endIndex: 3, startedAt: T0 + 3_600_000 },
    ];
    const stats = computeStats({ points, segments });
    // 100 m + 100 m, not the 4.9 km straight line across the gap.
    expect(stats.distanceM).toBeCloseTo(200, 0);
  });

  it("separates elapsed time from moving time", () => {
    const points = [at(0, 0), at(100, 10_000), at(5000, 3_600_000), at(5100, 3_610_000)];
    const segments: TrackSegment[] = [
      { id: newId(), startIndex: 0, endIndex: 1, startedAt: T0 },
      { id: newId(), startIndex: 2, endIndex: 3, startedAt: T0 + 3_600_000 },
    ];
    const stats = computeStats({ points, segments });
    expect(stats.durationMs).toBe(3_610_000);
    expect(stats.movingTimeMs).toBe(20_000);
    expect(stats.movingTimeMs).toBeLessThan(stats.durationMs);
  });

  it("derives average speed from moving time, not elapsed", () => {
    const points = [at(0, 0), at(100, 10_000)];
    const stats = computeStats({ points, segments: wholeTrack(points) });
    expect(stats.avgSpeedMps).toBeCloseTo(10, 1);
  });

  it("ignores a zero-duration pair rather than reporting infinite speed", () => {
    // Two fixes sharing a millisecond: permitted by the non-decreasing invariant (ADR-0020)
    // and exactly the pair that would divide by zero.
    const points = [at(0, 0), at(50, 0), at(100, 10_000)];
    const stats = computeStats({ points, segments: wholeTrack(points) });
    expect(Number.isFinite(stats.maxSpeedMps ?? 0)).toBe(true);
    expect(stats.maxSpeedMps).toBeLessThan(100);
  });

  it("reports no speed at all when every pair is zero-duration", () => {
    const points = [at(0, 0), at(50, 0)];
    const stats = computeStats({ points, segments: wholeTrack(points) });
    expect(stats.maxSpeedMps).toBeUndefined();
    expect(stats.avgSpeedMps).toBeUndefined();
  });

  it("returns zeroes for an empty track rather than NaN", () => {
    const stats = computeStats({ points: [], segments: [] });
    expect(stats).toEqual({ distanceM: 0, durationMs: 0, movingTimeMs: 0 });
  });
});

describe("channel roll-ups", () => {
  const heartRate: ChannelDescriptor = {
    key: "heartRateBpm",
    label: "Heart rate",
    unit: "bpm",
    aggregate: "avg",
  };

  it("summarises a declared channel", () => {
    const values = [120, 140, 160, 180];
    const points = values.map((v, i) => at(i * 10, i * 10_000, { channels: { heartRateBpm: v } }));
    const stats = computeStats({ points, segments: wholeTrack(points), channels: [heartRate] });

    expect(stats.channels?.heartRateBpm).toEqual({
      min: 120,
      max: 180,
      avg: 150,
      sum: 600,
      last: 180,
      count: 4,
    });
  });

  it("ignores points where the channel is absent", () => {
    const points = [
      at(0, 0, { channels: { heartRateBpm: 100 } }),
      at(10, 10_000),
      at(20, 20_000, { channels: { heartRateBpm: 200 } }),
    ];
    const stats = computeStats({ points, segments: wholeTrack(points), channels: [heartRate] });
    expect(stats.channels?.heartRateBpm?.count).toBe(2);
    expect(stats.channels?.heartRateBpm?.avg).toBe(150);
  });

  it("reports nothing for a declared channel with no data", () => {
    const points = [at(0, 0), at(10, 10_000)];
    const stats = computeStats({ points, segments: wholeTrack(points), channels: [heartRate] });
    expect(stats.channels).toBeUndefined();
  });

  it("ignores an undeclared channel — descriptors are what make a channel real", () => {
    const points = [at(0, 0, { channels: { undeclared: 42 } })];
    const stats = computeStats({ points, segments: wholeTrack(points), channels: [heartRate] });
    expect(stats.channels).toBeUndefined();
  });
});

describe("purity", () => {
  it("never modifies the track it is given", () => {
    const points = [at(0, 0, { altitudeM: 100 }), at(100, 10_000, { altitudeM: 150 })];
    const track = { points, segments: wholeTrack(points) };
    const before = structuredClone(track);
    computeStats(track);
    expect(track).toEqual(before);
  });
});
