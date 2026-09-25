// SPDX-License-Identifier: Apache-2.0

/**
 * Run the two-arm runtime-mode experiment and report what happened (T8.1 increments 2c, 2d, 2e).
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
 * `flake-probe.mjs`, so the verdict can be checked without spending hours of CI.
 */

import { availableParallelism } from "node:os";
import { createRequire } from "node:module";

import { environmentReport } from "./environment-report.mjs";
import {
  CONTROL,
  RUNS_PER_ARM,
  exitCode,
  RUNTIME_MODES,
  VARIANT,
  controlBaseline,
  judgeRun,
  refusedArguments,
  refusedEnvironment,
  report,
  runExperiment,
  verdict,
} from "./flake-experiment.mjs";
import { appendStepSummary, openTranscript, writeReport } from "./probe-output.mjs";
import { classifyRun, interpretSpawn } from "./flake-probe.mjs";
import { spawnArm } from "./spawn-arm.mjs";

const require = createRequire(import.meta.url);

// Before anything is spawned: hours of runner time should not start because of a typo.
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

/**
 * The durable transcript, opened **before the first run** so nothing the loop prints is only ever
 * in the job log. Increment 2e's report was lost to that log's size cap; see `probe-output.mjs`.
 */
const transcript = openTranscript(process.cwd());

/** Print and persist, in that order, so the two can never disagree about what happened. */
const say = (text) => {
  console.log(text);
  transcript.append(text);
};

say(`transcript: ${transcript.path}`);

// The environment first, so a log that is later read in isolation says what machine produced it.
for (const line of environmentReport({
  availableParallelism: availableParallelism(),
  node: process.version,
  vitest: require("vitest/package.json").version,
  platform: process.platform,
  arch: process.arch,
})) {
  say(line);
}
say(
  `\nrunning the full suite ${String(RUNS_PER_ARM)} times per arm, alternating ` +
    `${CONTROL} and ${VARIANT} (${RUNTIME_MODES[VARIANT].join(" ")}), sequentially\n`,
);

const total = RUNS_PER_ARM * 2;

// Where the workers run, which is what their arguments' one path is relative to.
const root = process.cwd();
// What every variant run's arguments are held against: a control run's own, from the first one
// that certifies. The alternation starts with the control, so it exists before any variant runs.
let baseline;

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
      say(`${where}: could not start (${seconds}s)`);
      return interpreted;
    }
    // Judged here, against the arm this loop scheduled — the worker can only agree with itself.
    const result = judgeRun({ arm, interpreted, certificate, results, root, baseline });
    baseline ??= controlBaseline(arm, certificate, root);
    const kind = classifyRun(result);
    const note =
      (result.truncated === true ? ` [interrupted: ${result.reason ?? "?"}]` : "") +
      (result.unrelated.length === 0
        ? ""
        : ` [ALSO FAILED, unrelated: ${result.unrelated.join("; ")}]`) +
      (result.instrumentFault === undefined ? "" : ` [INSTRUMENT: ${result.instrumentFault}]`);
    say(`${where}: ${kind}${note} (${seconds}s)`);
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
    say(`\n===== ${where}: ${what} — full output follows =====`);
    say(output);
    say(`===== end of ${where} =====\n`);
  },
});

const result = verdict(counts);
const lines = report(result);
say(`\n${lines.join("\n")}`);

// **Before `process.exit`, because there is no after.** The report is the one thing a reader
// needs and the one thing increment 2e lost; it goes to a file of its own and to the job summary
// while the process still exists to write it.
const reportPath = writeReport(process.cwd(), lines);
const summary = appendStepSummary(lines);
say(
  `\nreport: ${reportPath}` +
    (summary.written ? "; appended to the job summary" : `; no job summary (${summary.reason})`),
);

// Green only when the experiment answered its own question: both arms intact and the control
// reproduced, whichever way the comparison then came out. The rule itself lives in
// `flake-experiment.mjs` and is asserted there — here it would be unreachable without spending a
// job to find out. **The durable copies are written above, so this exit code never costs a
// reader the result**: a non-zero exit is exactly when the detail is most worth reading.
process.exit(exitCode(result));
