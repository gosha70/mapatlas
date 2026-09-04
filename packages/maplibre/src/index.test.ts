// SPDX-License-Identifier: Apache-2.0
// @vitest-environment node
//
// Stated locally, not inherited. This file's central claim is that the package root imports
// without a DOM, and the project default happening to be `node` is not the same as this test
// requiring it: flip that default and the assertion below stops asserting what it says. The
// pragma makes the requirement the file's own.
import { describe, expect, it } from "vitest";

import * as renderer from "./index.js";

describe("the package surface", () => {
  it("publishes no translation internals", () => {
    // Deliberately exact. The builders stay absent because exporting them would put MapLibre's
    // style specifications on this package's public surface. `ensurePmtilesProtocol` stays
    // absent too: registering a global handler is a runtime capability the controller owns,
    // not a side effect of describing a source.
    //
    // `pmtilesArchiveRegistrar` is the one thing published from that area, and only because
    // an offline archive store cannot otherwise reach the `Protocol` MapLibre resolves through
    // (ADR-0036). It returns the instance; it does not expose registration.
    expect(Object.keys(renderer).sort()).toEqual([
      "PACKAGE_NAME",
      "createMapController",
      "pmtilesArchiveRegistrar",
    ]);
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
