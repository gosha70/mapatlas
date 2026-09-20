// SPDX-License-Identifier: Apache-2.0

/**
 * Run the two-arm runtime-mode experiment and report what happened (T8.1 increment 2c).
 *
 * Sequentially, and on purpose: the failure has only ever been seen in a single full-suite run on
 * a runner, and running two at once would change the contention this holds constant.
 *
 * **It does not stop at the first hit.** The deliverable is a pair of *rates* compared against each
 * other, not an occurrence.
 *
 * **Every hit is printed in full**, so the placement report arrives in the log with it — the whole
 * reason increment 1 exists.
 *
 * The rules are in `flake-experiment.mjs` and the classification of one run is in
 * `flake-probe.mjs`, so the verdict can be checked without spending two hours of CI.
 */

import { availableParallelism } from "node:os";
import { createRequire } from "node:module";

import { environmentReport } from "./environment-report.mjs";
import {
  CONTROL,
  RUNS_PER_ARM,
  VARIANT,
  judgeRun,
  refusedArguments,
  refusedEnvironment,
  report,
  runExperiment,
  verdict,
} from "./flake-experiment.mjs";
import { classifyRun, interpretSpawn } from "./flake-probe.mjs";
import { spawnArm } from "./spawn-arm.mjs";

const require = createRequire(import.meta.url);

// Before anything is spawned: two hours of runner time should not start because of a typo.
const refusal = refusedArguments(process.argv.slice(2));
if (refusal !== undefined) {
  console.error(`probe:flake — ${refusal}`);
  process.exit(2);
}

// And not at all if the control arm would not be a control.
const environmentRefusal = refusedEnvironment(process.env);
if (environmentRefusal !== undefined) {
  console.error(`probe:flake — ${environmentRefusal}`);
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
console.log(
  `\nrunning the full suite ${String(RUNS_PER_ARM)} times per arm, alternating ` +
    `${CONTROL} and ${VARIANT} (--jitless), sequentially\n`,
);

const total = RUNS_PER_ARM * 2;

const counts = runExperiment({
  runsPerArm: RUNS_PER_ARM,
  runSuite: ({ index, arm, armRun }) => {
    // Identical argv for both arms; the flag is in the child's environment and nowhere else.
    const started = Date.now();
    const { spawn, certificate, results } = spawnArm(arm, process.env);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    const where = `run ${String(index)}/${String(total)} [${arm} ${String(armRun)}/${String(RUNS_PER_ARM)}]`;
    const interpreted = interpretSpawn(spawn);
    if (interpreted.spawned === false) {
      console.log(`${where}: could not start (${seconds}s)`);
      return interpreted;
    }
    // Judged here, against the arm this loop scheduled — the worker can only agree with itself.
    const result = judgeRun({ arm, interpreted, certificate, results });
    const kind = classifyRun(result);
    const note =
      (result.truncated === true ? ` [interrupted: ${result.reason ?? "?"}]` : "") +
      (result.unrelated.length === 0
        ? ""
        : ` [ALSO FAILED, unrelated: ${result.unrelated.join("; ")}]`) +
      (result.instrumentFault === undefined ? "" : ` [INSTRUMENT: ${result.instrumentFault}]`);
    console.log(`${where}: ${kind}${note} (${seconds}s)`);
    return result;
  },
  onRun: ({ index, arm, armRun, kind, output, truncated, unrelated, instrumentFault }) => {
    if (kind === "passed" && truncated !== true && instrumentFault === undefined) return;
    const what =
      kind === "signature"
        ? unrelated.length === 0
          ? "EXACT SIGNATURE"
          : "EXACT SIGNATURE, beside an unrelated failure"
        : truncated === true
          ? "an interrupted run"
          : kind === "passed"
            ? "a run with an instrument fault"
            : "an unrelated failure";
    const where = `run ${String(index)} (${arm} ${String(armRun)})`;
    console.log(`\n===== ${where}: ${what} — full output follows =====`);
    console.log(output);
    console.log(`===== end of ${where} =====\n`);
  },
});

const result = verdict(counts);
console.log(`\n${report(result).join("\n")}`);

// Green only when the experiment answered its own question: both arms intact and the control
// reproduced, whichever way the comparison then came out. A contaminated budget or a null control
// is a real observation and is still red, because nothing follows from it.
if (result.comparison === undefined) process.exit(1);
