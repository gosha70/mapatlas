// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

/**
 * The SSR proof for `TripReview`, in the environment where `window` genuinely does not exist.
 *
 * `TripReview` composes `MapCanvas`, so it inherits that module's import chain into
 * `@mapatlas/maplibre` and transitively `maplibre-gl` — the same chain T5.2's AC constrains.
 * Inheriting the property is not the same as keeping it: this module could break SSR on its own
 * by adding a top-level import that touches the DOM, and the closure increment would then be
 * the first place it showed up, in a commit about exports.
 *
 * The import is dynamic and inside the body, after asserting the globals are absent — a static
 * import runs before any assertion and leaves "there was no DOM when it happened" an inference
 * rather than evidence.
 */
describe("TripReview — server-side rendering", () => {
  it("imports without a DOM and renders to a string without constructing a controller", async () => {
    expect(typeof window, "this lane must have no window").toBe("undefined");
    expect(typeof document, "this lane must have no document").toBe("undefined");

    const { TripReview } = await import("./trip-review.js");
    const { createElement } = await import("react");
    const { renderToString } = await import("react-dom/server");

    const html = renderToString(
      createElement(TripReview, {
        track: { id: "t1", startedAt: 1_000, endedAt: 1_000, points: [], segments: [] },
        events: [],
        store: {},
        sources: [
          {
            id: "base",
            kind: "raster",
            tiles: ["https://example.invalid/{z}/{x}/{y}.png"],
            attribution: "x",
          },
        ],
      } as never),
    );

    expect(html, "the review region must render server-side").toContain("mapatlas-trip-review");
  });
});
