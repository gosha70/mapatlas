// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import * as renderer from "./index.js";

describe("the package surface", () => {
  it("publishes no translation internals", () => {
    // Deliberately exact. The builders and the protocol bootstrap are both absent: the
    // builders because exporting them would put MapLibre's style specifications on this
    // package's public surface, and the bootstrap because registering a global handler is
    // a runtime capability the controller owns, not a side effect of describing a source.
    expect(Object.keys(renderer).sort()).toEqual(["PACKAGE_NAME", "createMapController"]);
  });

  it("reports its identity", () => {
    expect(renderer.PACKAGE_NAME).toBe("@mapatlas/maplibre");
  });

  it("publishes the complete controller factory", () => {
    expect(renderer.createMapController).toBeTypeOf("function");
  });

  it("can be imported without a browser, a map, or maplibre-gl at runtime", () => {
    // The whole point of keeping the translation pure: this test runs in Node with no DOM
    // and no WebGL, and it imports the real module rather than a stand-in.
    expect(renderer.PACKAGE_NAME).toBeTypeOf("string");
    expect(globalThis).not.toHaveProperty("document");
  });
});
