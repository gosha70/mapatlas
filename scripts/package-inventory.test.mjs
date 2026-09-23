// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { PACKAGES, ROOT } from "./consumer-project.mjs";
import {
  PACKAGE_DIRECTORIES,
  inventoryDrift,
  packageDirectoriesOnDisk,
  packageName,
} from "./package-inventory.mjs";

describe("the package inventory", () => {
  /**
   * **Falsifier: the inventory and `packages/*` out of step.** Two hand-kept lists of six agree on
   * the day they are written; `PACKAGES` came to be five that way. Asserted against the directory
   * here, and by both gates before they trust "each package".
   */
  it("is exactly what packages/* holds, on disk", () => {
    expect(inventoryDrift(PACKAGE_DIRECTORIES, packageDirectoriesOnDisk(ROOT))).toStrictEqual([]);
    expect(PACKAGE_DIRECTORIES).toHaveLength(6);
  });

  it("reports a package on disk the inventory lacks, and a listed one that is not there", () => {
    const declared = ["packages/a", "packages/b"];
    expect(inventoryDrift(declared, ["packages/a", "packages/b", "packages/c"])).toStrictEqual([
      expect.stringMatching(/^packages\/c exists but is not in the package inventory/),
    ]);
    expect(inventoryDrift(declared, ["packages/a"])).toStrictEqual([
      expect.stringMatching(/lists packages\/b, which does not exist/),
    ]);
  });

  /**
   * Distinct from `PACKAGES` on purpose: that list is the quick-start example's publish graph and
   * renders api.md §0's install block. This one is "each package". They are allowed to differ, and
   * today they do by exactly the package the example never imports.
   */
  it("is not PACKAGES, and differs from it by the package the quick start does not use", () => {
    const onlyHere = PACKAGE_DIRECTORIES.filter((one) => !PACKAGES.includes(one));
    expect(onlyHere).toStrictEqual(["packages/offline-pmtiles"]);
    expect(PACKAGES.every((one) => PACKAGE_DIRECTORIES.includes(one))).toBe(true);
  });

  it("names a package from its directory", () => {
    expect(packageName("packages/storage-idb")).toBe("@mapatlas/storage-idb");
  });
});
