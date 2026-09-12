// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { computedWorkers, environmentReport } from "./environment-report.mjs";

const FACTS = {
  availableParallelism: 4,
  node: "v24.20.0",
  vitest: "4.1.11",
  platform: "linux",
  arch: "x64",
};

describe("computedWorkers", () => {
  it("mirrors what a non-watch Vitest run derives", () => {
    expect(computedWorkers(4)).toBe(3);
    expect(computedWorkers(14)).toBe(13);
  });

  /** `resolveMaxWorkers` floors at one, and a report claiming zero workers would be nonsense. */
  it("never reports fewer than one worker", () => {
    expect(computedWorkers(1)).toBe(1);
  });
});

describe("environmentReport", () => {
  it("prints the runner's own number, not a conclusion drawn from it", () => {
    expect(environmentReport(FACTS)).toContain("  availableParallelism  4");
  });

  it("reports the runtime, the test runner and the machine", () => {
    const report = environmentReport(FACTS).join("\n");
    for (const fact of ["v24.20.0", "4.1.11", "linux", "x64"]) expect(report).toContain(fact);
  });

  /**
   * **The whole point of the step.** The worker count is a restatement of `resolveMaxWorkers`'s
   * formula, not an observation of how many workers ran, and a number that travels without that
   * caveat becomes a measurement the moment someone quotes it. The label is on the line itself, so
   * a copied line carries it.
   */
  it("labels the worker count as computed, on the line that carries it", () => {
    const line = environmentReport(FACTS).find((one) => one.includes("maxWorkers"));
    expect(line).toContain("computed as max(availableParallelism - 1, 1)");
    expect(line).toContain("not observed");
  });

  /**
   * **The formula has to survive its own edge case, in the line and not only in the code.**
   * `computedWorkers(1)` being 1 says nothing about what the report *prints*: an earlier version
   * carried "computed as availableParallelism - 1", which on a one-core runner would have shown 1
   * beside a formula giving 0. The report is asserted, not the function.
   */
  it("prints a formula that matches the number, on a single-core runner too", () => {
    const line = environmentReport({ ...FACTS, availableParallelism: 1 }).find((one) =>
      one.includes("maxWorkers"),
    );
    expect(line).toContain("vitest maxWorkers     1");
    expect(line).toContain("max(availableParallelism - 1, 1)");
  });

  it("keeps the measured facts and the derived one under separate headings", () => {
    const report = environmentReport(FACTS);
    const measured = report.indexOf("environment (measured):");
    const computed = report.indexOf("environment (computed, not observed):");
    expect(measured).toBeGreaterThanOrEqual(0);
    expect(computed).toBeGreaterThan(measured);
    expect(report.slice(measured, computed).join("\n")).not.toContain("maxWorkers");
  });
});
