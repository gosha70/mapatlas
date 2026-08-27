// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts", "scripts/**/*.test.mjs"],
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
      exclude: ["**/*.test.ts"],
    },
  },
});
