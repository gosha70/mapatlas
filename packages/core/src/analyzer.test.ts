// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { noopAnalyzer } from "./analyzer.js";

describe("noopAnalyzer", () => {
  it("is local (no egress) and identifiable", () => {
    expect(noopAnalyzer.runsRemotely).toBe(false);
    expect(noopAnalyzer.id).toBe("noop");
  });

  it("returns an empty label set", async () => {
    const result = await noopAnalyzer.analyze({ url: "photo://x" });
    expect(result.labels).toEqual([]);
  });
});
