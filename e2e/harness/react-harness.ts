// SPDX-License-Identifier: Apache-2.0

/**
 * The page the T5.2 browser scenario drives: the public-shaped `<MapCanvas>` mounted through
 * real React, with the production `createMapController` inside it.
 *
 * **One persistent root; `setProps` re-renders it and never remounts.** That is what makes a
 * `drawMode` toggle here a React lifecycle transition — the thing checkpoint 2 exists to prove —
 * rather than a fresh mount that would enter draw mode trivially.
 *
 * `MapCanvas` is imported through a harness-only alias because it is deliberately not on the
 * package barrel until checkpoint 3; the *component* is the public-shaped one, the *route to
 * it* is the harness's established privilege.
 */
import "./maplibre-bootstrap.js";

import { StrictMode, createElement } from "react";
import { createRoot } from "react-dom/client";

import type { MapCanvasProps } from "@mapatlas/react/map-canvas";
import { MapCanvas } from "@mapatlas/react/map-canvas";

declare global {
  interface Window {
    reactCanvas: {
      /** Re-render the persistent root with these props. Never remounts. */
      setProps(next: MapCanvasProps): void;
      /** How many times the root has been rendered — so a test can prove it drove React. */
      renders: number;
    };
  }
}

const container = document.querySelector("#root");
if (container === null) throw new Error("react harness page has no #root");

const root = createRoot(container);

window.reactCanvas = {
  renders: 0,
  setProps: (next) => {
    window.reactCanvas.renders += 1;
    root.render(createElement(StrictMode, null, createElement(MapCanvas, next)));
  },
};
