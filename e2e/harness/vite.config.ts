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
    alias: {
      "@mapatlas/core": fileURLToPath(
        new URL("../../packages/core/dist/index.js", import.meta.url),
      ),
      "@mapatlas/core/testing": fileURLToPath(
        new URL("../../packages/core/dist/testing/index.js", import.meta.url),
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
