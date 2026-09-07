// @vitest-environment happy-dom
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";

import { geoJSONToTrack } from "@mapatlas/core";
import type { MapEvent, Track } from "@mapatlas/core";

import { buildTripExport, downloadDocument } from "./export.js";

/**
 * A trip carrying every kind of thing the model can hold, because the criterion is a round trip
 * and a round trip over a bare two-point track proves almost nothing: the fields most easily
 * dropped — altitude, a pause, a lap, a channel, an event's `fields` — are exactly the ones a
 * thinner fixture would never notice missing.
 */
const TRACK: Track = {
  id: "trip-1",
  startedAt: 1_000,
  endedAt: 4_000,
  status: "finalized",
  origin: "recorded",
  points: [
    { lat: 45.84, lng: 6.86, t: 1_000, altitudeM: 1_200, channels: { tempC: 4 } },
    { lat: 45.841, lng: 6.861, t: 2_000, altitudeM: 1_215, channels: { tempC: 3 } },
    { lat: 45.842, lng: 6.862, t: 3_000, altitudeM: 1_230, channels: { tempC: 2 } },
  ],
  // Two segments: a pause between them, which a naive exporter smooths into one line.
  segments: [
    { id: "s1", startIndex: 0, endIndex: 1, startedAt: 1_000, endedAt: 2_000 },
    { id: "s2", startIndex: 2, endIndex: 2, startedAt: 3_000, endedAt: 3_000 },
  ],
  // **A complete `TrackLap`, and the cast is gone.** The first version wrote `{ startIndex,
  // endIndex, label }` behind `as unknown as Track`, which compiled and round-tripped — import
  // copies laps without validating them, so an impossible lap survives a round trip exactly as
  // a real one does. The test then proved nothing about laps at all. Typechecking the fixture
  // is what makes the claim mean something.
  laps: [{ id: "l1", index: 0, startIndex: 0, endIndex: 1, startedAt: 1_000, label: "first" }],
  channels: [{ key: "tempC", label: "Temperature", unit: "°C" }],
  tags: ["survey"],
  meta: { note: "carried through" },
};

const EVENTS: MapEvent[] = [
  {
    id: "e1",
    trackId: "trip-1",
    position: { lat: 45.8405, lng: 6.8605 },
    occurredAt: 1_500,
    comment: "a note",
    category: "observation",
    media: [{ id: "m1", mime: "image/jpeg", blobKey: "blob-1" }],
    tags: ["seen"],
    fields: { count: 3 },
  },
];

describe("the exported document", () => {
  it("parses as JSON, and is a GeoJSON FeatureCollection", () => {
    // **Why the file is the collection and not `TrackExport`.** A wrapper carrying
    // `{ geojson, media }` round-trips perfectly and is not GeoJSON — which the round-trip test
    // below would never catch, because import reads `exported.geojson` either way.
    const parsed: unknown = JSON.parse(buildTripExport(TRACK, EVENTS).json);

    expect((parsed as { type: string }).type).toBe("FeatureCollection");
    expect(Array.isArray((parsed as { features: unknown }).features)).toBe(true);
  });

  it("round-trips the trip's canonical state", () => {
    // Equality is over the canonical state (api.md §10) — `simplifiedSegments` is a derived cache
    // omitted by design and regenerated on import, so comparing whole objects would fail on the
    // one field the contract says not to carry.
    const doc = buildTripExport(TRACK, EVENTS);

    const back = geoJSONToTrack({ geojson: JSON.parse(doc.json) as never, media: [...doc.media] });

    // Altitude rides in the coordinate as `[lng, lat, altitude]` rather than as a property,
    // so it is the field most easily lost to an exporter that writes two-element positions.
    expect(back.track.points).toStrictEqual(TRACK.points);
    expect(back.track.segments).toStrictEqual(TRACK.segments);
    expect(back.track.laps).toStrictEqual(TRACK.laps);
    expect(back.track.channels).toStrictEqual(TRACK.channels);
    expect(back.track.origin).toBe(TRACK.origin);
    expect(back.track.tags).toStrictEqual(TRACK.tags);
    expect(back.track.meta).toStrictEqual(TRACK.meta);
  });

  it("round-trips the events, including what the engine assigns no meaning to", () => {
    // `fields`, `category` and `tags` are consumer data the engine only carries. They are the
    // most droppable things in the document precisely because nothing in the engine reads them.
    const doc = buildTripExport(TRACK, EVENTS);

    const back = geoJSONToTrack({ geojson: JSON.parse(doc.json) as never, media: [...doc.media] });

    expect(back.events).toStrictEqual(EVENTS);
  });

  it("references the photo rather than inlining its bytes", () => {
    // Media travels by reference (api.md §10). A file that inlined a photo would round-trip and
    // would also be unbounded in size — the failure shows up on a real trip, not in a test.
    const doc = buildTripExport(TRACK, EVENTS);

    expect(doc.json).toContain("blob-1");
    expect(doc.json, "a data: URI reached the document").not.toContain("data:");
    expect(doc.json).not.toContain("base64");
  });

  it("reports the media it references but does not carry", () => {
    // The obligation this makes visible: exporting a trip with photos and moving only the
    // .geojson moves a document whose references resolve to nothing.
    const doc = buildTripExport(TRACK, EVENTS);

    expect(doc.media).toHaveLength(1);
    expect(doc.media[0]?.blobKey).toBe("blob-1");
  });

  it("names the file after the trip, not a constant", () => {
    // A name that sorts is worth more than one that is merely unique, so the start time leads.
    const doc = buildTripExport(TRACK, EVENTS);

    expect(doc.filename).toBe("trip-1970-01-01T00-00-01-trip-1.geojson");
  });

  it("does not collide for two trips begun in the same second", () => {
    // **The gap this closes.** The stamp is second-resolution, so the timestamp alone gave two
    // distinct trips the same name — and a downloads folder resolves that by silently
    // overwriting or appending `(1)`, neither of which says two different trips were involved.
    const first = buildTripExport({ ...TRACK, id: "trip-1", startedAt: 1_000 }, []);
    const second = buildTripExport({ ...TRACK, id: "trip-2", startedAt: 1_999 }, []);

    expect(second.filename).not.toBe(first.filename);
  });

  it("keeps ids that are already filename-safe readable", () => {
    // The encoding must not be gratuitously ugly for the common case: an id a filename can
    // already hold passes through unchanged.
    expect(buildTripExport({ ...TRACK, id: "trip-1" }, []).filename).toContain("-trip-1.geojson");
  });

  it("keeps distinct ids distinct, even when every unsafe run looks alike", () => {
    // **The defect this replaced.** The first encoder replaced each run of unsafe characters
    // with `-`, which is many-to-one: all four of these became `a-b`, so two distinct trips
    // begun in the same second still collided — the exact failure the id was added to prevent.
    // A sanitiser is not an encoder.
    const ids = ["a/b", "a b", "a:b", "a-b", "a_b"];

    const names = ids.map((id) => buildTripExport({ ...TRACK, id, startedAt: 1_000 }, []).filename);

    expect(new Set(names).size, `collapsed: ${names.join(", ")}`).toBe(ids.length);
  });

  it("keeps the escape width fixed, so an escape cannot run into a literal", () => {
    // **Why four digits and not the two a byte needs.** At width two, `\u0100` encodes to `_100`
    // — and so does `\u0010` followed by a literal `0`, because the escape ends wherever the
    // reader decides it does. Fixed width is what makes the boundary unambiguous, and this pair
    // is the one that exhibits it.
    const wide = buildTripExport({ ...TRACK, id: "\u0100", startedAt: 1_000 }, []).filename;
    const narrowThenDigit = buildTripExport(
      { ...TRACK, id: "\u00100", startedAt: 1_000 },
      [],
    ).filename;

    expect(wide).not.toBe(narrowThenDigit);
  });

  it("names an empty id something no other id can produce", () => {
    // A readable placeholder such as "trip" is a collision: the id `trip` produces it too. A bare
    // `_` cannot be produced, because every `_` the encoder emits carries four hex digits.
    const empty = buildTripExport({ ...TRACK, id: "", startedAt: 1_000 }, []).filename;
    const named = buildTripExport({ ...TRACK, id: "trip", startedAt: 1_000 }, []).filename;

    expect(empty).not.toBe(named);
  });

  it("does not let an id spell another id's escape sequence", () => {
    // **The forgery, and the pair that actually exhibits it.** If `_` were passed through as a
    // safe character, the id `a b` would encode to `a_0020b` — which is exactly what the literal
    // id `a_0020b` produces, so two distinct trips would collide again. Escaping `_` itself is
    // what closes it. An earlier version of this test compared `a_005Fb` with `a_b`, which stay
    // distinct either way and so proved nothing.
    const spaced = buildTripExport({ ...TRACK, id: "a b", startedAt: 1_000 }, []).filename;
    const literal = buildTripExport({ ...TRACK, id: "a_0020b", startedAt: 1_000 }, []).filename;

    expect(literal).not.toBe(spaced);
  });

  it("exports the same bytes however the events were ordered", () => {
    // api.md §10 promises determinism. Two consumers exporting the same trip must be able to
    // diff the files.
    const second: MapEvent = { ...EVENTS[0]!, id: "e2", occurredAt: 2_500 };

    const forward = buildTripExport(TRACK, [EVENTS[0]!, second]).json;
    const reversed = buildTripExport(TRACK, [second, EVENTS[0]!]).json;

    expect(reversed).toBe(forward);
  });
});

describe("handing the file to the browser", () => {
  const withUrlSpies = (): { created: string[]; revoked: string[] } => {
    const created: string[] = [];
    const revoked: string[] = [];
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => {
      const url = `blob:demo/${String(created.length)}`;
      created.push(url);
      return url;
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation((url: string) => {
      revoked.push(url);
    });
    return { created, revoked };
  };

  it("offers the document under its own name and leaves no anchor behind", () => {
    const spies = withUrlSpies();
    const doc = buildTripExport(TRACK, EVENTS);

    downloadDocument(doc);

    expect(spies.created).toHaveLength(1);
    expect(document.querySelectorAll("a"), "the anchor outlived the download").toHaveLength(0);
    vi.restoreAllMocks();
  });

  it("revokes the object URL, so repeated exports do not pin blobs in memory", () => {
    // An un-revoked URL holds the whole blob for the life of the document. A field logger
    // exporting repeatedly is exactly the shape that turns that into a leak nobody attributes
    // to export.
    const spies = withUrlSpies();

    downloadDocument(buildTripExport(TRACK, EVENTS));
    downloadDocument(buildTripExport(TRACK, EVENTS));

    expect(spies.revoked).toStrictEqual(spies.created);
    vi.restoreAllMocks();
  });
});
