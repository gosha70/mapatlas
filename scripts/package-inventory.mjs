// SPDX-License-Identifier: Apache-2.0

/**
 * Every package this repository would publish (T8.2 increment 1).
 *
 * **Distinct from `PACKAGES` in `consumer-project.mjs`, on purpose.** That list is the quick-start
 * example's publish graph — five packages, and it also renders `api.md` §0's install block — and
 * adding a sixth there would tell every quick-start reader to install something the example never
 * imports. This list means "each package", which is what T8.2's acceptance criterion says: it
 * drives which READMEs `check:docs` claims, which tarballs `check:packaging` requires a README in,
 * and which tarballs the README-snippet project installs, so the three cannot disagree.
 *
 * **Asserted against `packages/*`, not merely declared.** Two hand-kept lists of six agree on the
 * day they are written; `PACKAGES` came to be five the same way. A seventh directory added without
 * a README, or one dropped from this list, fails `inventoryDrift` rather than being silently
 * uncovered.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";

/** Sorted, so a diff against the directory listing is a diff and not a shuffle. */
export const PACKAGE_DIRECTORIES = Object.freeze([
  "packages/core",
  "packages/maplibre",
  "packages/offline-pmtiles",
  "packages/react",
  "packages/recorder-web",
  "packages/storage-idb",
]);

/** The npm name a package directory publishes as, for messages that a reader will search by. */
export const packageName = (directory) => `@mapatlas/${directory.slice("packages/".length)}`;

/**
 * What `packages/*` holds on disk, as `PACKAGE_DIRECTORIES` would spell it.
 *
 * @param {string} root
 * @returns {string[]}
 */
export function packageDirectoriesOnDisk(root) {
  return readdirSync(join(root, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `packages/${entry.name}`)
    .sort();
}

/**
 * How the declared inventory and the directory disagree — empty when they do not.
 *
 * Pure, so a test can hand it a listing that does not exist on disk. Reported in both directions:
 * a package on disk that the list lacks would ship without a README nobody asked for, and a listed
 * package that is not on disk would make every gate below it pass for the wrong reason.
 *
 * @param {readonly string[]} declared
 * @param {readonly string[]} onDisk
 * @returns {string[]}
 */
export function inventoryDrift(declared, onDisk) {
  const problems = [];
  for (const directory of onDisk) {
    if (!declared.includes(directory)) {
      problems.push(
        `${directory} exists but is not in the package inventory (scripts/package-inventory.mjs), ` +
          `so no gate claims its README, its tarball or its snippets`,
      );
    }
  }
  for (const directory of declared) {
    if (!onDisk.includes(directory)) {
      problems.push(`the package inventory lists ${directory}, which does not exist`);
    }
  }
  return problems;
}
