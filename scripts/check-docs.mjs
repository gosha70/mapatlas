// SPDX-License-Identifier: Apache-2.0

/**
 * The documentation drift gate (T7.2 increment 2).
 *
 * `PRD.md` §6 asks that a developer reach a working loop *"reading only `api.md`"*, and a snippet
 * pasted out of a source file satisfies that on the day it is pasted and not one day longer. The
 * API moves, the snippet does not, and nothing goes red — `CONTINUE.md`'s mistake **7c** wearing a
 * different hat.
 *
 * So the quick start does not *contain* code. It mirrors the example that `check:packaging`
 * compiles and the browser lane runs, byte for byte, and this is what makes the mirror a fact
 * rather than an intention. The rules are in `docs-drift.mjs` so they can be tested; this reads
 * the repository and reports.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { EXAMPLE, ROOT, exampleFiles } from "./consumer-project.mjs";
import { DOCUMENT, SECTION, blocksInSection, driftBetween } from "./docs-drift.mjs";

const document_ = readFileSync(join(ROOT, DOCUMENT), "utf8");
const blocks = blocksInSection(document_, SECTION);

if (blocks.length === 0) {
  console.error(
    `check:docs — ${DOCUMENT} has no "${SECTION}" section, or the section shows no code. ` +
      `The gate exists to hold that section to the example; with nothing to hold it would pass ` +
      `for the wrong reason.`,
  );
  process.exit(1);
}

/**
 * The files a consumer's project is built from, with their contents — one map, so what the gate
 * requires the document to show and what it compares the document against cannot be two different
 * things.
 */
const shipped = new Map(
  exampleFiles().map((relative) => [relative, readFileSync(join(ROOT, EXAMPLE, relative), "utf8")]),
);

const problems = driftBetween({ blocks, shipped });

if (problems.length > 0) {
  console.error("check:docs — the quick start and the example it shows have come apart:\n");
  for (const problem of problems) console.error(`  ${problem}\n`);
  process.exit(1);
}

console.log(
  `check:docs — clean (${String(blocks.length)} blocks in ${DOCUMENT}'s quick start, ` +
    `each the same bytes as the file it names, covering every file of ${EXAMPLE})`,
);
