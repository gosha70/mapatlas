// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/*/src/**/*.{test,spec}.ts",
      "apps/*/src/**/*.{test,spec}.ts",
    ],
    environment: "node",
  },
});
