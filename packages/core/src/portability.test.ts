// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import type { MapEvent } from "./event.js";
import { finalizeTrack } from "./finalize.js";
import { newId } from "./ids.js";
import type { Position } from "./geojson.js";
import type { TrackExport, TrackFeatureProperties } from "./portability.js";
import { TrackImportError, geoJSONToTrack, trackToGeoJSON } from "./portability.js";
import type { Track, TrackPoint, TrackSegment } from "./track.js";
import { TrackCoverageError, TrackTemporalOrderError } from "./validate.js";

const T0 = 1_700_000_000_000;

/**
 * Canonical state: everything a track *is*, excluding the derived cache.
 *
 * `simplifiedSegments` is deliberately omitted from interchange and regenerated on the far
 * side, so literal whole-object equality would be the wrong assertion — it would either
 * force the cache into the document or fail for the right reason. Cache regeneration is
 * checked separately.
 */
function canonical(t: Track): Omit<Track, "simplifiedSegments"> {
  const rest = { ...t };
  delete rest.simplifiedSegments;
  return rest;
}

function makeTrack(overrides: Partial<Track> = {}): Track {
  const points: TrackPoint[] = [
    { lat: 59.33, lng: 18.06, t: T0, altitudeM: 10 },
    { lat: 59.34, lng: 18.07, t: T0 + 60_000, altitudeM: 25 },
    { lat: 59.35, lng: 18.08, t: T0 + 120_000, altitudeM: 40 },
  ];
  return {
    id: newId(),
    startedAt: T0,
    endedAt: T0 + 120_000,
    status: "finalized",
    origin: "recorded",
    points,
    segments: [{ id: newId(), startIndex: 0, endIndex: 2, startedAt: T0 }],
    ...overrides,
  };
}

/** Two segments with a pause between them — the fixture most likely to expose a bug. */
function pausedTrack(): Track {
  const points: TrackPoint[] = [
    { lat: 59.33, lng: 18.06, t: T0, altitudeM: 10 },
    { lat: 59.34, lng: 18.07, t: T0 + 60_000, altitudeM: 20 },
    { lat: 59.5, lng: 18.2, t: T0 + 3_600_000, altitudeM: 100 },
    { lat: 59.51, lng: 18.21, t: T0 + 3_660_000, altitudeM: 110 },
  ];
  const segments: TrackSegment[] = [
    { id: newId(), startIndex: 0, endIndex: 1, startedAt: T0, endedAt: T0 + 60_000 },
    { id: newId(), startIndex: 2, endIndex: 3, startedAt: T0 + 3_600_000 },
  ];
  return makeTrack({ points, segments });
}

const event = (o: Partial<MapEvent> = {}): MapEvent => ({
  id: newId(),
  position: { lat: 59.33, lng: 18.06 },
  occurredAt: T0,
  media: [],
  tags: [],
  ...o,
});

/** Narrow the union the way a reader must: by the `kind` discriminator. */
function trackProps(doc: TrackExport): TrackFeatureProperties {
  const feature = doc.geojson.features[0];
  if (feature === undefined || feature.properties.kind !== "track") {
    throw new Error("fixture has no track feature");
  }
  return feature.properties;
}

function trackCoords(doc: TrackExport): Position[][] {
  const feature = doc.geojson.features[0];
  if (feature === undefined || feature.geometry.type !== "MultiLineString") {
    throw new Error("fixture has no MultiLineString");
  }
  return feature.geometry.coordinates;
}

/** Export, import, export again — the governing property. */
function roundTrip(track: Track, events: MapEvent[] = []) {
  const first = trackToGeoJSON(track, events);
  const imported = geoJSONToTrack(first);
  const second = trackToGeoJSON(imported.track, imported.events);
  return { first, second, imported };
}

describe("the round trip is the contract", () => {
  it("re-exports byte-identically", () => {
    const { first, second } = roundTrip(pausedTrack(), [event(), event({ occurredAt: T0 + 10 })]);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("restores the canonical state exactly", () => {
    const track = pausedTrack();
    const { imported } = roundTrip(track);
    expect(canonical(imported.track)).toEqual(canonical(track));
  });

  it("restores events exactly", () => {
    const events = [
      event({ comment: "one", tags: ["a", "b"], category: "c" }),
      event({ occurredAt: T0 + 5000, fields: { n: 1 } }),
    ];
    const { imported } = roundTrip(makeTrack(), events);
    expect(imported.events).toEqual(events);
  });

  it("is stable over a second round trip", () => {
    const track = pausedTrack();
    const once = geoJSONToTrack(trackToGeoJSON(track, []));
    const twice = geoJSONToTrack(trackToGeoJSON(once.track, once.events));
    expect(canonical(twice.track)).toEqual(canonical(once.track));
  });
});

describe("geometry and segmentation", () => {
  it("emits one MultiLineString member per segment", () => {
    const track = pausedTrack();
    const { geojson } = trackToGeoJSON(track, []);
    expect(geojson.features[0]?.geometry.type).toBe("MultiLineString");
    expect(trackCoords({ geojson, media: [] })).toHaveLength(2);
  });

  it("never bridges a pause", () => {
    const track = pausedTrack();
    const { geojson } = trackToGeoJSON(track, []);
    const coordinates = trackCoords({ geojson, media: [] });

    expect(coordinates[0]).toHaveLength(2);
    expect(coordinates[1]).toHaveLength(2);
    // The last point of segment 0 and the first of segment 1 are in different members.
    expect(coordinates[0]?.at(-1)?.[1]).toBeCloseTo(59.34, 5);
    expect(coordinates[1]?.[0]?.[1]).toBeCloseTo(59.5, 5);
  });

  it("restores segment boundaries and metadata", () => {
    const track = pausedTrack();
    const { imported } = roundTrip(track);

    expect(imported.track.segments).toEqual(track.segments);
  });

  it("writes positions longitude-first, per RFC 7946", () => {
    const { geojson } = trackToGeoJSON(makeTrack(), []);
    const first = trackCoords({ geojson, media: [] })[0]?.[0];
    expect(first?.[0]).toBeCloseTo(18.06, 5);
    expect(first?.[1]).toBeCloseTo(59.33, 5);
  });
});

describe("altitude rides in the coordinate", () => {
  it("emits [lng, lat, altitude] when a point has one", () => {
    const { geojson } = trackToGeoJSON(makeTrack(), []);
    const position = trackCoords({ geojson, media: [] })[0]?.[0];
    expect(position).toHaveLength(3);
    expect(position?.[2]).toBe(10);
  });

  it("emits [lng, lat] when it does not, and round-trips mixed 2D/3D", () => {
    const points: TrackPoint[] = [
      { lat: 59.33, lng: 18.06, t: T0, altitudeM: 10 },
      { lat: 59.34, lng: 18.07, t: T0 + 1000 },
      { lat: 59.35, lng: 18.08, t: T0 + 2000, altitudeM: 30 },
    ];
    const track = makeTrack({ points });
    const { geojson } = trackToGeoJSON(track, []);
    const line = trackCoords({ geojson, media: [] })[0];

    expect(line?.[0]).toHaveLength(3);
    expect(line?.[1]).toHaveLength(2);

    const { imported } = roundTrip(track);
    expect(canonical(imported.track)).toEqual(canonical(track));
    expect(imported.track.points[1]?.altitudeM).toBeUndefined();
  });
});

describe("parallel arrays are aligned, never compacted", () => {
  function partialTelemetry(): Track {
    const points: TrackPoint[] = [
      { lat: 59.33, lng: 18.06, t: T0, channels: { heartRateBpm: 120 } },
      { lat: 59.34, lng: 18.07, t: T0 + 1000 },
      { lat: 59.35, lng: 18.08, t: T0 + 2000, channels: { heartRateBpm: 124 } },
      { lat: 59.5, lng: 18.2, t: T0 + 3_600_000 },
      { lat: 59.51, lng: 18.21, t: T0 + 3_601_000, channels: { heartRateBpm: 130 } },
    ];
    const segments: TrackSegment[] = [
      { id: newId(), startIndex: 0, endIndex: 2, startedAt: T0 },
      { id: newId(), startIndex: 3, endIndex: 4, startedAt: T0 + 3_600_000 },
    ];
    return makeTrack({
      points,
      segments,
      channels: [{ key: "heartRateBpm", label: "Heart rate", unit: "bpm", aggregate: "avg" }],
    });
  }

  it("writes null for a missing sample rather than shortening the array", () => {
    const { geojson } = trackToGeoJSON(partialTelemetry(), []);
    const properties = trackProps({ geojson, media: [] });

    expect(properties.channels?.["heartRateBpm"]).toEqual([
      [120, null, 124],
      [null, 130],
    ]);
  });

  it("keeps coordTimes the same shape as the coordinates", () => {
    const track = partialTelemetry();
    const { geojson } = trackToGeoJSON(track, []);
    const properties = trackProps({ geojson, media: [] });
    const coordinates = trackCoords({ geojson, media: [] });

    expect(properties.coordTimes).toHaveLength(coordinates.length);
    for (const [i, times] of properties.coordTimes.entries()) {
      expect(times).toHaveLength(coordinates[i]?.length ?? -1);
    }
  });

  it("round-trips partial telemetry without inventing or dropping samples", () => {
    const track = partialTelemetry();
    const { imported } = roundTrip(track);
    expect(canonical(imported.track)).toEqual(canonical(track));
    expect(imported.track.points[1]?.channels).toBeUndefined();
    expect(imported.track.points[4]?.channels).toEqual({ heartRateBpm: 130 });
  });

  it("carries the other per-point fields the same way", () => {
    const points: TrackPoint[] = [
      { lat: 59.33, lng: 18.06, t: T0, accuracyM: 4, speedMps: 1.2, headingDeg: 90 },
      { lat: 59.34, lng: 18.07, t: T0 + 1000 },
      { lat: 59.35, lng: 18.08, t: T0 + 2000, accuracyM: 6, altitudeAccuracyM: 3 },
    ];
    const track = makeTrack({ points });
    const { imported } = roundTrip(track);
    expect(canonical(imported.track)).toEqual(canonical(track));
  });

  it("omits a field property entirely when no point carries it", () => {
    const points: TrackPoint[] = [
      { lat: 59.33, lng: 18.06, t: T0 },
      { lat: 59.34, lng: 18.07, t: T0 + 1000 },
    ];
    const segments: TrackSegment[] = [{ id: newId(), startIndex: 0, endIndex: 1, startedAt: T0 }];
    const { geojson } = trackToGeoJSON(makeTrack({ points, segments }), []);
    const properties = trackProps({ geojson, media: [] });

    expect(properties).not.toHaveProperty("accuracyM");
    expect(properties).not.toHaveProperty("channels");
    expect(properties).toHaveProperty("coordTimes");
  });
});

describe("the derived cache never travels", () => {
  it("ignores simplifiedSegments even when it is stale and wrong", () => {
    const track = makeTrack({
      simplifiedSegments: [[{ lat: 0, lng: 0, t: 1 }]], // deliberately nonsense
    });
    const { geojson } = trackToGeoJSON(track, []);

    expect(JSON.stringify(geojson)).not.toContain("simplifiedSegments");
    // The exported geometry is the raw points, not the stale cache.
    expect(trackCoords({ geojson, media: [] })[0]).toHaveLength(3);
  });

  it("does not restore it on import — it is regenerated, not carried", () => {
    const { imported } = roundTrip(makeTrack());
    expect(imported.track.simplifiedSegments).toBeUndefined();
  });

  it("regenerates deterministically after import", () => {
    const track = finalizeTrack(makeTrack());
    const { imported } = roundTrip(track);
    const refinalized = finalizeTrack(imported.track);

    expect(refinalized.simplifiedSegments).toEqual(track.simplifiedSegments);
  });
});

describe("everything else survives verbatim", () => {
  it("carries descriptors, laps, stats, origin, tags and meta", () => {
    const track = finalizeTrack(
      makeTrack({
        origin: "authored",
        tags: ["zebra", "apple"], // order is data, not a set
        meta: { nested: { deep: [1, 2, { x: true }] }, unicode: "ø∆✓ 日本語" },
        channels: [{ key: "depthM", label: "Depth", unit: "m", aggregate: "max", precision: 1 }],
        laps: [
          { id: newId(), index: 0, startIndex: 0, endIndex: 2, startedAt: T0, label: "Lap 1" },
        ],
      }),
    );

    const { imported } = roundTrip(track);
    expect(canonical(imported.track)).toEqual(canonical(track));
    expect(imported.track.tags).toEqual(["zebra", "apple"]);
    expect(imported.track.meta?.unicode).toBe("ø∆✓ 日本語");
    expect(imported.track.origin).toBe("authored");
  });

  it("carries event fields, unicode and nested JSON", () => {
    const events = [
      event({
        comment: 'a note with ünïcode 🎣 and "quotes"',
        fields: { nested: { list: [1, "two", null, { three: true }] }, "key with spaces": 1 },
        tags: ["z", "a"],
        category: "cat",
      }),
    ];
    const { imported } = roundTrip(makeTrack(), events);
    expect(imported.events).toEqual(events);
  });

  it("preserves analysis on a media reference", () => {
    const events = [
      event({
        media: [
          {
            id: newId(),
            mime: "image/jpeg",
            blobKey: "key-1",
            width: 4032,
            analysis: {
              labels: [{ label: "a-label", confidence: 0.91 }],
              summary: "a summary",
              model: "some-model",
              raw: { nested: true },
            },
          },
        ],
      }),
    ];
    const { imported } = roundTrip(makeTrack(), events);
    expect(imported.events[0]?.media[0]?.analysis).toEqual(events[0]?.media[0]?.analysis);
  });

  it("orders events deterministically, ties broken by id", () => {
    const shared = T0 + 500;
    const events = [
      event({ occurredAt: shared }),
      event({ occurredAt: shared }),
      event({ occurredAt: shared }),
    ];
    const forward = trackToGeoJSON(makeTrack(), events);
    const reversed = trackToGeoJSON(
      makeTrack({ id: trackProps(forward).id }),
      [...events].reverse(),
    );

    expect(JSON.stringify(reversed.geojson.features.slice(1))).toBe(
      JSON.stringify(forward.geojson.features.slice(1)),
    );
  });
});

describe("the media manifest", () => {
  it("carries references only — no bytes, no data URLs", () => {
    const events = [
      event({
        media: [{ id: newId(), mime: "image/jpeg", blobKey: "key-1", width: 4032, height: 3024 }],
      }),
    ];
    const { media, geojson } = trackToGeoJSON(makeTrack(), events);

    expect(media[0]).toMatchObject({ mime: "image/jpeg", blobKey: "key-1", width: 4032 });
    expect(JSON.stringify({ media, geojson })).not.toContain("data:");
    expect(JSON.stringify({ media, geojson })).not.toContain("base64");
  });

  it("lists a shared blob once, even across two events", () => {
    const shared = { id: newId(), mime: "image/jpeg", blobKey: "shared-key" };
    const events = [event({ media: [shared] }), event({ occurredAt: T0 + 1, media: [shared] })];
    const { media } = trackToGeoJSON(makeTrack(), events);

    expect(media).toHaveLength(1);
    expect(media[0]?.blobKey).toBe("shared-key");
  });

  it("keeps distinct media distinct, sorted by id", () => {
    const events = [
      event({
        media: [
          { id: "zzz", mime: "image/jpeg", blobKey: "b" },
          { id: "aaa", mime: "image/png", url: "https://example.invalid/a.png" },
        ],
      }),
    ];
    const { media } = trackToGeoJSON(makeTrack(), events);

    expect(media.map((m) => m.id)).toEqual(["aaa", "zzz"]);
    // Order within an event's own media array is data, and is preserved.
    const feature = trackToGeoJSON(makeTrack(), events).geojson.features[1];
    expect(feature?.properties).toMatchObject({ media: [{ id: "zzz" }, { id: "aaa" }] });
  });
});

describe("import fails closed on malformed documents", () => {
  const validExport = (): TrackExport => trackToGeoJSON(pausedTrack(), []);

  it("rejects a coordTimes array of the wrong length", () => {
    const doc = validExport();
    trackProps(doc).coordTimes[0] = [T0];
    expect(() => geoJSONToTrack(doc)).toThrow(/coordTimes\[0\] has 1 values but segment 0 has 2/);
  });

  it("rejects a channel array with the wrong number of segments", () => {
    const doc = trackToGeoJSON(
      makeTrack({
        points: [
          { lat: 59.33, lng: 18.06, t: T0, channels: { hr: 1 } },
          { lat: 59.34, lng: 18.07, t: T0 + 1000, channels: { hr: 2 } },
          { lat: 59.35, lng: 18.08, t: T0 + 2000, channels: { hr: 3 } },
        ],
      }),
      [],
    );
    const channels = trackProps(doc).channels;
    if (channels === undefined) throw new Error("fixture has no channels");
    channels["hr"] = [[1, 2, 3], [4]];
    expect(() => geoJSONToTrack(doc)).toThrow(/channels\.hr has 2 segments/);
  });

  it("rejects segment properties that do not match the geometry", () => {
    const doc = validExport();
    trackProps(doc).segments.pop();
    expect(() => geoJSONToTrack(doc)).toThrow(/1 segment properties for 2 geometry members/);
  });

  it("rejects a missing timestamp", () => {
    const doc = validExport();
    // Deliberately malformed: a hole where a timestamp must be.
    (trackProps(doc).coordTimes[0] as (number | null)[])[1] = null;
    expect(() => geoJSONToTrack(doc)).toThrow(/coordTimes\[0\]\[1\] is missing/);
  });

  it("surfaces backwards timestamps rather than reordering them", () => {
    const doc = validExport();
    trackProps(doc).coordTimes[0] = [T0 + 60_000, T0];
    expect(() => geoJSONToTrack(doc)).toThrow(TrackTemporalOrderError);
  });

  it("rejects an empty collection", () => {
    expect(() =>
      geoJSONToTrack({ geojson: { type: "FeatureCollection", features: [] }, media: [] }),
    ).toThrow(/empty/);
  });

  it("rejects a document with two track features", () => {
    const doc = validExport();
    const first = doc.geojson.features[0];
    if (first === undefined) throw new Error("fixture has no features");
    doc.geojson.features.push(structuredClone(first));
    expect(() => geoJSONToTrack(doc)).toThrow(/exactly one track feature, found 2/);
  });

  it("rejects the wrong geometry type", () => {
    const doc = validExport();
    const feature = doc.geojson.features[0];
    if (feature === undefined) throw new Error("fixture has no features");
    (feature.geometry as { type: string }).type = "LineString";
    expect(() => geoJSONToTrack(doc)).toThrow(/not a MultiLineString/);
  });

  it("rejects an event with no position", () => {
    const doc = trackToGeoJSON(makeTrack(), [event()]);
    const eventFeature = doc.geojson.features[1];
    if (eventFeature === undefined) throw new Error("fixture has no event feature");
    (eventFeature.geometry as { coordinates: unknown }).coordinates = [];
    expect(() => geoJSONToTrack(doc)).toThrow(TrackImportError);
  });

  it("refuses to export a track that fails its own invariants", () => {
    const points: TrackPoint[] = [
      { lat: 59.33, lng: 18.06, t: T0 },
      { lat: 59.34, lng: 18.07, t: T0 + 1000 },
    ];
    const orphaned = makeTrack({
      points,
      segments: [{ id: newId(), startIndex: 0, endIndex: 0, startedAt: T0 }],
    });
    expect(() => trackToGeoJSON(orphaned, [])).toThrow(TrackCoverageError);
  });
});

describe("defensive copying", () => {
  it("does not let a caller reach into the track through the document", () => {
    const track = finalizeTrack(makeTrack({ tags: ["original"], meta: { a: 1 } }));
    const doc = trackToGeoJSON(track, []);

    trackProps(doc).tags?.push("mutated");
    (trackProps(doc).meta as Record<string, number>)["a"] = 99;

    expect(track.tags).toEqual(["original"]);
    expect(track.meta).toEqual({ a: 1 });
  });

  it("does not let a document reach into an imported track", () => {
    const doc = trackToGeoJSON(makeTrack({ tags: ["original"] }), [event({ tags: ["e"] })]);
    const { track, events } = geoJSONToTrack(doc);

    trackProps(doc).tags?.push("mutated");
    const eventFeature = doc.geojson.features[1];
    if (eventFeature === undefined || eventFeature.properties.kind !== "event") {
      throw new Error("fixture has no event feature");
    }
    eventFeature.properties.tags.push("mutated");

    expect(track.tags).toEqual(["original"]);
    expect(events[0]?.tags).toEqual(["e"]);
  });
});
