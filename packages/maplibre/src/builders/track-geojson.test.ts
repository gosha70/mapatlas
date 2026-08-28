// SPDX-License-Identifier: Apache-2.0
import type { Track, TrackPoint, TrackSegment } from "@mapatlas/core";
import { newId } from "@mapatlas/core";
import { describe, expect, it } from "vitest";

import {
  buildLapFeatures,
  buildTrackEndpointFeatures,
  buildTrackLineFeatures,
  segmentGeometry,
} from "./track-geojson.js";

const T0 = 1_700_000_000_000;

const point = (north: number, afterMs: number): TrackPoint => ({
  lat: 59.33 + north * 0.001,
  lng: 18.06,
  t: T0 + afterMs,
});

function track(overrides: Partial<Track> = {}): Track {
  const points = [point(0, 0), point(1, 10_000), point(2, 20_000)];
  return {
    id: "track-1",
    startedAt: T0,
    status: "finalized",
    origin: "recorded",
    points,
    segments: [{ id: "seg-a", startIndex: 0, endIndex: 2, startedAt: T0 }],
    ...overrides,
  };
}

/** Two segments with a pause between them. */
function pausedTrack(): Track {
  const points = [point(0, 0), point(1, 10_000), point(10, 3_600_000), point(11, 3_610_000)];
  const segments: TrackSegment[] = [
    { id: "seg-a", startIndex: 0, endIndex: 1, startedAt: T0 },
    { id: "seg-b", startIndex: 2, endIndex: 3, startedAt: T0 + 3_600_000 },
  ];
  return track({ points, segments });
}

describe("which geometry a segment draws", () => {
  it("prefers the simplified cache when it is there", () => {
    const base = track();
    const simplified = [[point(0, 0), point(2, 20_000)]];
    const geometry = segmentGeometry({ ...base, simplifiedSegments: simplified }, 0);

    expect(geometry).toHaveLength(2);
  });

  it("falls back to slicing the raw points when it is not", () => {
    // The cache is disposable by design (ADR-0018). A track from import, or one a storage
    // migration stripped, must still draw rather than render nothing.
    expect(segmentGeometry(track(), 0)).toHaveLength(3);
  });

  it("slices each segment's own range, never the whole array", () => {
    const paused = pausedTrack();
    expect(segmentGeometry(paused, 0).map((p) => p.t)).toEqual([T0, T0 + 10_000]);
    expect(segmentGeometry(paused, 1).map((p) => p.t)).toEqual([T0 + 3_600_000, T0 + 3_610_000]);
  });

  it("returns nothing for a segment index that does not exist", () => {
    expect(segmentGeometry(track(), 9)).toEqual([]);
  });
});

describe("track lines", () => {
  it("emits one LineString per segment", () => {
    const collection = buildTrackLineFeatures(pausedTrack());

    expect(collection.type).toBe("FeatureCollection");
    expect(collection.features).toHaveLength(2);
    expect(collection.features[0]?.geometry.type).toBe("LineString");
  });

  it("never bridges a pause", () => {
    const collection = buildTrackLineFeatures(pausedTrack());
    const [first, second] = collection.features;

    expect(first?.geometry.coordinates).toHaveLength(2);
    expect(second?.geometry.coordinates).toHaveLength(2);
    // The last coordinate of one and the first of the next are in different features.
    expect(first?.geometry.coordinates.at(-1)?.[1]).toBeCloseTo(59.331, 5);
    expect(second?.geometry.coordinates[0]?.[1]).toBeCloseTo(59.34, 5);
  });

  it("writes positions longitude-first, per RFC 7946", () => {
    const [lng, lat] = buildTrackLineFeatures(track()).features[0]!.geometry.coordinates[0]!;
    expect(lng).toBeCloseTo(18.06, 5);
    expect(lat).toBeCloseTo(59.33, 5);
  });

  it("identifies each feature by track and segment", () => {
    const feature = buildTrackLineFeatures(pausedTrack()).features[1];
    expect(feature?.properties).toEqual({
      kind: "track-segment",
      trackId: "track-1",
      segmentId: "seg-b",
      segmentIndex: 1,
    });
  });

  it("draws from the simplified cache when present", () => {
    const paused = pausedTrack();
    const withCache: Track = {
      ...paused,
      simplifiedSegments: [
        [point(0, 0), point(1, 10_000)],
        [point(10, 3_600_000), point(11, 3_610_000)],
      ],
    };
    expect(buildTrackLineFeatures(withCache).features).toHaveLength(2);
  });

  it("renders the same shape whether or not the cache is present", () => {
    const paused = pausedTrack();
    const withCache: Track = {
      ...paused,
      simplifiedSegments: paused.segments.map((segment) =>
        paused.points.slice(segment.startIndex, segment.endIndex + 1),
      ),
    };

    expect(buildTrackLineFeatures(withCache)).toEqual(buildTrackLineFeatures(paused));
  });
});

describe("a segment with one point is not a line", () => {
  const singleton = (): Track => {
    const points = [point(0, 0), point(5, 3_600_000), point(6, 3_610_000)];
    return track({
      points,
      segments: [
        { id: "seg-a", startIndex: 0, endIndex: 0, startedAt: T0 },
        { id: "seg-b", startIndex: 1, endIndex: 2, startedAt: T0 + 3_600_000 },
      ],
    });
  };

  it("emits no feature for it", () => {
    // A GeoJSON LineString needs two positions. Emitting a one-position one is invalid and
    // MapLibre either rejects it or draws nothing, with no indication which.
    const features = buildTrackLineFeatures(singleton()).features;

    expect(features).toHaveLength(1);
    expect(features[0]?.properties.segmentIndex).toBe(1);
  });

  it("never emits an empty or single-position LineString, whatever the track", () => {
    const tracks = [
      track(),
      pausedTrack(),
      singleton(),
      track({
        points: [point(0, 0)],
        segments: [{ id: "s", startIndex: 0, endIndex: 0, startedAt: T0 }],
      }),
    ];

    for (const candidate of tracks) {
      for (const feature of buildTrackLineFeatures(candidate).features) {
        expect(feature.geometry.coordinates.length).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it("still keeps the place as an endpoint mark", () => {
    // One kept fix is still somewhere the user was, even if it cannot be a line.
    const oneFix = track({
      points: [point(0, 0)],
      segments: [{ id: "s", startIndex: 0, endIndex: 0, startedAt: T0 }],
    });

    expect(buildTrackLineFeatures(oneFix).features).toEqual([]);
    expect(buildTrackEndpointFeatures(oneFix).features).toHaveLength(1);
  });
});

describe("endpoints", () => {
  it("marks the start and the finish", () => {
    const features = buildTrackEndpointFeatures(pausedTrack()).features;
    expect(features.map((f) => f.properties.kind)).toEqual(["track-start", "track-finish"]);
  });

  it("takes them from the raw points, not the cache", () => {
    // Simplification preserves endpoints, but depending on that would make the marks rely
    // on a cache that is permitted to be absent.
    const base = pausedTrack();
    const misleading: Track = { ...base, simplifiedSegments: [[point(99, 0)], [point(98, 1)]] };

    const features = buildTrackEndpointFeatures(misleading).features;
    expect(features[0]?.geometry.coordinates[1]).toBeCloseTo(59.33, 5);
  });

  it("emits one mark for a single-point track, not two on one coordinate", () => {
    const oneFix = track({
      points: [point(0, 0)],
      segments: [{ id: "s", startIndex: 0, endIndex: 0, startedAt: T0 }],
    });
    expect(buildTrackEndpointFeatures(oneFix).features).toHaveLength(1);
  });

  it("emits nothing for an empty track", () => {
    expect(buildTrackEndpointFeatures(track({ points: [], segments: [] })).features).toEqual([]);
  });
});

describe("laps", () => {
  it("marks where each lap ended, with its label", () => {
    const base = pausedTrack();
    const withLaps: Track = {
      ...base,
      laps: [
        { id: newId(), index: 0, startIndex: 0, endIndex: 1, startedAt: T0, label: "First" },
        { id: newId(), index: 1, startIndex: 2, endIndex: 3, startedAt: T0 + 3_600_000 },
      ],
    };

    const features = buildLapFeatures(withLaps).features;
    expect(features).toHaveLength(2);
    expect(features[0]?.properties.label).toBe("First");
    expect(features[1]?.properties).not.toHaveProperty("label");
  });

  it("emits nothing when there are no laps", () => {
    expect(buildLapFeatures(track()).features).toEqual([]);
  });
});

describe("purity", () => {
  it("does not modify the track it was given", () => {
    const base = pausedTrack();
    const before = structuredClone(base);

    buildTrackLineFeatures(base);
    buildTrackEndpointFeatures(base);
    buildLapFeatures(base);

    expect(base).toEqual(before);
  });

  it("is deterministic", () => {
    const base = pausedTrack();
    expect(JSON.stringify(buildTrackLineFeatures(base))).toBe(
      JSON.stringify(buildTrackLineFeatures(base)),
    );
  });
});
