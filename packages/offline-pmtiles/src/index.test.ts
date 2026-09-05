// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import * as offline from "./index.js";

describe("@mapatlas/offline-pmtiles", () => {
  it("reports its package identity", () => {
    expect(offline.PACKAGE_NAME).toBe("@mapatlas/offline-pmtiles");
  });

  it("publishes exactly this value surface, and nothing else", () => {
    // Deliberately exact, and the reason is a real slip: `assertOfflineLicensed` was published
    // here while `api.md` never declared it — a public function with no contract, whose
    // signature a consumer could depend on and a refactor could not change. It is the store's
    // internal guard; `OfflineLicenseError` is published in its place, because a caller has to
    // be able to catch what the store throws.
    //
    // Not "everything api.md declares": `PACKAGE_NAME` is deliberately published and
    // deliberately absent from `api.md`, being package identity rather than contract. And
    // type-only exports (`RegionFetch`, `ArchiveRegistrar`) erase, so they cannot appear here
    // at all — `api.md` is where the type surface is pinned.
    expect(Object.keys(offline).sort()).toEqual([
      "MissingArchiveError",
      "OfflineLicenseError",
      "PACKAGE_NAME",
      "UnknownArchiveSizeError",
      "UnsupportedTransportError",
      "createPMTilesRegionStore",
      "createStoredArchiveSource",
      "installOfflineArchives",
    ]);
  });
});
