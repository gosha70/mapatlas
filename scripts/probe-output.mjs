// SPDX-License-Identifier: Apache-2.0

/**
 * Where the probe's output survives when the job's log does not.
 *
 * **Written because increment 2e's result was lost.** The 150-per-arm dispatch
 * ([run 36077914754](https://github.com/gosha70/mapatlas/actions/runs/36077914754)) completed with
 * both arms intact and a control that reproduced — and its report was unreadable afterwards.
 * `run-flake-probe.mjs` printed it with `console.log` and nowhere else, at the end of 300 runs'
 * output, and GitHub capped the step log at 114,903 bytes, cutting it off mid-word after run 1.
 * The comparison was computed and cannot be recovered. Check-run annotations preserved one
 * exact-signature annotation and no counts, no arm, no p-value.
 *
 * The budget caused it: at 60 per arm the output fit under the cap, at 150 it did not. So the
 * durable copy is **not** an operational nicety — a result that exists only in a stream whose
 * length scales with the budget is a result the budget can destroy.
 *
 * **This module is durability only.** It changes no measurement, no gate, no threshold and no
 * conclusion. It spends no alpha and it is not a fourth experiment.
 *
 * Three properties it is built for, each of which the lost run would have needed:
 *
 * 1. *The transcript is written as the loop runs, never buffered.* What that protects against is
 *    the probe **process** failing — a crash, a throw, a non-zero exit — after which the
 *    `if: always()` upload still runs and preserves everything the loop had reached. Buffering to
 *    the end would lose all of it in exactly those cases.
 *
 *    **It does not survive a job timeout, and this used to claim it did.** `timeout-minutes` kills
 *    the job, no further step runs, and the runner is ephemeral — so the incrementally written
 *    file dies with it, unuploaded. A timeout leaves neither a verdict nor a partial transcript.
 *    That is understood rather than worked around: a timeout kills the job before a verdict
 *    exists, so what is lost is runs that never finished.
 * 2. *The compact report is written before `process.exit`.* Not after, because there is no after.
 * 3. *Both survive a failing probe.* A null control or a contaminated arm exits non-zero, and
 *    those are the runs whose detail is most worth reading. The workflow uploads with
 *    `if: always()` for the same reason.
 */

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The directory the probe writes into, relative to the repository root.
 *
 * **One directory so the upload step names one path — and that is all it buys.** An earlier draft
 * of this comment claimed the directory meant the upload "cannot silently pick up half of the
 * pair". **That claim was false — it can.** `if-no-files-found: error` rejects an *empty*
 * directory and succeeds on one holding only `transcript.log`, which is exactly the half-written
 * case worth catching.
 * {@link missingOutputs} is what actually checks for both, in a step of its own.
 */
export const OUTPUT_DIR = "probe-output";

/** The whole transcript: the environment, every run's line, and every hit's full output. */
export const TRANSCRIPT_FILE = "transcript.log";

/** The verdict alone — what a reader wants first, and what the step summary carries. */
export const REPORT_FILE = "report.txt";

/** Both files the probe must leave behind. Named once so the checker and the writers agree. */
export const REQUIRED_OUTPUTS = Object.freeze([TRANSCRIPT_FILE, REPORT_FILE]);

/**
 * Which of the required outputs are not on disk — empty when both are.
 *
 * **Because the upload step cannot tell.** `if-no-files-found: error` fires only on an empty
 * directory, so a probe that wrote its transcript and died before its report would upload a
 * plausible-looking artifact missing the one file a reader opens first. That is the failure this
 * whole repair exists to prevent, arriving one level down — the shape
 * [[masking-recurs-one-level-down]] describes.
 *
 * Reported as a list rather than a boolean so the job says *which* file is missing; "the probe
 * output is incomplete" sends a reader to the wrong place half the time.
 *
 * @param {string} root
 * @param {string} [dir]
 * @returns {string[]}
 */
export function missingOutputs(root, dir = OUTPUT_DIR) {
  return REQUIRED_OUTPUTS.filter((file) => !existsSync(join(root, dir, file)));
}

/**
 * Open the transcript and hand back an appender.
 *
 * **Appends per call, and does not hold a buffer.** `appendFileSync` on every line is more
 * syscalls than a stream, and that is the trade being made on purpose: a write-behind stream can
 * lose its tail when the process is killed, which is the one case this file exists for. The loop
 * it serves spends about 18 seconds per run, so the cost is not measurable against it.
 *
 * @param {string} root
 * @param {string} [dir]
 * @returns {{ path: string, append: (text: string) => void }}
 */
export function openTranscript(root, dir = OUTPUT_DIR) {
  const directory = join(root, dir);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, TRANSCRIPT_FILE);
  // Truncated at open, so a re-run in the same workspace does not append to a previous job's
  // transcript and present the two as one.
  writeFileSync(path, "");
  return {
    path,
    append: (text) => {
      appendFileSync(path, text.endsWith("\n") ? text : `${text}\n`);
    },
  };
}

/**
 * Write the compact report, and return where it went.
 *
 * Separate from the transcript because they answer different questions: the transcript is the
 * evidence, this is the finding. A reader opening a 40 MB transcript to learn whether the control
 * reproduced is a reader the lost run already created.
 *
 * @param {string} root
 * @param {readonly string[]} lines
 * @param {string} [dir]
 * @returns {string}
 */
export function writeReport(root, lines, dir = OUTPUT_DIR) {
  const directory = join(root, dir);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, REPORT_FILE);
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}

/**
 * Append the report to the job summary, if this is running under one.
 *
 * **Best effort, and says so.** The summary is a convenience — it puts the verdict on the run's
 * own page, where nobody has to download an artifact to read it. It is not the durable copy; the
 * artifact is. So a failure here is reported and swallowed rather than taking down a job that has
 * already done its 300 runs, and it returns whether it wrote so a caller can say which happened.
 *
 * @param {readonly string[]} lines
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ written: boolean, reason?: string }}
 */
export function appendStepSummary(lines, env = process.env) {
  const target = env["GITHUB_STEP_SUMMARY"];
  if (target === undefined || target === "") return { written: false, reason: "not under GitHub" };
  try {
    appendFileSync(target, `\n\`\`\`\n${lines.join("\n")}\n\`\`\`\n`);
    return { written: true };
  } catch (error) {
    return { written: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
