// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import type { ChannelDescriptor } from "./channels.js";
import { finalizeTrack } from "./finalize.js";
import type { LapInput } from "./finalize.js";
import { newId } from "./ids.js";
import { computeLapStats } from "./stats.js";
import type { Track, TrackPoint, TrackSegment } from "./track.js";
import { TrackLapRangeError } from "./validate.js";

const T0 = 1_700_000_000_000;
const ORIGIN = { lat: 59.33, lng: 18.06 };
const DEG_PER_M = 1 / 111_195;

const at = (north: number, afterMs: number, extra: Partial<TrackPoint> = {}): TrackPoint => ({
  lat: ORIGIN.lat + north * DEG_PER_M,
  lng: ORIGIN.lng,
  t: T0 + afterMs,
  ...extra,
});

const HEART_RATE: ChannelDescriptor = {
  key: "heartRateBpm",
  label: "Heart rate",
  unit: "bpm",
  aggregate: "avg",
};

/**
 * Six points in two segments: 0-2 recorded over 20 s, then an hour's pause, then 3-5 over
 * another 20 s. Every leg is 100 m, and altitude climbs 10 m per point within a segment.
 */
function pausedTrack(): Pick<Track, "points" | "segments" | "channels"> {
  const points = [
    at(0, 0, { altitudeM: 100, channels: { heartRateBpm: 110 } }),
    at(100, 10_000, { altitudeM: 110, channels: { heartRateBpm: 120 } }),
    at(200, 20_000, { altitudeM: 120, channels: { heartRateBpm: 130 } }),
    at(5000, 3_600_000, { altitudeM: 500, channels: { heartRateBpm: 140 } }),
    at(5100, 3_610_000, { altitudeM: 510, channels: { heartRateBpm: 150 } }),
    at(5200, 3_620_000, { altitudeM: 520, channels: { heartRateBpm: 160 } }),
  ];
  const segments: TrackSegment[] = [
    { id: newId(), startIndex: 0, endIndex: 2, startedAt: T0 },
    { id: newId(), startIndex: 3, endIndex: 5, startedAt: T0 + 3_600_000 },
  ];
  return { points, segments, channels: [HEART_RATE] };
}

describe("a lap wholly inside one segment", () => {
  it("measures only its own span, not the track's", () => {
    const track = pausedTrack();
    const lap = computeLapStats(track, { startIndex: 0, endIndex: 2 });

    expect(lap.distanceM).toBeCloseTo(200, 0);
    expect(lap.durationMs).toBe(20_000);
    expect(lap.movingTimeMs).toBe(20_000);
  });

  it("measures a lap that is a strict subset of a segment", () => {
    const track = pausedTrack();
    const lap = computeLapStats(track, { startIndex: 1, endIndex: 2 });

    expect(lap.distanceM).toBeCloseTo(100, 0);
    expect(lap.durationMs).toBe(10_000);
  });

  it("handles a single-point lap without dividing by zero", () => {
    const lap = computeLapStats(pausedTrack(), { startIndex: 2, endIndex: 2 });

    expect(lap.distanceM).toBe(0);
    expect(lap.durationMs).toBe(0);
    expect(lap.movingTimeMs).toBe(0);
    expect(lap.avgSpeedMps).toBeUndefined();
  });

  it("rolls up only the channel values inside the lap", () => {
    const lap = computeLapStats(pausedTrack(), { startIndex: 0, endIndex: 1 });

    expect(lap.channels?.["heartRateBpm"]).toEqual({
      min: 110,
      max: 120,
      avg: 115,
      sum: 230,
      last: 120,
      count: 2,
    });
  });
});

describe("a lap crossing a pause", () => {
  it("counts elapsed time across the pause but not distance", () => {
    // The clipping this exists for. Elapsed time spans the gap because it genuinely
    // elapsed; distance and moving time do not, because nothing was recorded during it and
    // the straight line across is not something anyone travelled.
    const track = pausedTrack();
    const lap = computeLapStats(track, { startIndex: 1, endIndex: 4 });

    expect(lap.durationMs).toBe(3_600_000 - 10_000 + 10_000); // point 1 to point 4
    expect(lap.distanceM).toBeCloseTo(200, 0); // 100 m before the pause, 100 m after
    expect(lap.movingTimeMs).toBe(20_000); // 10 s each side, never the hour between
  });

  it("does not bridge the pause in distance even when spanning both segments entirely", () => {
    const track = pausedTrack();
    const lap = computeLapStats(track, { startIndex: 0, endIndex: 5 });
    const whole = finalizeTrack(track).stats;

    // A lap covering everything must agree with the track covering everything.
    expect(lap.distanceM).toBeCloseTo(whole?.distanceM ?? -1, 6);
    expect(lap.movingTimeMs).toBe(whole?.movingTimeMs);
    expect(lap.durationMs).toBe(whole?.durationMs);
  });

  it("does not invent elevation gain across the pause", () => {
    // 20 m climbed in segment one, 20 m in segment two; the 380 m step happened while the
    // recording was stopped and is not a climb the user made.
    const lap = computeLapStats(
      pausedTrack(),
      { startIndex: 0, endIndex: 5 },
      { elevationHysteresisM: 0 },
    );

    expect(lap.elevationGainM).toBeCloseTo(40, 6);
  });

  it("reports a lap lying entirely in the second segment", () => {
    const lap = computeLapStats(pausedTrack(), { startIndex: 3, endIndex: 5 });

    expect(lap.distanceM).toBeCloseTo(200, 0);
    expect(lap.durationMs).toBe(20_000);
    expect(lap.channels?.["heartRateBpm"]?.min).toBe(140);
  });
});

describe("policy propagation", () => {
  function climbTrack(): Pick<Track, "points" | "segments" | "channels"> {
    // Six 1 m steps: a real trend, but no single step clears a 5 m deadband.
    const points = [100, 101, 102, 103, 104, 105, 106].map((altitudeM, i) =>
      at(i * 100, i * 10_000, { altitudeM }),
    );
    return {
      points,
      segments: [{ id: newId(), startIndex: 0, endIndex: points.length - 1, startedAt: T0 }],
    };
  }

  it("honours the elevation hysteresis it is given", () => {
    const track = climbTrack();
    const lap = { startIndex: 0, endIndex: 6 };

    expect(computeLapStats(track, lap, { elevationHysteresisM: 0 }).elevationGainM).toBeCloseTo(
      6,
      6,
    );
    expect(computeLapStats(track, lap, { elevationHysteresisM: 50 }).elevationGainM).toBeCloseTo(
      0,
      6,
    );
  });

  it("defaults to the same policy computeStats does", () => {
    const track = climbTrack();
    const lap = { startIndex: 0, endIndex: 6 };

    // The rolling filter still recognises the trend at the 5 m default.
    expect(computeLapStats(track, lap).elevationGainM).toBeCloseTo(6, 6);
  });

  it("carries the policy through finalizeTrack to every lap", () => {
    const base = climbTrack();
    const laps: LapInput[] = [
      { id: newId(), startIndex: 0, endIndex: 3 },
      { id: newId(), startIndex: 4, endIndex: 6 },
    ];

    const loose = finalizeTrack({ ...base, laps }, { elevationHysteresisM: 50 });
    const strict = finalizeTrack({ ...base, laps }, { elevationHysteresisM: 0 });

    expect(loose.laps?.[0]?.stats?.elevationGainM).toBeCloseTo(0, 6);
    expect(strict.laps?.[0]?.stats?.elevationGainM).toBeCloseTo(3, 6);
  });

  it("omits channel statistics when the track declares no descriptors", () => {
    const track = climbTrack();
    expect(computeLapStats(track, { startIndex: 0, endIndex: 3 }).channels).toBeUndefined();
  });
});

describe("finalizeTrack derives lap fields rather than trusting them", () => {
  it("assigns index, timing and statistics from the geometry", () => {
    const track = pausedTrack();
    const finalized = finalizeTrack({
      ...track,
      laps: [
        { id: "lap-a", startIndex: 0, endIndex: 2, label: "First" },
        { id: "lap-b", startIndex: 3, endIndex: 5 },
      ],
    });

    expect(finalized.laps?.map((l) => l.index)).toEqual([0, 1]);
    expect(finalized.laps?.[0]).toMatchObject({
      id: "lap-a",
      label: "First",
      startedAt: T0,
      endedAt: T0 + 20_000,
    });
    expect(finalized.laps?.[1]?.startedAt).toBe(T0 + 3_600_000);
    expect(finalized.laps?.[0]?.stats?.distanceM).toBeCloseTo(200, 0);
  });

  it("does not share statistics between the result and anything upstream", () => {
    const track = pausedTrack();
    const laps: LapInput[] = [{ id: newId(), startIndex: 0, endIndex: 2 }];

    const first = finalizeTrack({ ...track, laps });
    const channelStats = first.laps?.[0]?.stats?.channels?.["heartRateBpm"];
    expect(channelStats).toBeDefined();
    if (channelStats !== undefined) channelStats.min = -999;

    const second = finalizeTrack({ ...track, laps });
    expect(second.laps?.[0]?.stats?.channels?.["heartRateBpm"]?.min).toBe(110);
  });
});

describe("invalid lap ranges are rejected before anything is derived", () => {
  const track = pausedTrack();
  const invalid: [string, LapInput][] = [
    ["out of bounds", { id: "a", startIndex: 3, endIndex: 99 }],
    ["negative start", { id: "b", startIndex: -2, endIndex: 2 }],
    ["inverted", { id: "c", startIndex: 4, endIndex: 1 }],
    ["fractional start", { id: "d", startIndex: 0.5, endIndex: 2 }],
    ["fractional end", { id: "e", startIndex: 0, endIndex: 2.5 }],
  ];

  it.each(invalid)("rejects a lap with a %s range", (_name, lap) => {
    // Array slicing is forgiving in all the wrong ways: out of bounds yields a short slice,
    // inverted yields nothing, and a fractional index produced a plausible-looking 223 m
    // over the wrong points. All four finalized successfully before this check existed.
    expect(() => finalizeTrack({ ...track, laps: [lap] })).toThrow(TrackLapRangeError);
  });

  it("names the offending lap", () => {
    let thrown: TrackLapRangeError | undefined;
    try {
      finalizeTrack({
        ...track,
        laps: [
          { id: "fine", startIndex: 0, endIndex: 1 },
          { id: "broken", startIndex: 2, endIndex: 99 },
        ],
      });
    } catch (error) {
      thrown = error as TrackLapRangeError;
    }

    expect(thrown?.lapIndex).toBe(1);
    expect(thrown?.lapId).toBe("broken");
    expect(thrown?.message).toContain("outside");
  });

  it("derives nothing when it rejects", () => {
    const input = { ...track, laps: [{ id: "x", startIndex: 0, endIndex: 99 }] };
    const before = structuredClone(input);

    expect(() => finalizeTrack(input)).toThrow(TrackLapRangeError);
    expect(input).toEqual(before);
  });

  it("accepts overlapping laps — they are markers, not a partition", () => {
    expect(() =>
      finalizeTrack({
        ...track,
        laps: [
          { id: "a", startIndex: 0, endIndex: 3 },
          { id: "b", startIndex: 2, endIndex: 5 },
        ],
      }),
    ).not.toThrow();
  });

  it("accepts laps that leave points uncovered", () => {
    expect(() =>
      finalizeTrack({ ...track, laps: [{ id: "a", startIndex: 1, endIndex: 2 }] }),
    ).not.toThrow();
  });
});
