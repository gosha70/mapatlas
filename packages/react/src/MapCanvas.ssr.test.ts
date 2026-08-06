// SPDX-License-Identifier: Apache-2.0
// @vitest-environment node

/**
 * T5.2 acceptance (the SSR half): importing `@mapatlas/react` in a
 * window-less environment must not evaluate Leaflet or touch `window`. Leaflet
 * is loaded lazily inside `<MapCanvas>`'s effect, so a bare import is safe.
 */
import { describe, expect, it } from "vitest";

describe("MapCanvas SSR-safety", () => {
  it("imports with no window/document present", async () => {
    expect(typeof globalThis).toBe("object");
    // No DOM in this environment:
    expect("window" in globalThis).toBe(false);

    const mod = await import("./index.js");
    expect(typeof mod.MapCanvas).toBe("function");
    expect(typeof mod.useTrackRecorder).toBe("function");
  });
});
