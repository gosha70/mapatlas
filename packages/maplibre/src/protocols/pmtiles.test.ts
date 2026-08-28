// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ProtocolRegistrar } from "./pmtiles.js";
import {
  ensurePmtilesProtocol,
  isPmtilesProtocolRegistered,
  resetPmtilesProtocolForTests,
} from "./pmtiles.js";

function spyRegistrar(): ProtocolRegistrar & {
  readonly addProtocol: ReturnType<typeof vi.fn>;
  readonly createProtocol: ReturnType<typeof vi.fn>;
} {
  const addProtocol = vi.fn();
  const createProtocol = vi.fn(() => ({ tile: () => undefined }));
  return { addProtocol, createProtocol };
}

beforeEach(() => {
  resetPmtilesProtocolForTests();
});

describe("registration is once per realm", () => {
  it("registers on the first call", () => {
    const registrar = spyRegistrar();
    expect(isPmtilesProtocolRegistered()).toBe(false);

    ensurePmtilesProtocol(registrar);

    expect(registrar.createProtocol).toHaveBeenCalledTimes(1);
    expect(registrar.addProtocol).toHaveBeenCalledWith("pmtiles", expect.anything());
    expect(isPmtilesProtocolRegistered()).toBe(true);
  });

  it("registers exactly once however many controllers ask", () => {
    // Three maps over one archive is one handler. `addProtocol` installs on the MapLibre
    // runtime, not on a map.
    const registrar = spyRegistrar();
    for (let i = 0; i < 3; i += 1) ensurePmtilesProtocol(registrar);

    expect(registrar.createProtocol).toHaveBeenCalledTimes(1);
    expect(registrar.addProtocol).toHaveBeenCalledTimes(1);
  });

  it("does not construct a Protocol when it is already registered", () => {
    // Constructing one and discarding it would allocate a cache nothing reads.
    const first = spyRegistrar();
    ensurePmtilesProtocol(first);

    const second = spyRegistrar();
    ensurePmtilesProtocol(second);

    expect(second.createProtocol).not.toHaveBeenCalled();
    expect(second.addProtocol).not.toHaveBeenCalled();
  });
});

describe("nothing happens until something asks", () => {
  it("is not registered merely by importing the module", () => {
    // A consumer with no PMTiles sources never constructs a Protocol and never touches the
    // MapLibre global.
    expect(isPmtilesProtocolRegistered()).toBe(false);
  });
});

describe("there is no unregister", () => {
  it("exposes no way for one controller to tear it down for another", () => {
    // The failure this prevents: controller A registers, controller B is created, A is
    // destroyed and removes the protocol, B breaks having done nothing wrong. The handler
    // is infrastructure shared by every map in the realm, not a property of any one.
    expect(
      Object.keys({ ensurePmtilesProtocol, isPmtilesProtocolRegistered }).some((name) =>
        /remove|unregister|destroy/i.test(name),
      ),
    ).toBe(false);
  });
});
