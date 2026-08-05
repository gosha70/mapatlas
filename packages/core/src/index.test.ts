// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import * as core from "./index.js";

describe("@mapatlas/core public surface", () => {
  it("exposes a bumped version marker", () => {
    expect(core.VERSION).toBe("0.1.0");
  });

  it("re-exports the geometry, sampling, simplify, and portability API", () => {
    expect(typeof core.newId).toBe("function");
    expect(typeof core.haversineM).toBe("function");
    expect(typeof core.sample).toBe("function");
    expect(typeof core.simplify).toBe("function");
    expect(typeof core.finalizeTrack).toBe("function");
    expect(typeof core.trackToGeoJSON).toBe("function");
    expect(typeof core.geoJSONToTrack).toBe("function");
    expect(core.EventLog).toBeTypeOf("function");
    expect(core.noopAnalyzer.id).toBe("noop");
  });
});
