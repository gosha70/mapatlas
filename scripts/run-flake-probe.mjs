// SPDX-License-Identifier: Apache-2.0

/**
 * Run the suite the predeclared number of times and report what happened (T8.1 step 2b).
 *
 * Sequentially, and on purpose: the failure has only ever been seen in a single full-suite run on
 * a runner, and running two at once would change the contention this is trying to hold constant.
 *
 * **It does not stop at the first hit.** The deliverable is a *rate*, not an occurrence — a fix
 * has to be falsified against a measured rate, and a probe that stopped as soon as it succeeded
 * would leave `signature = 1` over an unknown number of runs.
 *
 * **Every hit is printed in full.** That is the point of the diagnostic added in PR #48: the run's
 * whole output goes to the log, so the placement report arrives with it and the fifth occurrence
 * says which crop landed where.
 *
 * The rules are in `flake-probe.mjs` so the verdict can be checked without spending an hour of CI.
 */

import { spawnSync } from "node:child_process";

import { environmentReport } from "./environment-report.mjs";
import {
  PLANNED_RUNS,
  classifyRun,
  interpretSpawn,
  refusedArguments,
  runProbe,
  verdict,
} from "./flake-probe.mjs";
import { availableParallelism } from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// Before anything is spawned: an hour of runner time should not start because of a typo.
const refusal = refusedArguments(process.argv.slice(2));
if (refusal !== undefined) {
  console.error(`probe:flake — ${refusal}`);
  process.exit(2);
}

// The environment first, so a log that is later read in isolation says what machine produced it.
for (const line of environmentReport({
  availableParallelism: availableParallelism(),
  node: process.version,
  vitest: require("vitest/package.json").version,
  platform: process.platform,
  arch: process.arch,
})) {
  console.log(line);
}
console.log(`\nrunning the full suite ${String(PLANNED_RUNS)} times, sequentially\n`);

const counts = runProbe({
  planned: PLANNED_RUNS,
  // The command CI's `Test` step runs, so what is being repeated is what has actually failed.
  runSuite: (run) => {
    const started = Date.now();
    const spawn = spawnSync("npm", ["run", "test:coverage"], { encoding: "utf8", shell: false });
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    const result = interpretSpawn(spawn);
    if (result.spawned === false) {
      console.log(`run ${String(run)}/${String(PLANNED_RUNS)}: could not start (${seconds}s)`);
      return result;
    }
    const kind = classifyRun(result);
    const note = result.truncated === true ? ` [interrupted: ${result.reason ?? "?"}]` : "";
    console.log(`run ${String(run)}/${String(PLANNED_RUNS)}: ${kind}${note} (${seconds}s)`);
    return result;
  },
  onRun: ({ run, kind, output, truncated }) => {
    if (kind === "passed" && !truncated) return;
    const what =
      kind === "signature"
        ? "EXACT SIGNATURE"
        : truncated
          ? "an interrupted run"
          : "an unrelated failure";
    console.log(`\n===== run ${String(run)}: ${what} — full output follows =====`);
    console.log(output);
    console.log(`===== end of run ${String(run)} =====\n`);
  },
});

if (counts.aborted !== undefined) {
  console.log(`\nstopped after ${String(counts.completed)} run(s): ${counts.aborted}`);
}

const result = verdict(counts);
console.log(`\n${result.lines.join("\n")}`);

// Green only when the probe answered its own question: an actionable reproduction over a clean
// budget, or a clean null. A hit on a short or contaminated budget is a real observation and is
// still red, because it is not something a fix can be falsified against.
if (!result.actionable && !result.clean) process.exit(1);
