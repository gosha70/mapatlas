// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { FIXTURE_ATTRIBUTION } from "../attribution.js";
import { labTileSources } from "./lab.js";

/**
 * `/lab`'s stack carries the archives' licence line.
 *
 * **Why this file exists at all.** Consolidating the attribution into one constant made a gap
 * visible that the inline literal had hidden: dropping `attribution` from either of `/lab`'s two
 * sources passed the entire unit suite — 74 files, 1593 tests, green. The demo app's own check
 * guards the *constant*; nothing guarded `/lab` still passing it, and a map that renders without
 * its attribution is a licence breach that looks like a working map (ADR-0024).
 *
 * Verbatim, and on both sources: terrain and contours are separate archives (ADR-0025), each a
 * derived work in its own right, so one carrying the line does not cover the other.
 */
describe("labTileSources", () => {
  it("attributes both archives, with the licence's own words", () => {
    const tiles = labTileSources({
      terrainUrl: "https://a.invalid/t.pmtiles",
      contourUrl: "https://a.invalid/c.pmtiles",
    });

    expect(tiles).toHaveLength(2);
    for (const tile of tiles) expect(tile.attribution, tile.id).toBe(FIXTURE_ATTRIBUTION);
  });
});
