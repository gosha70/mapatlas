// SPDX-License-Identifier: Apache-2.0

/**
 * The consumer-side MapLibre setup, shared by every harness entry.
 *
 * Extracted from `harness.ts` so the React entry and the plain entry run **one** MapLibre
 * setup rather than two copies that drift. Both halves are consumer responsibilities the
 * engine cannot take on:
 *
 * - the stylesheet, without which markers lay out in normal flow rather than absolutely
 *   against the map — a mark sits wherever the document happens to put it;
 * - the worker URL. MapLibre 6 resolves its worker relative to the *importing* chunk, and
 *   under a bundler that rewrites imports the request lands beside the rewritten chunk and
 *   404s — silently: the map constructs, the style parses, sources emit `sourcedata`, and
 *   nothing is ever painted because no tile is ever built. `?worker&url` asks the bundler
 *   for a URL it will actually serve.
 */
import "maplibre-gl/dist/maplibre-gl.css";

import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { setWorkerUrl } from "maplibre-gl";

setWorkerUrl(maplibreWorkerUrl);
