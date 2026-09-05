// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { TileSource } from "@mapatlas/core";

import { OfflineLicenseError, assertOfflineLicensed } from "./offline-license.js";

const source = (id: string, offlineLicensed?: boolean): TileSource =>
  ({
    id,
    kind: "raster",
    transport: "template",
    url: `https://example.invalid/${id}/{z}/{x}/{y}.png`,
    attribution: "fixture",
    ...(offlineLicensed === undefined ? {} : { offlineLicensed }),
  }) satisfies TileSource;

describe("assertOfflineLicensed (ADR-0033)", () => {
  it("permits a source explicitly marked offlineLicensed", () => {
    expect(() => {
      assertOfflineLicensed([source("self-hosted", true)], ["self-hosted"]);
    }).not.toThrow();
  });

  it("refuses a source with no annotation at all", () => {
    // The decision that matters: absence is refusal, not permission. A permissive default
    // would make every un-annotated source silently bulk-downloadable — including a community
    // host pasted into a demo — and that failure is a third-party policy violation rather than
    // a bug that can be fixed afterwards.
    expect(() => {
      assertOfflineLicensed([source("unannotated")], ["unannotated"]);
    }).toThrow(OfflineLicenseError);
  });

  it("refuses a source explicitly marked false", () => {
    expect(() => {
      assertOfflineLicensed([source("community", false)], ["community"]);
    }).toThrow(OfflineLicenseError);
  });

  it("refuses a source the store was never given", () => {
    // "Not provable" and "not permitted" are the same answer when the failure is a policy
    // violation: a region naming an unknown source cannot be shown to be licensed.
    expect(() => {
      assertOfflineLicensed([source("known", true)], ["absent"]);
    }).toThrow(OfflineLicenseError);
  });

  it("names the offending source, because a region may list several", () => {
    // Without the id the consumer knows a region was refused but not which source to annotate.
    const sources = [source("ok", true), source("bad", false), source("also-bad")];
    try {
      assertOfflineLicensed(sources, ["ok", "bad", "also-bad"]);
      expect.unreachable("the refusal did not throw");
    } catch (error) {
      expect(error).toBeInstanceOf(OfflineLicenseError);
      expect((error as OfflineLicenseError).sourceId, "the first offender, by name").toBe("bad");
      expect((error as Error).message).toContain("bad");
    }
  });

  it("refuses as soon as one source in a region is unlicensed", () => {
    // Not "all sources must fail" — one unlicensed source poisons the region, because the
    // download would fetch it.
    expect(() => {
      assertOfflineLicensed([source("a", true), source("b")], ["a", "b"]);
    }).toThrow(OfflineLicenseError);
  });

  it("permits an empty region trivially", () => {
    expect(() => {
      assertOfflineLicensed([source("a", true)], []);
    }).not.toThrow();
  });
});
