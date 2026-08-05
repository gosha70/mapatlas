// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { PACKAGE_NAME } from "./index";

describe("@mapatlas/react", () => {
  it("exposes its package name", () => {
    expect(PACKAGE_NAME).toBe("@mapatlas/react");
  });
});
