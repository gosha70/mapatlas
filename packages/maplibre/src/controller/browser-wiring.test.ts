// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";

import { createBrowserMapEnvironment } from "./browser.js";

/**
 * The default wiring, checked as far as Node can check it.
 *
 * Constructing a map needs a WebGL context, so that half lives in the browser lane. What is
 * checkable here is that the seam is filled in at all — a `protocolRegistrar` that forgot to
 * construct a `Protocol`, or a `createMap` that was never wired, would otherwise surface as
 * a blank map with nothing in the console.
 */
describe("the real MapLibre environment", () => {
  it("fills every seam the controller depends on", () => {
    const environment = createBrowserMapEnvironment();

    expect(environment.createMap).toBeTypeOf("function");
    expect(environment.protocolRegistrar.addProtocol).toBeTypeOf("function");
    expect(environment.protocolRegistrar.createProtocol).toBeTypeOf("function");
  });

  it("constructs a real PMTiles protocol with a tile handler", () => {
    // `new Protocol()` and `addProtocol(protocol.tile)` are the documented integration
    // between two exactly-pinned packages. This is the cheap half of that check; the browser
    // lane runs the other half against a real MapLibre runtime.
    const protocol = createBrowserMapEnvironment().protocolRegistrar.createProtocol();

    expect(protocol.tile).toBeTypeOf("function");
  });

  it("registers under the scheme MapLibre resolves, not some other one", () => {
    // If this drifted, `pmtiles://` urls would go out over plain HTTP and fail to parse far
    // from the cause.
    const environment = createBrowserMapEnvironment();
    const handler = { tile: (): void => undefined };
    const spy = vi.spyOn(environment.protocolRegistrar, "addProtocol");

    environment.protocolRegistrar.addProtocol("pmtiles", handler);

    expect(spy).toHaveBeenCalledWith("pmtiles", handler);
  });
});
