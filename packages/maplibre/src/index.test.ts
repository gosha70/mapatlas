// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import * as renderer from "./index.js";

describe("the package surface", () => {
  it("exports the builders and nothing that needs a runtime", () => {
    // Deliberately exact. The protocol bootstrap is absent: it is a runtime capability the
    // controller owns, and exporting it here would invite a consumer to register a global
    // handler as a side effect of describing a source.
    expect(Object.keys(renderer).sort()).toEqual([
      "PACKAGE_NAME",
      "PMTILES_SCHEME",
      "TileSourceError",
      "buildLapFeatures",
      "buildTileSource",
      "buildTileSources",
      "buildTrackEndpointFeatures",
      "buildTrackLineFeatures",
      "resolveRole",
      "segmentGeometry",
      "usesPmtiles",
    ]);
  });

  it("reports its identity", () => {
    expect(renderer.PACKAGE_NAME).toBe("@mapatlas/maplibre");
  });

  it("can be imported without a browser, a map, or maplibre-gl at runtime", () => {
    // The whole point of keeping the builders pure: this test runs in Node with no DOM and
    // no WebGL, and it exercises the real module rather than a stand-in.
    expect(typeof renderer.buildTileSources).toBe("function");
    expect(renderer.buildTileSources([])).toEqual([]);
  });
});
