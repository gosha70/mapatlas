// SPDX-License-Identifier: Apache-2.0
// @vitest-environment node
import { describe, expect, it } from "vitest";

// T5.2 contract: the package entry point must be importable where there is no
// DOM (server-side rendering). Leaflet touches `window` when it loads, so
// <MapCanvas> imports it dynamically on mount rather than at module scope.
describe("SSR safety", () => {
  it("imports the entry point with no window/document present", async () => {
    expect(typeof window).toBe("undefined");
    expect(typeof document).toBe("undefined");

    const mod = await import("./index");
    expect(typeof mod.MapCanvas).toBe("function");
    expect(typeof mod.EventComposer).toBe("function");
    expect(typeof mod.TripReview).toBe("function");
    expect(typeof mod.useTrackRecorder).toBe("function");
    expect(typeof mod.useEventLog).toBe("function");
    expect(typeof mod.useOfflineRegions).toBe("function");
  });
});
