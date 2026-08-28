// SPDX-License-Identifier: Apache-2.0
import { defineConfig, devices } from "@playwright/test";

/**
 * The real-browser lane.
 *
 * Deliberately separate from Vitest and from the `gates` CI job. It exists for the things a
 * fake cannot reach: a genuine WebGL context, the platform APIs the engine wires itself to,
 * and — once `@mapatlas/maplibre` lands — MapLibre's ESM worker loading, which is exactly
 * what breaks on a major-version bump and exactly what a module mock would hide.
 *
 * Kept out of `npm test` so the fast suite stays browser-free.
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.e2e\.ts$/,
  fullyParallel: false,
  forbidOnly: Boolean(process.env["CI"]),
  retries: process.env["CI"] === undefined ? 0 : 1,
  // One worker in CI: WebGL contexts are a finite, shared resource, and parallel workers
  // make failures depend on what else happened to be rendering.
  workers: 1,
  reporter: process.env["CI"] === undefined ? "list" : [["list"], ["html", { open: "never" }]],

  use: {
    baseURL: "http://localhost:5174",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },

  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],

  webServer: {
    command: "npx vite --config e2e/harness/vite.config.ts --port 5174 --strictPort",
    url: "http://localhost:5174",
    reuseExistingServer: process.env["CI"] === undefined,
    timeout: 60_000,
  },
});
