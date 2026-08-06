// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { newId, ID_LENGTH } from "./id";

const CROCKFORD = /^[0-9A-HJKMNP-TV-Z]+$/;

describe("newId", () => {
  it("produces ids of the fixed ULID length", () => {
    expect(newId()).toHaveLength(ID_LENGTH);
  });

  it("uses only Crockford base32 characters", () => {
    for (let i = 0; i < 100; i++) {
      expect(newId()).toMatch(CROCKFORD);
    }
  });

  it("produces unique ids", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) ids.add(newId());
    expect(ids.size).toBe(1000);
  });
});
