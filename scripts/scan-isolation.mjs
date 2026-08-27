// SPDX-License-Identifier: Apache-2.0

/**
 * Fails the build when a package imports something its layer forbids.
 * Rules and the matching logic live in ./isolation-rules.mjs so they can be unit-tested.
 */

import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { PACKAGE_RULES, checkFile } from "./isolation-rules.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"];
const SKIP_DIRECTORIES = new Set(["node_modules", "dist", ".git"]);

/** @param {string} dir @returns {Promise<string[]>} */
async function sourceFiles(dir) {
  /** @type {string[]} */
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRECTORIES.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sourceFiles(full)));
    else if (SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) out.push(full);
  }
  return out;
}

const violations = [];
let scanned = 0;

for (const packageKey of Object.keys(PACKAGE_RULES)) {
  for (const file of await sourceFiles(join(ROOT, packageKey))) {
    scanned += 1;
    violations.push(...checkFile(packageKey, relative(ROOT, file), readFileSync(file, "utf8")));
  }
}

if (violations.length > 0) {
  console.error(`scan:isolation — ${violations.length} violation(s):\n`);
  for (const v of violations) console.error(`  ${v.file}\n    ${v.message}`);
  console.error("\nSee specs/architecture.md §9 — the one architectural rule.");
  process.exit(1);
}

console.log(
  `scan:isolation — clean (${scanned} files across ${Object.keys(PACKAGE_RULES).length} packages)`,
);
