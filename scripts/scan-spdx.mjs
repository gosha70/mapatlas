// SPDX-License-Identifier: Apache-2.0

/**
 * Every source file carries an SPDX identifier (CLAUDE.md, ADR-0006).
 * A missing header is a licensing defect, so it fails the build like any other.
 */

import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const IDENTIFIER = "SPDX-License-Identifier: Apache-2.0";
const ROOTS = ["packages", "apps", "scripts"];
const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".mjs", ".js", ".jsx"];
const SKIP_DIRECTORIES = new Set(["node_modules", "dist", ".git"]);
const EXEMPT = new Set(["eslint.config.mjs", "vitest.config.ts"]);

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
    else if (EXTENSIONS.some((ext) => entry.name.endsWith(ext))) out.push(full);
  }
  return out;
}

const missing = [];
let scanned = 0;

for (const root of ROOTS) {
  for (const file of await sourceFiles(join(ROOT, root))) {
    const rel = relative(ROOT, file);
    if (EXEMPT.has(rel)) continue;
    scanned += 1;
    // Only the head of the file: a header buried below the imports is not a header.
    if (!readFileSync(file, "utf8").slice(0, 512).includes(IDENTIFIER)) missing.push(rel);
  }
}

if (missing.length > 0) {
  console.error(`scan:spdx — ${missing.length} file(s) missing "${IDENTIFIER}":\n`);
  for (const file of missing) console.error(`  ${file}`);
  process.exit(1);
}

console.log(`scan:spdx — clean (${scanned} files)`);
