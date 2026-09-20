// SPDX-License-Identifier: Apache-2.0

/**
 * Spawn one run of one arm, and bring back what its worker certified and what failed in it (T8.1
 * increment 2c).
 *
 * **One spawn path, shared by the experiment and by the check that proves it.** The runner's own
 * `spawnSync` call is where an arm's environment either reaches the child or does not, and a check
 * that builds its own environment and makes its own call proves a transport the experiment is not
 * using. So `run-flake-probe.mjs` and `check-runtime-mode.mjs` both come through here, and the only
 * thing the check may change is *which command* is spawned — never the environment it is given.
 *
 * Both paths are fresh per run and removed afterwards, so a certificate or a set of results can
 * only have come from the run it is read for: one left behind by an earlier run would vouch for a
 * run that wrote nothing.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { spawnPlan } from "./flake-experiment.mjs";

/** What the run wrote at `path`, or `undefined` when there is nothing there that can be read. */
function readWritten(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    // Half-written is unreadable, and unreadable is the same as absent: nothing is vouched for.
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

/**
 * @param {string} arm
 * @param {Record<string, string | undefined>} baseEnv
 * @param {{ command?: string, args?: string[] }} [instead] a different command over the **same**
 *   environment — for the check, which runs the fixture alone rather than the whole suite
 * @returns {{ spawn: import("node:child_process").SpawnSyncReturns<string>, certificate: unknown,
 *   results: unknown }}
 */
export function spawnArm(arm, baseEnv, instead = {}) {
  const directory = mkdtempSync(join(tmpdir(), "mapatlas-probe-"));
  const certificatePath = join(directory, "certificate.json");
  const resultsPath = join(directory, "results.json");
  try {
    const plan = spawnPlan(arm, baseEnv, { certificatePath, resultsPath });
    const { command = plan.command, args = plan.args } = instead;
    const spawn = spawnSync(command, args, { encoding: "utf8", shell: false, env: plan.env });
    return {
      spawn,
      certificate: readWritten(certificatePath),
      results: readWritten(resultsPath),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
