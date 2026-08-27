// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { noopAnalyzer } from "./analyzer.js";

describe("noopAnalyzer", () => {
  it("returns no labels rather than throwing", async () => {
    // The T1.6 criterion. An absent analyzer and a silent one must look the same to
    // everything downstream, so the no-op path has to resolve, not reject.
    const analysis = await noopAnalyzer.analyze({ blob: new Blob(["photo"]) });
    expect(analysis.labels).toEqual([]);
  });

  it("declares itself local, so no consumer is asked to disclose egress for it", () => {
    expect(noopAnalyzer.runsRemotely).toBe(false);
    expect(noopAnalyzer.id).toBe("noop");
  });

  it("identifies which model produced the result", () => {
    expect(noopAnalyzer.analyze({ url: "https://example.invalid/a.jpg" })).resolves.toMatchObject({
      model: "noop",
    });
  });

  it("accepts every shape of input the seam allows", async () => {
    await expect(noopAnalyzer.analyze({})).resolves.toBeDefined();
    await expect(
      noopAnalyzer.analyze({ blob: new Blob([]), hint: { tags: ["a"], category: "c" } }),
    ).resolves.toBeDefined();
  });
});
