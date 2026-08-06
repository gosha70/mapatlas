// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import * as core from "./index";

describe("@mapatlas/core barrel", () => {
  it("re-exports the public runtime surface", () => {
    expect(typeof core.newId).toBe("function");
    expect(typeof core.haversineMeters).toBe("function");
    expect(typeof core.pathLengthMeters).toBe("function");
    expect(typeof core.sample).toBe("function");
    expect(typeof core.simplify).toBe("function");
    expect(typeof core.finalizeTrack).toBe("function");
    expect(typeof core.EventLog).toBe("function");
    expect(typeof core.trackToGeoJSON).toBe("function");
    expect(typeof core.geoJSONToTrack).toBe("function");
    expect(core.noopAnalyzer.id).toBe("noop");
    expect(core.DEFAULT_SAMPLING_POLICY.minDistanceM).toBe(10);
    expect(core.DEFAULT_SIMPLIFY_TOLERANCE_M).toBe(5);
    expect(core.EARTH_RADIUS_M).toBeGreaterThan(6_000_000);
    expect(core.ID_LENGTH).toBe(26);
  });
});
