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
      // A floor, not a target. Set below the current level so ordinary work does not trip
      // it, but high enough that losing a suite is a build failure rather than a surprise.
      // The remaining gap is defensive `undefined` guards that strict indexing requires and
      // no input can reach — chasing them to 100% would mean testing TypeScript, not the
      // engine.
      thresholds: {
        statements: 92,
        branches: 82,
        functions: 90,
        lines: 92,
      },
    },
  },
});
