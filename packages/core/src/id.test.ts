// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { clamp, newId, toRadians } from "./id.js";

describe("newId", () => {
  it("produces unique non-empty ids", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const id = newId();
      expect(id).toBeTruthy();
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
  });
});

describe("clamp", () => {
  it("bounds a value into range", () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
  });
});

describe("toRadians", () => {
  it("converts degrees to radians", () => {
    expect(toRadians(180)).toBeCloseTo(Math.PI, 10);
    expect(toRadians(0)).toBe(0);
  });
});
