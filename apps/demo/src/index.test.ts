// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { APP_NAME } from "./index";

describe("@mapatlas/demo", () => {
  it("exposes its app name", () => {
    expect(APP_NAME).toBe("@mapatlas/demo");
  });
});
