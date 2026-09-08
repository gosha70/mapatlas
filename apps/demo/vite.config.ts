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
  preview: { host: "127.0.0.1" },
  /**
   * The production build, pinned as a repository contract rather than left to a default.
   *
   * **Not `dist`, which is already taken.** `apps/demo/tsconfig.json` sets `"outDir": "dist"`,
   * so `tsc --build` emits the demo's `.js` and `.d.ts` there — and this directory carried a
   * stale `assets/` from an unpinned `vite build` alongside them. Pointing the bundle at the
   * same place is not merely untidy: `emptyOutDir` would delete the compiler's output while
   * `tsconfig.tsbuildinfo` still records it as current, so the next `tsc --build` would emit
   * nothing and the build gate would pass over a hole. In the other order the compiler's
   * `.js`/`.d.ts`/`.map` files land *inside* the bundle, and the service worker generated from
   * that tree would precache them and take its build digest from them.
   *
   * `build/` is where this repository already puts generated, uncommitted artefacts
   * (`build/fixture/` holds the map archives), and nothing else writes to `build/demo/`.
   *
   * `emptyOutDir` is explicit because the directory is outside `root`: vite refuses to clear
   * such a directory silently, and a bundle accumulating the previous build's hashed chunks
   * would give the worker an inventory of files the application no longer loads.
   */
  build: {
    outDir: fileURLToPath(new URL("../../build/demo", import.meta.url)),
    emptyOutDir: true,
  },
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
