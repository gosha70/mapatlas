// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import type { StorageAdapter } from "../storage.js";
import { createMemoryStorageAdapter } from "./memory-storage.js";
import { storageAdapterContract } from "./storage-contract.js";

/**
 * The engine's own adapter, held to the contract it publishes. Mapping the cases into a
 * runner is exactly what a third-party implementer does — three lines, no coupling.
 */
describe("createMemoryStorageAdapter satisfies the StorageAdapter contract", () => {
  for (const { name, run } of storageAdapterContract(createMemoryStorageAdapter)) {
    it(name, run);
  }
});

describe("the contract itself", () => {
  it("is framework-neutral: plain names and functions, no runner import", () => {
    const cases = storageAdapterContract(createMemoryStorageAdapter);
    expect(cases.length).toBeGreaterThan(15);
    for (const testCase of cases) {
      expect(typeof testCase.name).toBe("string");
      expect(typeof testCase.run).toBe("function");
    }
  });

  it("takes a fresh adapter per case, so cases cannot leak into each other", async () => {
    let created = 0;
    const cases = storageAdapterContract(() => {
      created += 1;
      return createMemoryStorageAdapter();
    });

    expect(created).toBe(0); // nothing built until a case runs
    await cases[0]?.run();
    await cases[1]?.run();
    expect(created).toBe(2);
  });

  it("accepts an async factory", async () => {
    const cases = storageAdapterContract(() => Promise.resolve(createMemoryStorageAdapter()));
    await expect(cases[0]?.run()).resolves.toBeUndefined();
  });

  it("fails a non-conforming adapter with an ordinary, readable Error", async () => {
    // Plain Errors, not runner matchers: a project using node:test or Jest must be able to
    // report a failure without importing anything of ours.
    const conforming = createMemoryStorageAdapter();
    const forgetful: StorageAdapter = { ...conforming, getTrack: () => Promise.resolve(undefined) };

    const roundTrip = storageAdapterContract(() => forgetful).find((c) =>
      c.name.includes("returns an equal track"),
    );

    await expect(roundTrip?.run()).rejects.toThrow(
      /StorageAdapter contract: the retrieved track differs/,
    );
    await expect(roundTrip?.run()).rejects.toBeInstanceOf(Error);
  });

  it("catches an adapter that returns id order instead of chronological order", async () => {
    // Regression: the case used to sort the adapter's result before asserting, which
    // normalised away the behaviour under test — this adapter passed.
    const inner = createMemoryStorageAdapter();
    const idOrdered: StorageAdapter = {
      ...inner,
      listTrackSummaries: async () =>
        (await inner.listTrackSummaries()).sort((a, b) => a.id.localeCompare(b.id)),
    };

    const chronological = storageAdapterContract(() => idOrdered).find((c) =>
      c.name.includes("startedAt order"),
    );

    await expect(chronological?.run()).rejects.toThrow(/not in startedAt order/);
  });

  it("accepts an adapter whose objects have keys in a different order", async () => {
    // Persistence legitimately rebuilds an equal Track with its keys elsewhere. A
    // JSON.stringify comparison would fail a conforming adapter.
    const inner = createMemoryStorageAdapter();
    const reordering: StorageAdapter = {
      ...inner,
      getTrack: async (id) => {
        const track = await inner.getTrack(id);
        return track === undefined
          ? undefined
          : (Object.fromEntries(Object.entries(track).reverse()) as typeof track);
      },
    };

    const roundTrip = storageAdapterContract(() => reordering).find((c) =>
      c.name.includes("returns an equal track"),
    );

    await expect(roundTrip?.run()).resolves.toBeUndefined();
  });

  it("catches the aliasing divergence that only shows against real persistence", async () => {
    // An adapter that stores the caller's object instead of a copy passes naive testing and
    // breaks the moment it meets a serialising implementation. The contract exists to catch
    // exactly this class of difference.
    const tracks = new Map<string, unknown>();
    const aliasing: StorageAdapter = {
      ...createMemoryStorageAdapter(),
      saveTrack: (track) => {
        tracks.set(track.id, track); // no copy
        return Promise.resolve();
      },
      getTrack: (id) => Promise.resolve(tracks.get(id) as never),
    };

    const decoupled = storageAdapterContract(() => aliasing).find((c) =>
      c.name.includes("decoupled from the object"),
    );

    await expect(decoupled?.run()).rejects.toThrow(/aliased the argument/);
  });
});
