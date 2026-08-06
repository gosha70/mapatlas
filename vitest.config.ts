// SPDX-License-Identifier: Apache-2.0
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/** Resolve cross-package imports to source so tests never depend on stale dist. */
const src = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@mapatlas/core/testing": src("./packages/core/src/testing/index.ts"),
      "@mapatlas/core": src("./packages/core/src/index.ts"),
      "@mapatlas/leaflet": src("./packages/leaflet/src/index.ts"),
      "@mapatlas/react": src("./packages/react/src/index.ts"),
      "@mapatlas/storage-idb": src("./packages/storage-idb/src/index.ts"),
    },
  },
  test: {
    include: [
      "packages/*/src/**/*.{test,spec}.ts",
      "packages/*/src/**/*.{test,spec}.tsx",
      "apps/*/src/**/*.{test,spec}.ts",
      "apps/*/src/**/*.{test,spec}.tsx",
    ],
    environment: "node",
  },
});
