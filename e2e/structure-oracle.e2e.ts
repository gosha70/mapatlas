// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";

import { structuralDifference, structureOf } from "./fixtures/structure.js";
import { GPS_ONLY, SENSOR_CHANNEL_ONLY } from "./fixtures/track-shape.js";

/**
 * The structural oracle, tested before anything is asserted with it.
 *
 * **Why here and not in the unit lane.** `vitest.config.ts` excludes `e2e/**` on purpose — that
 * lane stays browser-free — so a fixture used only by browser scenarios has no unit runner.
 * `rendered-oracle.e2e.ts` set the precedent: an oracle whose job is to *fail* has to be shown
 * failing somewhere, or a bug in it makes every scenario that leans on it green for nothing.
 *
 * These need no page and open none.
 */

const RECORDED = {
  id: "t1",
  origin: "recorded",
  points: [
    { lat: 1, lng: 2, t: 10, accuracyM: 5 },
    { lat: 1.1, lng: 2.1, t: 20, accuracyM: 4 },
  ],
  stats: { distanceM: 12.5 },
};

const AUTHORED = {
  id: "t2",
  origin: "authored",
  // Three points rather than two, and no `accuracyM`: a different length and a GPS field the
  // recorder supplied. One of those is a value difference and one is structural.
  points: [
    { lat: 3, lng: 4, t: 100 },
    { lat: 3.1, lng: 4.1, t: 200 },
    { lat: 3.2, lng: 4.2, t: 300 },
  ],
  stats: { distanceM: 40 },
};

test("two documents of the same shape differ in nothing, whatever they hold", () => {
  // Different ids, different coordinates, different point counts, different stats — every value
  // here differs, and the comparison is about none of it.
  expect(
    structuralDifference(
      RECORDED,
      { ...AUTHORED, points: AUTHORED.points.slice(0, 2) },
      {
        optional: ["points[].accuracyM"],
      },
    ),
  ).toStrictEqual([]);
});

test("array length is a value, so a longer array is not a difference", () => {
  // Two trips have different numbers of points. A comparison that noticed would fail for a
  // reason the criterion does not care about.
  expect(
    structuralDifference(RECORDED, AUTHORED, { optional: ["points[].accuracyM"] }),
  ).toStrictEqual([]);
});

test("a field only one side carries is reported, at its path", () => {
  // The undeclared case: without the declaration, the GPS field the recorder supplied is exactly
  // the difference this oracle must surface.
  expect(structuralDifference(RECORDED, AUTHORED, { optional: [] })).toStrictEqual([
    "only in a: points[].accuracyM:number",
  ]);
});

test("a field on only some elements of an array still counts as present", () => {
  // The union is what makes a recorder that supplied `accuracyM` for one fix out of fifty
  // visible. Per-index comparison would call it absent and pass.
  const mixed = {
    points: [
      { lat: 1, lng: 2 },
      { lat: 1, lng: 2, accuracyM: 5 },
    ],
  };
  const none = { points: [{ lat: 1, lng: 2 }] };

  expect(structuralDifference(mixed, none, { optional: [] })).toStrictEqual([
    "only in a: points[].accuracyM:number",
  ]);
});

test("a key that changed type is a difference, in both directions", () => {
  // Same key, different kind of thing: reported from both sides rather than silently accepted
  // because the key exists on both.
  expect(structuralDifference({ id: "a" }, { id: 7 }, { optional: [] })).toStrictEqual([
    "only in a: id:string",
    "only in b: id:number",
  ]);
});

test("a declaration suppresses its own path and nothing else", () => {
  // The property that keeps a declaration from being a blanket. Two fields differ; one is
  // declared; the other must still be reported.
  const a = { points: [{ lat: 1, accuracyM: 5, speedMps: 2 }] };
  const b = { points: [{ lat: 1 }] };

  expect(structuralDifference(a, b, { optional: ["points[].accuracyM"] })).toStrictEqual([
    "only in a: points[].speedMps:number",
  ]);
});

test("a declaration covers what is under the path, not only the path", () => {
  /**
   * **Why a declaration has to reach downwards.** The same field is a number on a track point and
   * an array of numbers in the exported document, which spells it `accuracyM[]` and
   * `accuracyM[][]`. A declaration that matched only the exact path would leave those to be
   * enumerated by hand — and an enumeration grown from whatever the last red run printed is not a
   * rule anyone stated in advance.
   */
  const a = { properties: { accuracyM: [[5, 4]] } };
  const b = { properties: {} };

  expect(structuralDifference(a, b, { optional: ["properties.accuracyM"] })).toStrictEqual([]);
});

test("a declaration stops at a path boundary, not at a shared prefix", () => {
  // Otherwise declaring `accuracyM` would quietly silence `accuracyMore` as well, and the
  // declaration would be wider than the sentence describing it.
  const a = { points: [{ accuracyM: 5, accuracyMore: 1 }] };
  const b = { points: [{}] };

  expect(structuralDifference(a, b, { optional: ["points[].accuracyM"] })).toStrictEqual([
    "only in a: points[].accuracyMore:number",
  ]);
});

test("the root is compared, so an array and an object differ there", () => {
  expect(structuralDifference([], {}, { optional: [] })).toStrictEqual([
    "only in a: :array",
    "only in b: :object",
  ]);
});

test("null is its own kind, not an object and not absent", () => {
  // `typeof null` is "object", which would let a null stand in for a nested document.
  expect(structuralDifference({ a: null }, { a: { b: 1 } }, { optional: [] })).toStrictEqual([
    "only in a: a:null",
    "only in b: a.b:number",
    "only in b: a:object",
  ]);
});

test("the structure of a document names every path it contains", () => {
  // The building block the rest rests on, asserted directly rather than only through differences.
  expect([...structureOf({ a: [{ b: "x" }] })].sort()).toStrictEqual([
    ":object",
    "a:array",
    "a[].b:string",
    "a[]:object",
  ]);
});

test("the sensor declaration exempts the model's channel state and not a consumer's", () => {
  /**
   * **The discriminator for the declaration itself, not for the mechanism.** An earlier version
   * matched any segment named `channels`, wherever it occurred. That reads well and is wrong:
   * `Track.meta` is `Record<string, JSONValue>` and belongs to the consumer, so a payload with a
   * `channels` key of its own would have vanished from the comparison — the declaration widening
   * past what it names, which is the failure the plan's mutation list calls out by name.
   *
   * So the real list is asserted here: the model's own channel state is exempt, and an identically
   * named thing under consumer JSON is still compared.
   */
  const withSensor = {
    channels: [{ key: "cadence" }],
    points: [{ lat: 1, channels: { cadence: 60 } }],
    stats: { channels: { cadence: { avg: 60 } } },
    meta: { channels: { one: 1 } },
  };
  const withoutSensor = {
    points: [{ lat: 1 }],
    stats: {},
    meta: { channels: { two: "a different shape" } },
  };

  expect(
    structuralDifference(withSensor, withoutSensor, { optional: SENSOR_CHANNEL_ONLY }),
  ).toStrictEqual(["only in a: meta.channels.one:number", "only in b: meta.channels.two:string"]);
});

test("the sensor declaration exempts the exported spellings too, and no more", () => {
  // The export keeps the same state under its own names, and `meta` rides along in the feature's
  // properties exactly as the model carries it.
  const exported = {
    features: [
      {
        properties: {
          channels: { cadence: [[60]] },
          channelDescriptors: [{ key: "cadence" }],
          stats: { channels: { cadence: { avg: 60 } } },
          meta: { channels: { one: 1 } },
        },
      },
    ],
  };
  // `stats` itself is present on both: what the declaration exempts is the channel roll-up
  // inside it, not the object, and a fixture missing the object entirely would be testing that.
  const plain = { features: [{ properties: { stats: {}, meta: {} } }] };

  expect(structuralDifference(exported, plain, { optional: SENSOR_CHANNEL_ONLY })).toStrictEqual([
    "only in a: features[].properties.meta.channels.one:number",
    "only in a: features[].properties.meta.channels:object",
  ]);
});

test("the GPS declaration exempts the five published fields and nothing beside them", () => {
  // `accuracyMore` is not `accuracyM`, and a field the recorder does not supply is not excused by
  // sitting next to ones it does.
  const a = { points: [{ accuracyM: 5, speedMps: 2, invented: true }] };
  const b = { points: [{}] };

  expect(structuralDifference(a, b, { optional: GPS_ONLY })).toStrictEqual([
    "only in a: points[].invented:boolean",
  ]);
});
