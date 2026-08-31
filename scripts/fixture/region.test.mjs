// SPDX-License-Identifier: Apache-2.0
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ElevationFloorError,
  RegionDeclarationError,
  assertMinimumElevation,
  loadRegionDeclaration,
  parseRegionDeclaration,
} from "./region.mjs";

const REGION_PATH = fileURLToPath(new URL("../../fixtures/vertical/region.json", import.meta.url));

const REGION = {
  id: "test-region",
  bounds: [6.825, 45.815, 6.905, 45.865],
  minElevationM: 2500,
  minElevationJustification: "The declared threshold is above the regional treeline.",
  minZoom: 11,
  maxZoom: 12,
};

describe("the checked-in region declaration", () => {
  it("pins the selected bounds, floor, zoom range, and the reasons for them", () => {
    expect(loadRegionDeclaration(REGION_PATH)).toEqual({
      id: "mont-blanc-summit",
      bounds: [6.825, 45.815, 6.905, 45.865],
      minElevationM: 2500,
      minElevationJustification: expect.stringContaining("2200–2350 m"),
      minZoom: 11,
      maxZoom: 12,
    });
  });
});

describe("region declaration validation", () => {
  it.each([
    { value: null, problem: "expected an object" },
    { value: { ...REGION, id: "" }, problem: "id" },
    { value: { ...REGION, bounds: [6, 45, 6] }, problem: "bounds" },
    { value: { ...REGION, bounds: [7, 45, 6, 46] }, problem: "west must precede east" },
    { value: { ...REGION, minElevationM: Number.NaN }, problem: "minElevationM" },
    { value: { ...REGION, minZoom: -1 }, problem: "minZoom must be an integer" },
    { value: { ...REGION, maxZoom: 1.5 }, problem: "maxZoom must be an integer" },
    { value: { ...REGION, minZoom: 12, maxZoom: 11 }, problem: "precedes minZoom" },
    {
      value: { ...REGION, minElevationJustification: "   " },
      problem: "minElevationJustification",
    },
  ])("refuses a declaration where $problem is not reviewable", ({ value, problem }) => {
    expect(() => parseRegionDeclaration(value)).toThrow(RegionDeclarationError);
    expect(() => parseRegionDeclaration(value)).toThrow(problem);
  });
});

describe("the minimum-elevation floor", () => {
  it("checks every tile and returns the cut's true lowest sample", async () => {
    const lowest = await assertMinimumElevation(REGION, [
      { tileId: "N45E006", elevationsM: new Float32Array([3100, 2800, 2700]) },
      { tileId: "N45E007", elevationsM: new Float32Array([2900, 2550, 2600]) },
    ]);

    expect(lowest).toEqual({ elevationM: 2550, tileId: "N45E007", sampleIndex: 1 });
  });

  it("names the first tile holding an equal minimum, not the last", async () => {
    // Ties would otherwise be decided by whichever comparison the implementation happened to
    // use, and "the failure names the tile" is an obligation rather than a nicety: with the
    // same minimum in two tiles, `<=` would report N45E007 and `<` reports N45E006, so an
    // unrelated reordering of the cut would change the tile a reader is sent to. Pinned to
    // first-encountered because that is the rule someone can predict.
    expect(
      await assertMinimumElevation(REGION, [
        { tileId: "N45E006", elevationsM: new Float32Array([3000, 2700]) },
        { tileId: "N45E007", elevationsM: new Float32Array([2700, 3100]) },
      ]),
    ).toEqual({ elevationM: 2700, tileId: "N45E006", sampleIndex: 1 });
  });

  it("accepts a sample exactly on the declared floor", async () => {
    expect(
      await assertMinimumElevation(REGION, [
        { tileId: "N45E006", elevationsM: new Float32Array([2500]) },
      ]),
    ).toEqual({ elevationM: 2500, tileId: "N45E006", sampleIndex: 0 });
  });

  it("fails with the lowest sample, its tile, and the declared floor", async () => {
    await expect(
      assertMinimumElevation(REGION, [
        { tileId: "N45E006", elevationsM: new Float32Array([2499, 2401]) },
        { tileId: "N45E007", elevationsM: new Float32Array([2302, 2700]) },
      ]),
    ).rejects.toThrow(
      'region "test-region": lowest sample 2302 m at N45E007[0] is below the declared floor 2500 m',
    );
  });

  it("refuses a non-finite sample instead of letting the comparison pass vacuously", async () => {
    await expect(
      assertMinimumElevation(REGION, [
        { tileId: "N45E006", elevationsM: new Float32Array([2700, Number.NaN]) },
      ]),
    ).rejects.toThrow("N45E006[1] is not a finite elevation: NaN");
  });

  it("refuses an empty tile even when another tile has samples", async () => {
    await expect(
      assertMinimumElevation(REGION, [
        { tileId: "N45E006", elevationsM: new Float32Array([2700]) },
        { tileId: "N45E007", elevationsM: new Float32Array() },
      ]),
    ).rejects.toThrow("N45E007 contains no elevation samples");
  });

  it("refuses an empty cut instead of declaring it above the floor", async () => {
    await expect(assertMinimumElevation(REGION, [])).rejects.toThrow(ElevationFloorError);
    await expect(assertMinimumElevation(REGION, [])).rejects.toThrow(
      "cannot check the declared floor without elevation samples",
    );
  });
});
