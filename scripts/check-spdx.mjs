// SPDX-License-Identifier: Apache-2.0
//
// SPDX header check (T0.6). Fails if any source file lacks the required
// `SPDX-License-Identifier: Apache-2.0` marker. JSON and lockfiles are skipped
// (no comment syntax); Markdown carries the marker in an HTML comment.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const REQUIRED = "SPDX-License-Identifier: Apache-2.0";
const SOURCE_EXT = /\.(m|c)?[jt]sx?$/;
const SCAN_DIRS = ["packages", "apps", "scripts"];
const ROOT_FILES = ["eslint.config.js", "vitest.config.ts"];
const SKIP_DIRS = new Set(["node_modules", "dist", "coverage"]);

export function hasSpdx(content) {
  return content.includes(REQUIRED);
}

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      yield* walk(full);
    } else if (SOURCE_EXT.test(entry)) {
      yield full;
    }
  }
}

function main() {
  const files = [];
  for (const dir of SCAN_DIRS) {
    const full = join(ROOT, dir);
    try {
      files.push(...walk(full));
    } catch {
      // directory absent — nothing to scan
    }
  }
  for (const f of ROOT_FILES) {
    files.push(join(ROOT, f));
  }

  let failed = false;
  for (const file of files) {
    let content;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (!hasSpdx(content)) {
      failed = true;
      console.error(`✗ missing SPDX header: ${relative(ROOT, file)}`);
    }
  }

  if (failed) {
    console.error(`\nSPDX header check FAILED. Add "${REQUIRED}".`);
    process.exit(1);
  }
  console.log("SPDX header check passed.");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
