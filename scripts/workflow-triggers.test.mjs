// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ROOT } from "./consumer-project.mjs";
import { runCommandsOf, triggersOf } from "./workflow-triggers.mjs";

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
