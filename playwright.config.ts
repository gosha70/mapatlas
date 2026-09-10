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

  // Three servers, and the split is deliberate. The harness is automation-only; the demo is
  // what a consumer's app looks like and is what `/lab` must be served from; the archive server
  // exists so the fixture's PMTiles are fetched by **range request over HTTP**, which is how a
  // consumer reads them, rather than from disk by a path only a test would know.
  webServer: [
    {
      command: "npx vite --config e2e/harness/vite.config.ts --port 5174 --strictPort",
      url: "http://localhost:5174",
      reuseExistingServer: process.env["CI"] === undefined,
      timeout: 60_000,
    },
    {
      command: "npx vite --config apps/demo/vite.config.ts --port 5175 --strictPort",
      url: "http://127.0.0.1:5175/",
      reuseExistingServer: process.env["CI"] === undefined,
      timeout: 60_000,
    },
    {
      // Builds the synthetic pair through the real writer, then serves it. Slower to start than
      // a static server because it cuts real tiles first.
      command: "node e2e/fixtures/serve-lab-archives.mjs",
      url: "http://127.0.0.1:5176/terrain.pmtiles",
      // **Never reused, unlike the two vite servers.** Reuse accepts whatever is already
      // listening on the port and skips the command — so a local rerun would serve archives cut
      // from an older writer, and a change to the pipeline would appear to have no effect. The
      // other two serve source that vite reloads; this one bakes its output at startup.
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      // **The production artefact, on its own origin** (T7.1 increment 5c). The demo's service
      // worker precaches what `vite build` emitted, so a scenario served by the dev server would
      // be testing vite's development module graph — a different set of files, under a different
      // set of urls, with no `sw.js` at all. `demo:build` runs the build and then generates the
      // worker from the emitted tree; `vite preview` serves exactly that tree.
      command:
        "npm run demo:build && npx vite preview --config apps/demo/vite.config.ts " +
        "--port 5177 --strictPort",
      url: "http://127.0.0.1:5177/",
      // **Never reused**, for the archive server's reason: an already-running preview serves
      // whatever `build/demo` held when it started, so a rerun would test yesterday's bundle —
      // and the offline claim here is precisely a claim about *this* build's files.
      reuseExistingServer: false,
      timeout: 180_000,
    },
    {
      // **The getting-started example, built as a consumer** (T7.2). Packed tarballs installed
      // into a project of their own, built by that project's own vite, with no workspace alias
      // and no project reference — so what runs here is what a reader who ran `npm install`
      // would get, not what resolves inside this repository.
      //
      // **Never reused**, for the preview server's reason and one more: the tarballs are repacked
      // from whatever `dist` currently holds, so an already-running server would serve an example
      // linked against an older engine while reporting the current one.
      command: "node scripts/serve-example.mjs",
      url: "http://127.0.0.1:5178/",
      reuseExistingServer: false,
      timeout: 300_000,
    },
  ],
});
