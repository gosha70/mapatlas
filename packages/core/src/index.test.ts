// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { PACKAGE_NAME } from "./index.js";

describe("@mapatlas/core", () => {
  it("reports its package identity", () => {
    expect(PACKAGE_NAME).toBe("@mapatlas/core");
  });
});
