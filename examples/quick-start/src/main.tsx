// SPDX-License-Identifier: Apache-2.0

/**
 * The entry point, and the two lines MapLibre needs from every application that embeds it.
 *
 * The stylesheet is not optional: without it MapLibre's controls are unstyled and map marks
 * lose their positioning. Neither is the worker URL — MapLibre resolves its worker relative to
 * the importing chunk, and under a bundler that rewrites imports the request 404s silently: the
 * map constructs, the style parses, and no tile is ever built. The `?worker&url` syntax is
 * Vite's; other bundlers have their own.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "maplibre-gl/dist/maplibre-gl.css";
import { setWorkerUrl } from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";

import { QuickStart } from "./quick-start.js";

setWorkerUrl(workerUrl);

const mount = document.querySelector("#app");
if (mount === null) throw new Error("index.html has no #app element to mount into");

createRoot(mount).render(
  <StrictMode>
    <QuickStart />
  </StrictMode>,
);
