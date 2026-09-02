// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

/**
 * The SSR proof, in the environment where `window` genuinely does not exist.
 *
 * **A claim about the import chain, not the component.** `map-canvas.ts` is the package's first
 * runtime import of `@mapatlas/maplibre`, which transitively imports `maplibre-gl` — so "no
 * window at import" (T5.2's AC) can only fail here, in Node, and happy-dom would be the wrong
 * oracle: it fakes exactly the globals whose absence is the subject.
 *
 * The import is **dynamic, inside the test body, after asserting the globals are absent** — a
 * static import runs before any assertion and would leave "there was no DOM when the import
 * happened" as an inference rather than evidence.
 */
describe("MapCanvas — server-side rendering", () => {
  it("imports without a DOM and renders to a string without constructing a controller", async () => {
    expect(typeof window, "this lane must have no window").toBe("undefined");
    expect(typeof document, "this lane must have no document").toBe("undefined");

    const { MapCanvas } = await import("./map-canvas.js");
    const { createElement } = await import("react");
    const { renderToString } = await import("react-dom/server");

    const html = renderToString(
      createElement(MapCanvas, {
        sources: [
          {
            id: "base",
            kind: "raster",
            transport: "template",
            url: "https://tiles.invalid/{z}/{x}/{y}.png",
            attribution: "a notice",
          },
        ],
      }),
    );

    // The container div and nothing else: the controller is built in an effect, and effects do
    // not run on a server. A construct-in-render implementation fails this test before the
    // assertion — createMapController reaches for the DOM the first line proved absent.
    expect(html).toContain("<div");
  });
});
