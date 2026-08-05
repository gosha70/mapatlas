// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { VERSION } from "./index.js";

describe("@mapatlas/core skeleton", () => {
  it("exposes a version marker", () => {
    expect(VERSION).toBe("0.0.0");
  });
});
