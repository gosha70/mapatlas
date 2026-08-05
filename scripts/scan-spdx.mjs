// SPDX-License-Identifier: Apache-2.0
/**
 * SPDX-header check (tasks.md T0.6).
 *
 * Fails the build if any tracked source file lacks
 * `SPDX-License-Identifier: Apache-2.0`.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const SOURCE_RE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".git",
]);
const NEEDLE = "SPDX-License-Identifier: Apache-2.0";

function collect(dir) {
  let out = [];
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out = out.concat(collect(full));
    } else if (SOURCE_RE.test(name)) {
      out.push(full);
    }
  }
  return out;
}

const missing = [];
for (const file of collect(repoRoot)) {
  const head = readFileSync(file, "utf8").slice(0, 512);
  if (!head.includes(NEEDLE)) {
    missing.push(file.slice(repoRoot.length));
  }
}

if (missing.length > 0) {
  console.error("SPDX-header check FAILED — missing header:");
  for (const f of missing) console.error("  - " + f);
  process.exit(1);
}

console.log("SPDX-header check passed.");
