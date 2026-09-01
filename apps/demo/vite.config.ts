// SPDX-License-Identifier: Apache-2.0
import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

/**
 * Serves the demo, and only through the packages' public entry points.
 *
 * That restriction is the point rather than a convenience. `e2e/harness` aliases deep paths —
 * `@mapatlas/maplibre/controller` and friends — so its probes can see the injected environment
 * and the renderer's internals. Those are automation-only, and a `/lab` built on them would
 * demonstrate that the harness works, not that a consumer's imports do. Every alias here is a
 * bare package name resolving to its built entry: what `npm install` would give.
 */
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  server: { host: "127.0.0.1" },
  resolve: {
    alias: {
      "@mapatlas/core": fileURLToPath(
        new URL("../../packages/core/dist/index.js", import.meta.url),
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
      "@mapatlas/offline-pmtiles": fileURLToPath(
        new URL("../../packages/offline-pmtiles/dist/index.js", import.meta.url),
      ),
      "@mapatlas/react": fileURLToPath(
        new URL("../../packages/react/dist/index.js", import.meta.url),
      ),
    },
  },
});
