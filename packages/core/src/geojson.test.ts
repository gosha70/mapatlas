// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import type { MapEvent, Track } from "./types.js";
import { geoJSONToTrack, trackToGeoJSON } from "./geojson.js";

const track: Track = {
  id: "trk-1",
  startedAt: 1000,
  endedAt: 5000,
  status: "finalized",
  points: [
    { lat: 0, lng: 0, t: 1000, accuracyM: 5 },
    { lat: 0.001, lng: 0.001, t: 2000, speedMps: 1.2, headingDeg: 45 },
    { lat: 0.002, lng: 0.0015, t: 3000 },
  ],
  simplified: [
    { lat: 0, lng: 0, t: 1000 },
    { lat: 0.002, lng: 0.0015, t: 3000 },
  ],
  distanceM: 271.3,
  tags: ["survey", "morning"],
  meta: { device: "pixel", battery: 0.8 },
};

const events: MapEvent[] = [
  {
    id: "evt-1",
    trackId: "trk-1",
    position: { lat: 0.001, lng: 0.001 },
    occurredAt: 2000,
    comment: "saw something",
    tags: ["notable"],
    category: "observation",
    fields: { count: 3, nested: { a: [1, 2, 3], b: null } },
    media: [
      {
        id: "m-1",
        mime: "image/jpeg",
        width: 1024,
        height: 768,
        blobKey: "blob-abc",
        analysis: {
          labels: [
            { label: "object-a", confidence: 0.91 },
            { label: "object-b", confidence: 0.42 },
          ],
          summary: "two objects detected",
          model: "test-model",
          raw: { score: 0.91 },
        },
      },
      { id: "m-2", mime: "image/png", url: "https://example.test/x.png" },
    ],
  },
  {
    id: "evt-2",
    position: { lat: 0.002, lng: 0.0015 },
    occurredAt: 3000,
    media: [],
    tags: [],
  },
];

describe("trackToGeoJSON / geoJSONToTrack", () => {
  it("produces a valid FeatureCollection with LineString + Point geometries", () => {
    const fc = trackToGeoJSON(track, events);
    expect(fc.type).toBe("FeatureCollection");
    expect(fc.features).toHaveLength(3);

    const trackFeature = fc.features[0]!;
    expect(trackFeature.geometry?.type).toBe("LineString");

    const eventFeature = fc.features[1]!;
    expect(eventFeature.geometry?.type).toBe("Point");
    // GeoJSON coordinates are [lng, lat].
    expect((eventFeature.geometry as GeoJSON.Point).coordinates).toEqual([
      0.001, 0.001,
    ]);
  });

  it("round-trips a track and its events without loss", () => {
    const fc = trackToGeoJSON(track, events);
    const { track: rt, events: rtEvents } = geoJSONToTrack(fc);

    expect(rt).toEqual(track);
    expect(rtEvents).toEqual(events);
  });

  it("does not inline media bytes — media travels by reference", () => {
    const json = JSON.stringify(trackToGeoJSON(track, events));
    // References are preserved...
    expect(json).toContain("blob-abc");
    expect(json).toContain("https://example.test/x.png");
    // ...and analysis survives.
    expect(json).toContain("two objects detected");
  });

  it("handles a track with fewer than two points (Point geometry)", () => {
    const tiny: Track = {
      id: "t0",
      startedAt: 0,
      status: "recording",
      points: [{ lat: 1, lng: 1, t: 0 }],
    };
    const fc = trackToGeoJSON(tiny, []);
    expect(fc.features[0]!.geometry.type).toBe("Point");
    const { track: rt } = geoJSONToTrack(fc);
    expect(rt).toEqual(tiny);
  });

  it("handles an empty track (empty GeometryCollection)", () => {
    const empty: Track = {
      id: "t-empty",
      startedAt: 0,
      status: "recording",
      points: [],
    };
    const fc = trackToGeoJSON(empty, []);
    expect(fc.features[0]!.geometry.type).toBe("GeometryCollection");
    const { track: rt } = geoJSONToTrack(fc);
    expect(rt).toEqual(empty);
  });

  it("imports externally-authored GeoJSON with a bare LineString", () => {
    const fc: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {},
          geometry: {
            type: "LineString",
            coordinates: [
              [0, 0],
              [1, 1],
              [2, 2],
            ],
          },
        },
      ],
    };
    const { track: rt, events: rtEvents } = geoJSONToTrack(fc);
    expect(rt.points).toHaveLength(3);
    expect(rt.points[1]).toEqual({ lat: 1, lng: 1, t: 0 });
    expect(rtEvents).toHaveLength(0);
  });
});
