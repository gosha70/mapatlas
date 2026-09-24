// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ROOT } from "./consumer-project.mjs";
import { RUNS_PER_ARM } from "./flake-experiment.mjs";
import { runCommandsOf, timeoutOf, triggersOf } from "./workflow-triggers.mjs";

const yaml = (...lines) => lines.join("\n");

describe("triggersOf", () => {
  it("reads the keys nested under a block form", () => {
    expect(
      triggersOf(
        yaml("name: x", "on:", "  workflow_dispatch:", "", "permissions:", "  contents: read"),
      ),
    ).toStrictEqual(["workflow_dispatch"]);
  });

  it("sees a trigger added beside an existing one", () => {
    expect(
      triggersOf(yaml("on:", "  workflow_dispatch:", "  push:", "    branches: [main]", "jobs:")),
    ).toStrictEqual(["workflow_dispatch", "push"]);
  });

  /** A trigger's own configuration is not a trigger; `branches` sits two levels in. */
  it("does not mistake a trigger's options for triggers", () => {
    expect(
      triggersOf(yaml("on:", "  push:", "    branches: [main]", "    tags: [v*]")),
    ).toStrictEqual(["push"]);
  });

  it("reads the flow-list and scalar forms GitHub also accepts", () => {
    expect(triggersOf(yaml("on: [push, pull_request]"))).toStrictEqual(["push", "pull_request"]);
    expect(triggersOf(yaml("on: push"))).toStrictEqual(["push"]);
    expect(triggersOf(yaml('"on":', "  pull_request:"))).toStrictEqual(["pull_request"]);
  });

  /**
   * **Refusing beats returning nothing.** An empty list would satisfy "no push trigger" on a file
   * this cannot read, which is the assertion below passing for the worst possible reason.
   */
  it("refuses a workflow with no on: block rather than reporting no triggers", () => {
    expect(() => triggersOf(yaml("name: x", "jobs:", "  build:"))).toThrow(/declares no `on:`/);
  });
});

describe("the T8.1 flake probe", () => {
  const workflow = readFileSync(join(ROOT, ".github/workflows/t8-1-flake-probe.yml"), "utf8");

  /**
   * **The safety property, asserted rather than commented.** The probe is manual-only because a
   * job that also fired automatically would add CI cost to every change and produce runs nobody
   * reads. Compared as the *whole* list, not "does not contain push": a workflow gaining
   * `schedule` or `pull_request_target` would slip past a denylist, and there is exactly one
   * trigger this file is allowed to have.
   */
  it("is triggered manually and by nothing else", () => {
    expect(triggersOf(workflow)).toStrictEqual(["workflow_dispatch"]);
  });

  /**
   * **Falsifier: the probe not certifying `--no-opt` on its own Node.** `node-version: 24` floats,
   * so a dispatch may resolve a Node that `ci.yml` never ran `check:runtime-mode` on, and the
   * certificates inside the loop prove only that the flag was *delivered*. The result's claim —
   * TurboFan-enabled against disabled — is established in this job, **before** the loop, or not at
   * all. The whole ordered list: a step moved after the loop, or dropped, fails here.
   */
  it("certifies the instrument on its own runtime before it measures anything", () => {
    expect(runCommandsOf(workflow)).toStrictEqual([
      "npm ci",
      "npm run build",
      "npm run check:runtime-mode",
      "npm run probe:flake",
    ]);
  });

  /**
   * **Falsifier: a ceiling left behind when the budget grew.** A job killed part-way leaves an arm
   * short of its budget, which the contamination gate reports as inconclusive — so a stale ceiling
   * does not waste a run, it guarantees an answerless one.
   *
   * **This permits the old 150-minute ceiling, deliberately.** 300 runs at the slowest measured
   * pace is about 93 minutes of loop, so 150 would still have fitted and was never unsafe; the
   * raise to 180 is headroom, not a correction. What this forbids is a ceiling that cannot fit
   * the budget at all, and a budget raised past the ceiling — the drift that would be silent.
   *
   * **Tied to `RUNS_PER_ARM`, so the two cannot drift.** The bound is the budget's own duration at
   * the *slowest* pace on record — 18.6 s a run, measured on 2c's job; 2d's was 11.9 s on the same
   * image — plus the job's fixed cost of install and build. Raising the budget without raising the
   * ceiling turns this red, which is the whole point of computing it rather than quoting 180.
   */
  it("leaves the budget a ceiling it fits under at the slowest pace measured", () => {
    /** Seconds per run, the slower of the two paces this workflow has actually recorded. */
    const SLOWEST_RUN_SECONDS = 18.6;
    /** `npm ci`, the build and the certification, generously: they are minutes, not tens of them. */
    const FIXED_COST_MINUTES = 15;

    const loopMinutes = (RUNS_PER_ARM * 2 * SLOWEST_RUN_SECONDS) / 60;
    expect(timeoutOf(workflow)).toBeGreaterThanOrEqual(loopMinutes + FIXED_COST_MINUTES);

    // And not so generous that it has stopped being a bound: a job that hangs must still die
    // inside a working day rather than burning a runner until GitHub's own 6-hour limit.
    expect(timeoutOf(workflow)).toBeLessThanOrEqual(240);
  });
});

describe("runCommandsOf", () => {
  it("reads each step's command in order, and not a commented-out one", () => {
    expect(
      runCommandsOf(
        yaml("steps:", "  - name: a", "    run: npm ci", "  # run: never", "  - run: npm test"),
      ),
    ).toStrictEqual(["npm ci", "npm test"]);
  });

  /** A step it cannot read as one command is refused, not reported as `|`. */
  it("refuses a multi-line step rather than reporting noise", () => {
    expect(() => runCommandsOf(yaml("steps:", "  - run: |", "      npm ci"))).toThrow(
      /multi-line `run:` step/,
    );
  });
});
