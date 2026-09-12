// SPDX-License-Identifier: Apache-2.0

/**
 * Gather this machine's facts and print the report (T8.1 increment 2.0).
 *
 * The rules live in `environment-report.mjs` so they can be tested; this reads the environment and
 * writes it out. Run on a GitHub runner by the `t8-1-flake-probe` workflow, and locally by hand,
 * so the two numbers being compared come from the same code rather than from two readings taken
 * different ways.
 *
 * The Vitest version is read from its installed manifest rather than from this repository's
 * `package.json`: the declared range and the resolved install are different facts, and the one
 * that matters is what actually ran.
 */

import { availableParallelism } from "node:os";
import { createRequire } from "node:module";

import { environmentReport } from "./environment-report.mjs";

const require = createRequire(import.meta.url);

for (const line of environmentReport({
  availableParallelism: availableParallelism(),
  node: process.version,
  vitest: require("vitest/package.json").version,
  platform: process.platform,
  arch: process.arch,
})) {
  console.log(line);
}
