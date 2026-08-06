// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { trackToGeoJSON, geoJSONToTrack } from "./geojson";
import type { MapEvent, Track } from "./types";

function fixture(): { track: Track; events: MapEvent[] } {
  const track: Track = {
    id: "TRACK1",
    startedAt: 1000,
    endedAt: 5000,
    status: "finalized",
    points: [
      { lat: 10.0, lng: 20.0, t: 1000, accuracyM: 5 },
      { lat: 10.001, lng: 20.001, t: 2000, speedMps: 1.4, headingDeg: 45 },
      { lat: 10.002, lng: 20.0005, t: 3000 },
    ],
    simplified: [
      { lat: 10.0, lng: 20.0, t: 1000, accuracyM: 5 },
      { lat: 10.002, lng: 20.0005, t: 3000 },
    ],
    distanceM: 234.5,
    tags: ["morning", "loop"],
    meta: { device: "pixel", nested: { n: 1 } },
  };

  const events: MapEvent[] = [
    {
      id: "EV1",
      trackId: "TRACK1",
      position: { lat: 10.001, lng: 20.001 },
      occurredAt: 2500,
      comment: "saw something",
      tags: ["note"],
      category: "sighting",
      fields: { count: 3, label: "x", flag: true },
      media: [
        {
          id: "M1",
          mime: "image/jpeg",
          width: 640,
          height: 480,
          blobKey: "blob:abc",
          analysis: {
            labels: [{ label: "object", confidence: 0.9 }],
            summary: "one object",
            model: "test-model",
            raw: { boxes: 1 },
          },
        },
        { id: "M2", mime: "image/png", url: "https://example.test/p.png" },
      ],
    },
    {
      id: "EV2",
      position: { lat: 10.002, lng: 20.0005 },
      occurredAt: 3200,
      media: [],
      tags: [],
    },
  ];

  return { track, events };
}

describe("trackToGeoJSON / geoJSONToTrack", () => {
  it("emits valid GeoJSON geometry", () => {
    const { track, events } = fixture();
    const fc = trackToGeoJSON(track, events);

    expect(fc.type).toBe("FeatureCollection");
    const trackFeature = fc.features[0];
    expect(trackFeature?.geometry?.type).toBe("LineString");
    // One track + two events + one manifest.
    expect(fc.features).toHaveLength(4);
    const points = fc.features.filter((f) => f.geometry?.type === "Point");
    expect(points).toHaveLength(2);
  });

  it("round-trips geometry, timestamps, comment, tags, fields, and analysis", () => {
    const { track, events } = fixture();
    const fc = trackToGeoJSON(track, events);
    const back = geoJSONToTrack(fc);

    expect(back.track).toEqual(track);
    expect(back.events).toEqual(events);
  });

  it("carries media by reference (keys/urls), never inlined bytes", () => {
    const { track, events } = fixture();
    const json = JSON.stringify(trackToGeoJSON(track, events));
    expect(json).toContain("blob:abc");
    expect(json).toContain("https://example.test/p.png");
    // A collection-level manifest lists every referenced media item.
    const fc = trackToGeoJSON(track, events);
    const manifest = fc.features.at(-1);
    expect((manifest?.properties as { kind?: string })?.kind).toBe(
      "mapatlas:manifest",
    );
  });

  it("throws on a feature collection with no track", () => {
    expect(() =>
      geoJSONToTrack({ type: "FeatureCollection", features: [] }),
    ).toThrow(/no track/);
  });

  it("throws on a malformed track coordinate", () => {
    const fc: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "LineString", coordinates: [[]] },
          properties: {
            kind: "mapatlas:track",
            id: "T",
            startedAt: 0,
            status: "finalized",
            pointMeta: [{ t: 0 }],
          },
        },
      ],
    };
    expect(() => geoJSONToTrack(fc)).toThrow(/track coordinate/);
  });

  it("throws when an event feature is not a Point", () => {
    const fc: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "LineString", coordinates: [[0, 0]] },
          properties: {
            kind: "mapatlas:track",
            id: "T",
            startedAt: 0,
            status: "finalized",
            pointMeta: [{ t: 0 }],
          },
        },
        {
          type: "Feature",
          geometry: { type: "LineString", coordinates: [[0, 0]] },
          properties: { kind: "mapatlas:event", id: "E", occurredAt: 0 },
        },
      ],
    };
    expect(() => geoJSONToTrack(fc)).toThrow(/Point geometry/);
  });

  it("throws on a malformed event coordinate", () => {
    const fc: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "LineString", coordinates: [[0, 0]] },
          properties: {
            kind: "mapatlas:track",
            id: "T",
            startedAt: 0,
            status: "finalized",
            pointMeta: [{ t: 0 }],
          },
        },
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [] },
          properties: { kind: "mapatlas:event", id: "E", occurredAt: 0 },
        },
      ],
    };
    expect(() => geoJSONToTrack(fc)).toThrow(/event coordinate/);
  });

  it("tolerates a track feature with non-LineString geometry", () => {
    const fc: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [0, 0] },
          properties: {
            kind: "mapatlas:track",
            id: "T",
            startedAt: 0,
            status: "finalized",
            pointMeta: [],
          },
        },
      ],
    };
    expect(geoJSONToTrack(fc).track.points).toEqual([]);
  });

  it("fills a default timestamp when point metadata is missing", () => {
    const fc: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: {
            type: "LineString",
            coordinates: [
              [0, 0],
              [1, 1],
            ],
          },
          properties: {
            kind: "mapatlas:track",
            id: "T",
            startedAt: 0,
            status: "finalized",
            pointMeta: [{ t: 42 }], // shorter than the coordinate list
          },
        },
      ],
    };
    const { track } = geoJSONToTrack(fc);
    expect(track.points.map((p) => p.t)).toEqual([42, 0]);
  });

  it("defaults tags and media on a bare event feature", () => {
    const fc: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "LineString", coordinates: [[0, 0]] },
          properties: {
            kind: "mapatlas:track",
            id: "T",
            startedAt: 0,
            status: "finalized",
            pointMeta: [{ t: 0 }],
          },
        },
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [1, 2] },
          properties: { kind: "mapatlas:event", id: "E", occurredAt: 7 },
        },
      ],
    };
    const { events } = geoJSONToTrack(fc);
    expect(events[0]).toEqual({
      id: "E",
      position: { lat: 2, lng: 1 },
      occurredAt: 7,
      tags: [],
      media: [],
    });
  });

  it("ignores unknown and manifest features on import", () => {
    const fc: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: null,
          properties: null,
        },
        {
          type: "Feature",
          geometry: { type: "LineString", coordinates: [[0, 0]] },
          properties: {
            kind: "mapatlas:track",
            id: "T",
            startedAt: 0,
            status: "finalized",
            pointMeta: [{ t: 0 }],
          },
        },
      ],
    };
    expect(geoJSONToTrack(fc).track.id).toBe("T");
  });
});
