// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { noopAnalyzer } from "./seams";

describe("noopAnalyzer", () => {
  it("is a local, non-remote analyzer", () => {
    expect(noopAnalyzer.id).toBe("noop");
    expect(noopAnalyzer.runsRemotely).toBe(false);
  });

  it("returns an empty label set", async () => {
    const result = await noopAnalyzer.analyze({ url: "ignored" });
    expect(result.labels).toEqual([]);
  });
});
