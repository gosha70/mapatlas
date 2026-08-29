// SPDX-License-Identifier: Apache-2.0
import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

/**
 * Serves the harness page that loads the workspace packages as real ES modules.
 *
 * The engine is consumed here the way a browser consumer would consume it — through the
 * package entry points, not through a bundle prepared for the test.
 */
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  server: { host: "127.0.0.1" },
  resolve: {
    // Subpaths before their own package, always: vite matches string aliases by prefix, so
    // a bare entry listed first swallows every subpath under it and resolves, for example,
    // `@mapatlas/core/testing` to `dist/index.js/testing`.
    alias: {
      "@mapatlas/core/testing": fileURLToPath(
        new URL("../../packages/core/dist/testing/index.js", import.meta.url),
      ),
      "@mapatlas/core": fileURLToPath(
        new URL("../../packages/core/dist/index.js", import.meta.url),
      ),
      // The controller is not on the package barrel yet: `api.md` declares the full
      // `MapController` surface and T4.1 delivers only its source-stack half, so exporting
      // it now would make the contract untrue until T4.3. The browser lane still needs the
      // real MapLibre runtime, so it reaches the module the barrel will eventually re-export.
      "@mapatlas/maplibre/controller": fileURLToPath(
        new URL("../../packages/maplibre/dist/controller/browser.js", import.meta.url),
      ),
      "@mapatlas/maplibre/engine-layers": fileURLToPath(
        new URL("../../packages/maplibre/dist/controller/engine-layers.js", import.meta.url),
      ),
      "@mapatlas/maplibre/controller-internal": fileURLToPath(
        new URL("../../packages/maplibre/dist/controller/controller.js", import.meta.url),
      ),
      "@mapatlas/maplibre/protocols": fileURLToPath(
        new URL("../../packages/maplibre/dist/protocols/pmtiles.js", import.meta.url),
      ),
      "@mapatlas/maplibre": fileURLToPath(
        new URL("../../packages/maplibre/dist/index.js", import.meta.url),
      ),
      "@mapatlas/recorder-web": fileURLToPath(
        new URL("../../packages/recorder-web/dist/index.js", import.meta.url),
      ),
      "@mapatlas/storage-idb": fileURLToPath(
        new URL("../../packages/storage-idb/dist/index.js", import.meta.url),
      ),
    },
  },
});
