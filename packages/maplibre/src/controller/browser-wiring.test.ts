// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as BrowserModule from "./browser.js";
import type * as PmtilesModule from "../protocols/pmtiles.js";
import { Protocol } from "pmtiles";

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
    expect(environment.prefersReducedMotion).toBeTypeOf("function");
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

/**
 * `pmtilesArchiveRegistrar` reaches the realm-scoped registration, so each test needs its own
 * realm — the same reason `protocols/pmtiles.test.ts` re-imports rather than exporting a reset.
 */
describe("the archive registrar an offline consumer is handed", () => {
  let browser: typeof BrowserModule;
  let protocols: typeof PmtilesModule;

  beforeEach(async () => {
    vi.resetModules();
    browser = await import("./browser.js");
    protocols = await import("../protocols/pmtiles.js");
  });

  it("registers eagerly, with no controller ever created", () => {
    // The controller registers lazily, when a source stack first needs a Protocol. An offline
    // consumer calls this *before* adding any pmtiles source, so if it inherited that laziness
    // there would be nothing to hand back and archives would go somewhere MapLibre never reads.
    expect(protocols.isPmtilesProtocolRegistered(), "nothing has asked yet").toBe(false);

    const registrar = browser.pmtilesArchiveRegistrar();

    expect(protocols.isPmtilesProtocolRegistered()).toBe(true);
    expect(registrar.add).toBeTypeOf("function");
  });

  it("hands back the same protocol a controller would have registered", () => {
    // One realm, one Protocol. If these diverged, an archive registered through the offline
    // path would be invisible to the map — the failure would look like "offline just does not
    // work", with nothing in the console.
    const fromOffline = browser.pmtilesArchiveRegistrar();
    const fromController = protocols.ensurePmtilesProtocol(
      browser.createBrowserMapEnvironment().protocolRegistrar,
    );

    expect(fromController).toBe(fromOffline);
  });

  it("registers once however many times it is called", () => {
    const first = browser.pmtilesArchiveRegistrar();
    const second = browser.pmtilesArchiveRegistrar();

    expect(second).toBe(first);
  });

  it("is a real pmtiles Protocol, not a stand-in that accepts archives and forgets them", () => {
    // `add` has to be `Protocol.add` — the method that makes the protocol resolve an archive's
    // url from the instance instead of the network. A plausible object with an `add` would
    // satisfy every assertion above and serve nothing.
    const registrar = browser.pmtilesArchiveRegistrar();

    expect(registrar).toBeInstanceOf(Protocol);
  });
});
