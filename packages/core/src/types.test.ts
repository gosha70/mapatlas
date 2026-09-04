// SPDX-License-Identifier: Apache-2.0
import { describe, expect, expectTypeOf, it } from "vitest";

import * as core from "./index.js";
import type {
  DraftTrackPoint,
  MapEvent,
  Track,
  TrackPoint,
  TrackSegment,
  TrackSummary,
} from "./index.js";

describe("DraftTrackPoint vs TrackPoint (ADR-0018)", () => {
  it("lets a draft point exist without a timestamp", () => {
    const vertex: DraftTrackPoint = { lat: 59.33, lng: 18.06 };
    expect(vertex.t).toBeUndefined();
  });

  it("requires a timestamp on a finalized point", () => {
    expectTypeOf<TrackPoint>().toHaveProperty("t");
    expectTypeOf<TrackPoint["t"]>().toEqualTypeOf<number>();
    expectTypeOf<DraftTrackPoint["t"]>().toEqualTypeOf<number | undefined>();

    // @ts-expect-error — a TrackPoint without `t` must not compile. If this line ever
    // stops erroring, the two types have collapsed and the draft boundary is gone.
    const timeless: TrackPoint = { lat: 59.33, lng: 18.06 };
    expect(timeless).toBeDefined();
  });

  it("accepts a timed TrackPoint as a DraftTrackPoint, but not the reverse", () => {
    expectTypeOf<TrackPoint>().toExtend<DraftTrackPoint>();
    expectTypeOf<DraftTrackPoint>().not.toExtend<TrackPoint>();
  });

  it("carries the same optional telemetry on both", () => {
    const point: TrackPoint = {
      lat: 0,
      lng: 0,
      t: 1,
      altitudeM: 12,
      channels: { heartRateBpm: 148 },
    };
    const draft: DraftTrackPoint = {
      lat: 0,
      lng: 0,
      altitudeM: 12,
      channels: { heartRateBpm: 148 },
    };
    expect(point.channels?.heartRateBpm).toBe(148);
    expect(draft.channels?.heartRateBpm).toBe(148);
  });
});

describe("Track geometry (ADR-0010, ADR-0018)", () => {
  it("holds segments as index ranges, not copies of the points", () => {
    expectTypeOf<TrackSegment["startIndex"]>().toEqualTypeOf<number>();
    expectTypeOf<TrackSegment>().not.toHaveProperty("points");
  });

  it("caches simplification per segment, not as one flat array", () => {
    expectTypeOf<Track["simplifiedSegments"]>().toEqualTypeOf<TrackPoint[][] | undefined>();
  });

  it("treats simplifiedSegments as droppable — the track still typechecks without it", () => {
    const track: Track = {
      id: core.newId(),
      startedAt: 1,
      status: "finalized",
      origin: "recorded",
      points: [{ lat: 0, lng: 0, t: 1 }],
      segments: [{ id: core.newId(), startIndex: 0, endIndex: 0, startedAt: 1 }],
    };
    expect(track.simplifiedSegments).toBeUndefined();
  });

  it("keeps the summary free of point arrays", () => {
    expectTypeOf<TrackSummary>().not.toHaveProperty("points");
    expectTypeOf<TrackSummary>().not.toHaveProperty("simplifiedSegments");
    expectTypeOf<TrackSummary["pointCount"]>().toEqualTypeOf<number>();
  });
});

describe("domain neutrality (ADR-0001)", () => {
  it("carries consumer data in untyped bags, with no domain field anywhere", () => {
    const event: MapEvent = {
      id: core.newId(),
      position: { lat: 0, lng: 0 },
      occurredAt: 1,
      media: [],
      tags: ["a-consumer-tag"],
      category: "a-consumer-category",
      fields: { anythingTheConsumerWants: 42 },
    };
    expect(event.fields?.anythingTheConsumerWants).toBe(42);
  });
});

describe("public surface", () => {
  it("exports exactly the runtime values Phase 1 has so far", () => {
    // Deliberately exact: an accidental export is a public API change, and api.md has to
    // be updated in the same commit as one (CLAUDE.md). Failing here is the reminder.
    expect(Object.keys(core).sort()).toEqual(
      [
        "DEFAULT_MAX_ACCURACY_M",
        "DEFAULT_MAX_INTERVAL_MS",
        "DEFAULT_MIN_DISTANCE_M",
        "DEFAULT_SAMPLING_POLICY",
        "ID_LENGTH",
        "PACKAGE_NAME",
        "createIdFactory",
        "haversineDistanceMeters",
        "newId",
        "resolveSamplingPolicy",
        "sample",
        "simplify",
        "TrackSegmentRangeError",
        "TrackTemporalOrderError",
        "assertValidTrackGeometry",
        "TrackLapRangeError",
        "computeLapStats",
        "compareTrackSummaries",
        "summariseTrack",
        "geodesicDistanceMeters",
        "DEFAULT_ELEVATION_HYSTERESIS_M",
        "DEFAULT_FINALIZE_POLICY",
        "DEFAULT_SIMPLIFY_TOLERANCE_M",
        "DEFAULT_STATS_POLICY",
        "computeStats",
        "finalizeTrack",
        "positionAt",
        "resolveFinalizePolicy",
        "resolveStatsPolicy",
        "EventNotFoundError",
        "createEventLog",
        "TrackCoverageError",
        "TrackImportError",
        "geoJSONToTrack",
        "trackToGeoJSON",
        "DEFAULT_SENSOR_MAX_AGE_MS",
        "DEFAULT_SENSOR_MERGE_POLICY",
        "DEFAULT_SENSOR_REDUCE",
        "createPollingSensorSource",
        "TrackDraftIncompleteError",
        "createTrackDraft",
        "listInterruptedTracks",
        "recoverInterruptedTrack",
        "mergeSensorSamples",
        "resolveSensorMergePolicy",
        "noopAnalyzer",
      ].sort(),
    );
  });

  it("has no runtime dependencies — the AC for T1.1", async () => {
    const manifest = await import("../package.json", { with: { type: "json" } });
    expect(manifest.default.dependencies ?? {}).toEqual({});
  });
});
