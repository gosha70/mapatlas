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
      // The public controller comes from the bare package entry. The remaining controller
      // aliases are harness-only probes: they expose the injected environment and renderer
      // state needed to verify what MapLibre did, neither of which belongs on the public API.
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
      // Harness-only: MapCanvas is deliberately not on the package barrel until T5.2's
      // checkpoint 3. The component mounted is the public-shaped one; the deep path is the
      // harness's established privilege, same as the controller probes above.
      "@mapatlas/react/map-canvas": fileURLToPath(
        new URL("../../packages/react/dist/map-canvas.js", import.meta.url),
      ),
      // Harness-only, same privilege: EventComposer stays off the barrel until T5.3's
      // closure increment.
      "@mapatlas/react/event-composer": fileURLToPath(
        new URL("../../packages/react/dist/event-composer.js", import.meta.url),
      ),
      "@mapatlas/react": fileURLToPath(
        new URL("../../packages/react/dist/index.js", import.meta.url),
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
