// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { ID_LENGTH, createIdFactory, newId } from "./ids.js";

const CROCKFORD = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]+$/;

describe("newId", () => {
  it("is 26 Crockford base32 characters", () => {
    const id = newId();
    expect(id).toHaveLength(ID_LENGTH);
    expect(id).toMatch(CROCKFORD);
  });

  it("omits the ambiguous letters I, L, O and U", () => {
    const ids = Array.from({ length: 500 }, () => newId()).join("");
    for (const letter of ["I", "L", "O", "U"]) expect(ids).not.toContain(letter);
  });

  it("does not collide across many mints", () => {
    const ids = new Set(Array.from({ length: 10_000 }, () => newId()));
    expect(ids.size).toBe(10_000);
  });
});

describe("chronological sort order", () => {
  it("sorts by creation time as plain strings", () => {
    let clock = 1_700_000_000_000;
    const nextId = createIdFactory({ now: () => (clock += 1000) });
    const ids = Array.from({ length: 50 }, () => nextId());
    expect([...ids].sort()).toEqual(ids);
  });

  it("still sorts within a single millisecond — the reason this is not UUIDv4", () => {
    // A segment and its laps are minted in one burst. A redrawn random component would
    // put them in arbitrary order; an incremented one keeps them in creation order.
    const nextId = createIdFactory({ now: () => 1_700_000_000_000 });
    const ids = Array.from({ length: 1000 }, () => nextId());
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(1000);
  });

  it("carries the increment across a symbol boundary", () => {
    const nextId = createIdFactory({
      now: () => 1_700_000_000_000,
      random: () => "ZZZZZZZZZZZZZZZY", // one below overflow
    });
    const first = nextId();
    const second = nextId();
    expect(second > first).toBe(true);
    expect(second.slice(10)).toBe("ZZZZZZZZZZZZZZZZ");
  });

  it("throws rather than emitting an out-of-order id when randomness is exhausted", () => {
    const nextId = createIdFactory({
      now: () => 1_700_000_000_000,
      random: () => "ZZZZZZZZZZZZZZZZ",
    });
    expect(nextId()).toHaveLength(ID_LENGTH);
    expect(() => nextId()).toThrow(/exhausted/);
  });
});

describe("mint order is not trip chronology", () => {
  it("gives an imported old trip a newer id than a recorded recent one", () => {
    // The trap this test exists to prevent: a Phase 2 adapter listing by id and calling
    // the result "recent trips". An imported 2019 trip is minted today, so it sorts last
    // by id and first by startedAt. Chronology comes from startedAt, never from the id.
    let clock = 1_700_000_000_000;
    const nextId = createIdFactory({ now: () => (clock += 1000) });

    const recordedLastWeek = { id: nextId(), startedAt: 1_699_000_000_000 };
    const importedFrom2019 = { id: nextId(), startedAt: 1_550_000_000_000 };

    expect(importedFrom2019.id > recordedLastWeek.id).toBe(true);
    expect(importedFrom2019.startedAt).toBeLessThan(recordedLastWeek.startedAt);

    const byId = [recordedLastWeek, importedFrom2019].sort((a, b) => a.id.localeCompare(b.id));
    const byStart = [recordedLastWeek, importedFrom2019].sort((a, b) => a.startedAt - b.startedAt);
    expect(byId).not.toEqual(byStart);
  });
});

describe("time encoding", () => {
  it("encodes the epoch as all zeroes", () => {
    const nextId = createIdFactory({ now: () => 0, random: () => "0000000000000000" });
    expect(nextId()).toBe("0".repeat(ID_LENGTH));
  });

  it("rejects a timestamp outside the 48-bit range", () => {
    expect(() => createIdFactory({ now: () => 2 ** 48 })()).toThrow(RangeError);
    expect(() => createIdFactory({ now: () => -1 })()).toThrow(RangeError);
  });

  it("accepts an injected random source, so an environment without Web Crypto can supply one", () => {
    const nextId = createIdFactory({ now: () => 1, random: () => "ABCDEFGHJKMNPQRS" });
    expect(nextId()).toBe("0000000001ABCDEFGHJKMNPQRS");
  });
});
