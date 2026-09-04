// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as PmtilesModule from "./pmtiles.js";
import type { ProtocolRegistrar } from "./pmtiles.js";

function spyRegistrar(): ProtocolRegistrar & {
  readonly addProtocol: ReturnType<typeof vi.fn>;
  readonly createProtocol: ReturnType<typeof vi.fn>;
} {
  const addProtocol = vi.fn();
  const createProtocol = vi.fn(() => ({ tile: () => undefined, add: () => undefined }));
  return { addProtocol, createProtocol };
}

/**
 * A fresh realm for the module's realm-scoped state.
 *
 * The module exports no reset, because a reset would be production code that exists only
 * for tests and would hand a consumer a way to make a second registration possible. Tests
 * that need to observe a first registration get a new module instance instead.
 */
async function freshModule(): Promise<typeof PmtilesModule> {
  vi.resetModules();
  return import("./pmtiles.js");
}

let pmtiles: typeof PmtilesModule;

beforeEach(async () => {
  pmtiles = await freshModule();
});

describe("registration is once per realm", () => {
  it("registers on the first call", () => {
    const registrar = spyRegistrar();
    expect(pmtiles.isPmtilesProtocolRegistered()).toBe(false);

    pmtiles.ensurePmtilesProtocol(registrar);

    expect(registrar.createProtocol).toHaveBeenCalledTimes(1);
    expect(registrar.addProtocol).toHaveBeenCalledWith("pmtiles", expect.anything());
    expect(pmtiles.isPmtilesProtocolRegistered()).toBe(true);
  });

  it("registers exactly once however many controllers ask", () => {
    // Three maps over one archive is one handler. `addProtocol` installs on the MapLibre
    // runtime, not on a map.
    const registrar = spyRegistrar();
    for (let i = 0; i < 3; i += 1) pmtiles.ensurePmtilesProtocol(registrar);

    expect(registrar.createProtocol).toHaveBeenCalledTimes(1);
    expect(registrar.addProtocol).toHaveBeenCalledTimes(1);
  });

  it("does not construct a Protocol when it is already registered", () => {
    // Constructing one and discarding it would allocate a cache nothing reads.
    const first = spyRegistrar();
    pmtiles.ensurePmtilesProtocol(first);

    const second = spyRegistrar();
    pmtiles.ensurePmtilesProtocol(second);

    expect(second.createProtocol).not.toHaveBeenCalled();
    expect(second.addProtocol).not.toHaveBeenCalled();
  });

  it("survives across importers — the state is the module's, not the caller's", async () => {
    // Two call sites in one realm reach the same registration. Were the flag per-import,
    // the second importer would register a duplicate handler and this would read false.
    const registrar = spyRegistrar();
    pmtiles.ensurePmtilesProtocol(registrar);

    const sameRealm = await import("./pmtiles.js");
    expect(sameRealm.isPmtilesProtocolRegistered()).toBe(true);

    sameRealm.ensurePmtilesProtocol(spyRegistrar());
    expect(registrar.addProtocol).toHaveBeenCalledTimes(1);
  });
});

describe("the registered protocol is the one handed back", () => {
  it("returns the very object whose handler MapLibre received", () => {
    // The mutation this exists for: hand back a fresh `new Protocol()` instead. Everything
    // still registers, every idempotence test still passes, and archives added to the returned
    // object are consulted by nothing — a map that quietly goes to the network, or offline,
    // does not render.
    const registrar = spyRegistrar();
    const returned = pmtiles.ensurePmtilesProtocol(registrar);

    const created = registrar.createProtocol.mock.results[0]?.value as { tile: unknown };
    expect(returned, "identity, not shape").toBe(created);
    expect(registrar.addProtocol).toHaveBeenCalledWith("pmtiles", returned.tile);
  });

  it("hands every later caller that same instance", () => {
    // Two call sites — a controller and an offline archive store — must reach one protocol.
    const first = pmtiles.ensurePmtilesProtocol(spyRegistrar());
    const second = pmtiles.ensurePmtilesProtocol(spyRegistrar());
    expect(second).toBe(first);
  });
});

describe("nothing happens until something asks", () => {
  it("is not registered merely by importing the module", () => {
    // A consumer with no PMTiles sources never constructs a Protocol and never touches the
    // MapLibre global.
    expect(pmtiles.isPmtilesProtocolRegistered()).toBe(false);
  });
});

describe("the module surface", () => {
  it("offers no way to unregister and no test-only escape hatch", () => {
    // Two failures at once. Unregistering: controller A registers, controller B is created,
    // A is destroyed and removes the protocol, B breaks having done nothing wrong — the
    // handler is realm infrastructure, not a property of any one map. And a reset would be
    // production code shipped for tests, reachable by any consumer.
    expect(Object.keys(pmtiles).sort()).toEqual([
      "ensurePmtilesProtocol",
      "isPmtilesProtocolRegistered",
    ]);
  });
});
