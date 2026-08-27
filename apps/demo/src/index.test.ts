// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { APP_NAME } from "./index.js";

describe("@mapatlas/demo", () => {
  it("reports its app identity", () => {
    expect(APP_NAME).toBe("@mapatlas/demo");
  });
});
