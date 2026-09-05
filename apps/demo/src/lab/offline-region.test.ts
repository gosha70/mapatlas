// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { readLabOffline, runLabOffline } from "./offline-region.js";

/**
 * The URL reader, and the one branch of `runLabOffline` that reaches no store.
 *
 * Everything else `runLabOffline` does needs IndexedDB and a real protocol registry, so its
 * evidence is the browser scenario — `e2e/offline-region.e2e.ts` — where those exist.
 */
describe("readLabOffline", () => {
  it("defaults to doing nothing about regions", () => {
    expect(readLabOffline(new URL("http://x.invalid/lab"))).toBe("off");
  });

  it("reads each step the route offers", () => {
    for (const mode of ["off", "download", "use", "delete"] as const) {
      expect(readLabOffline(new URL(`http://x.invalid/lab?offline=${mode}`))).toBe(mode);
    }
  });

  it("refuses a step it does not have, rather than quietly doing nothing", () => {
    // The reason this is a throw and not a default: a load asked to download that silently
    // skipped it would leave a scenario asserting rendered state against a map that was never
    // offline — and that pass looks exactly like the real one.
    expect(() => readLabOffline(new URL("http://x.invalid/lab?offline=downlaod"))).toThrow(
      /not one of/,
    );
  });

  it("refuses an empty value too, which is what a bare ?offline= sends", () => {
    // `searchParams.get` returns "" rather than null here, so the null check above does not
    // catch it and it would otherwise fall through to whichever branch `find` happened to miss.
    expect(() => readLabOffline(new URL("http://x.invalid/lab?offline="))).toThrow(/not one of/);
  });
});

describe("runLabOffline, in the one mode that needs no store", () => {
  it("reports no region count when it did not consult the store", async () => {
    // Absent, not zero. Zero would be a false statement about the store on any load that *does*
    // hold a region — `off` never looks, and "did not look" is not "found none".
    const report = await runLabOffline("off", []);

    expect(report.mode).toBe("off");
    expect(Object.hasOwn(report, "regions"), "off reported a count it never looked up").toBe(false);
  });

  it("does not open IndexedDB at all in that mode", async () => {
    // The assertion above resolving *here* is itself the evidence: this lane has no IndexedDB,
    // so any mode that reached the store would reject. Stated as its own test so the reason is
    // not buried, and paired with a mode that does reach it — otherwise "resolved" would prove
    // nothing about whether a store call was even possible to fail.
    await expect(runLabOffline("off", [])).resolves.toBeDefined();
    await expect(
      runLabOffline("delete", []),
      "a store-touching mode did not reach the store either, so the pair proves nothing",
    ).rejects.toThrow();
  });
});
