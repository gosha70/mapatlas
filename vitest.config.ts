// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from "vitest/config";

import { RUNTIME_MODES } from "./scripts/flake-experiment.mjs";

/**
 * T8.1 increments 2c and 2d, and nothing else: the runtime mode the **test workers** run in.
 *
 * The experiment compares default Node against one other runtime mode — `--jitless` in 2c,
 * `--no-opt` in 2d — over the identical `npm run test:coverage`, so the difference cannot travel
 * in the command. It cannot travel in `NODE_OPTIONS` either: there a flag reaches Vite's parent as
 * well, and `--jitless` stops the parent starting at all. It travels as this marker, which names
 * an arm; the arm's flags become the workers' `execArgv`, the parent starts normally, and only the
 * workers running the suite are in the other mode.
 *
 * Unset — which is every ordinary run, local and CI — this is `[]` and changes nothing.
 */
const probeRuntimeMode = process.env.MAPATLAS_PROBE_RUNTIME_MODE;
// One table, the experiment's own: what an arm adds to the workers is defined once, and read here,
// by the fixture inside the worker, and by the runner that judges what the worker recorded.
const workerExecArgv = [...(RUNTIME_MODES[probeRuntimeMode ?? ""] ?? [])];

/**
 * Two files the experiment cannot carry, excluded from **both** arms.
 *
 * A jitless worker has no WebAssembly, and each of these needs it, for different reasons — both
 * measured by running them under a jitless worker. `generate-service-worker.test.mjs` fails **as a
 * whole module, at import**: the script it tests imports Vite, which throws `ReferenceError:
 * WebAssembly is not defined`, and no test in it is collected. `serve-archives.test.mjs` imports
 * no Vite at all; five of its tests call `fetch()`, and Node's `fetch` fails with the same
 * `ReferenceError` as its cause. One failed module and five failed tests would make every variant
 * run an unrelated failure and every experiment contaminated.
 *
 * **In 2d the reason they are excluded has changed, and they stay excluded.** Both *run* under
 * `--no-opt`, which does not take WebAssembly away. They are kept out **for suite identity with
 * 2c's control** — the only matched control on record, and the suite the validation candidate
 * `M = 61` was derived on. Letting them back in because the variant no longer needs them gone
 * would change the measured suite between two experiments that are read side by side.
 *
 * **Excluded when the marker is set at all, whichever arm set it**, so the two arms still run the
 * identical suite and differ in exactly one thing. Excluding them from the variant alone would add
 * a second difference — which tests ran — to an experiment whose whole design is that there is
 * only one. `check:runtime-mode` compares the two arms' collected files through this config.
 *
 * **The measured suite is not the one the 13% design rate came from, in membership.** `025cdbe`
 * selected 95 test files. This tree selects 97 — it adds `flake-experiment.test.mjs` and
 * `runtime-mode.fixture.test.mjs` — and while probing excludes these two: 95 again, with two
 * members exchanged. A control hit would establish that the failure *reproduces* on this suite;
 * it would not establish that its rate is unchanged. The design power is conditional on a 13%
 * control rate, which this suite is not known to have.
 */
const excludedWhileProbing =
  probeRuntimeMode === undefined
    ? []
    : ["scripts/generate-service-worker.test.mjs", "scripts/serve-archives.test.mjs"];

/**
 * While probing, everything that failed in the run is also written down, structured, for the
 * runner to read — see `scripts/probe-results-reporter.mjs` for why Vitest's own JSON reporter is
 * not enough.
 *
 * **Naming any reporter replaces Vitest's defaults, so they are restated here**: `default`, and
 * `github-actions` on a runner — which is what 4.1.11 resolves to when none is named, and
 * therefore what every earlier probe's output was produced under. Unset — every ordinary run —
 * `reporters` is not given at all and Vitest chooses as it always has.
 */
const probeResultsPath = process.env.MAPATLAS_PROBE_RESULTS;
const reportersWhileProbing =
  probeResultsPath === undefined
    ? {}
    : {
        reporters: [
          "default",
          ...(process.env.GITHUB_ACTIONS === "true" ? ["github-actions"] : []),
          ["./scripts/probe-results-reporter.mjs", { outputFile: probeResultsPath }],
        ],
      };

export default defineConfig({
  test: {
    ...reportersWhileProbing,
    execArgv: workerExecArgv,
    // `.tsx` as well as `.ts`: the demo app is React, and a `*.test.tsx` outside this glob is
    // not a skipped test — it is a file nobody runs and nobody is told about.
    include: [
      "packages/*/src/**/*.test.ts",
      "apps/*/src/**/*.test.ts?(x)",
      "scripts/**/*.test.mjs",
    ],
    // The browser lane is Playwright's; `npm test` stays browser-free and fast.
    exclude: ["**/node_modules/**", "**/dist/**", "e2e/**", ...excludedWhileProbing],
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
