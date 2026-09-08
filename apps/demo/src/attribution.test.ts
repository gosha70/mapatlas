// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { BASEMAP_ATTRIBUTION, FIXTURE_ATTRIBUTION } from "./attribution.js";

/** The checked-in notice the build writes into the archive. */
const notice = JSON.parse(
  readFileSync(new URL("../../../fixtures/basemap/notice.json", import.meta.url), "utf8"),
) as { credit: string; licence: string; licenceUri: string; sourceUri: string };

describe("the rendered attribution and the archive's own notice", () => {
  // **Two halves, and this file is one of them.** This asserts the *rendered* constant equals
  // the notice; `scripts/fixture/build-fixture.test.mjs` asserts the *built archive's*
  // `metadata.attribution` equals the same notice-derived string, exactly rather than by
  // substring. Both compare against `notice.json`, so the map and the archive are pinned to one
  // text and cannot drift apart while each stays self-consistent.
  it("says exactly what the archive is built to say", () => {
    // **The drift this prevents.** `runBuild` composes the archive's `attribution` from
    // `notice.json`; this constant is composed by hand for the map control. Two hand-kept copies
    // of a licence obligation are two chances for one to be edited into something the licence
    // does not say — and the page that drifted would keep rendering, keep passing, and be in
    // breach. Composed the same way here, so the comparison is exact rather than approximate.
    const fromNotice =
      `${notice.credit} — data available under the ` +
      `${notice.licence}, ${notice.licenceUri} — source ${notice.sourceUri}`;

    expect(BASEMAP_ATTRIBUTION).toBe(fromNotice);
  });

  it("carries the credit the guidelines mandate, verbatim", () => {
    // `© OpenStreetMap contributors` is the form the OSMF attribution guidelines accept; a
    // paraphrase is not attribution.
    expect(BASEMAP_ATTRIBUTION).toContain("© OpenStreetMap contributors");
  });

  it("makes clear the data is available under ODbL", () => {
    // The second thing osm.org/copyright requires of a user of its data, and what ODbL §4.3 asks
    // of a Produced Work. A credit alone discharges neither.
    expect(BASEMAP_ATTRIBUTION).toContain("Open Database License (ODbL)");
    expect(BASEMAP_ATTRIBUTION).toContain("https://opendatacommons.org/licenses/odbl/1-0/");
  });

  it("is a different obligation from the DEM's, not a replacement for it", () => {
    // Two derived works from two unrelated sources. A control showing one line is in breach for
    // whichever source it left out, so neither string may absorb the other.
    expect(BASEMAP_ATTRIBUTION).not.toContain("Copernicus");
    expect(FIXTURE_ATTRIBUTION).not.toContain("OpenStreetMap");
  });
});
