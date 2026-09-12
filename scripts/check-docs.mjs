// SPDX-License-Identifier: Apache-2.0

/**
 * The documentation drift gate (T7.2 increments 2 and 3).
 *
 * `PRD.md` §6 asks that a developer reach a working loop *"reading only `api.md`"*, and a snippet
 * pasted out of a source file satisfies that on the day it is pasted and not one day longer. The
 * API moves, the snippet does not, and nothing goes red — `CONTINUE.md`'s mistake **7c** wearing a
 * different hat.
 *
 * Two kinds of checked content, because documentation makes two kinds of claim:
 *
 * - **Mirrors.** Every fenced block in the quick start *is* a file of `examples/quick-start`, byte
 *   for byte — the example `check:packaging` compiles and the browser lane runs.
 * - **Projections.** A block a repository fact decides — which tarballs to install, how much of
 *   the backlog carries a Done record — generated from that fact rather than typed. The root
 *   README is why: it said *"Phase 0 complete; core implementation begins in Phase 1"* through
 *   seven phases of work, and no gate could have known.
 *
 * `--write` reprojects the generated regions. It never touches a mirror: those have two authors
 * and the gate cannot know which one is right.
 *
 * The rules live in `docs-drift.mjs` and `docs-projections.mjs` so they can be tested; this reads
 * the repository, decides, and reports.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  CONSUMER_DEPENDENCIES,
  EXAMPLE,
  PACKAGES,
  ROOT,
  exampleFiles,
  manifest,
  pinnedVersions,
} from "./consumer-project.mjs";
import {
  DOCUMENT,
  SECTION,
  blocksInSection,
  driftBetween,
  framed,
  generatedRegions,
  projectionDrift,
} from "./docs-drift.mjs";
import { renderInstall, renderStatus, taskStatus } from "./docs-projections.mjs";

/** Where the quick start tells a reader to put the tarballs it has them build. */
const TARBALL_DIRECTORY = "/tmp/mapatlas";

const write = process.argv.includes("--write");

const read = (path) => readFileSync(join(ROOT, path), "utf8");

/**
 * Build the projections, reporting a refusal as a gate failure rather than as a stack.
 *
 * `taskStatus` fails closed on a task written outside a `## Phase` heading, and that is a
 * *finding* — the entry would be missing from the README's status block — so it has to read like
 * one. An uncaught throw here would print a stack trace above a message nobody scrolls to.
 */
function projected(build) {
  try {
    return build();
  } catch (error) {
    console.error(`check:docs — ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

/**
 * The projections, per document.
 *
 * Named per document rather than globally: a region only makes sense where it was put, and a
 * `status` block that drifted into `api.md` should fail rather than quietly be accepted because
 * some document somewhere wanted one.
 */
const documents = [
  {
    path: DOCUMENT,
    projections: new Map([
      [
        "install",
        renderInstall({
          packages: PACKAGES.map((directory) => ({
            directory,
            ...manifest(join(ROOT, directory, "package.json")),
          })),
          dependencies: pinnedVersions(manifest(join(ROOT, "package.json")), CONSUMER_DEPENDENCIES),
          into: TARBALL_DIRECTORY,
        }),
      ],
    ]),
  },
  {
    path: "README.md",
    projections: new Map([
      ["status", projected(() => renderStatus(taskStatus(read("specs/tasks.md"))))],
    ]),
  },
];

const problems = [];

if (write) {
  for (const { path, projections } of documents) {
    const before = read(path);
    const lines = before.split("\n");
    // Back to front, so replacing one region cannot shift the line numbers of the next.
    for (const region of generatedRegions(before).reverse()) {
      const text = projections.get(region.name);
      if (text === undefined) continue;
      // The same `framed` the gate compares against, so the writer cannot produce something the
      // gate then rejects.
      lines.splice(region.from, region.to - region.from - 1, ...framed(text).split("\n"));
    }
    const after = lines.join("\n");
    if (after !== before) {
      writeFileSync(join(ROOT, path), after);
      console.log(`check:docs --write — reprojected the generated regions of ${path}`);
    }
  }
}

for (const { path, projections } of documents) {
  problems.push(
    ...projectionDrift({
      document: path,
      regions: generatedRegions(read(path)),
      expected: projections,
    }),
  );
}

/**
 * The files a consumer's project is built from, with their contents — one map, so what the gate
 * requires the document to show and what it compares the document against cannot be two different
 * things.
 */
const shipped = new Map(
  exampleFiles().map((relative) => [relative, read(`${EXAMPLE}/${relative}`)]),
);

const blocks = blocksInSection(read(DOCUMENT), SECTION);

if (blocks.length === 0) {
  console.error(
    `check:docs — ${DOCUMENT} has no "${SECTION}" section, or the section shows no code. ` +
      `The gate exists to hold that section to the example; with nothing to hold it would pass ` +
      `for the wrong reason.`,
  );
  process.exit(1);
}

problems.push(...driftBetween({ blocks, shipped }));

if (problems.length > 0) {
  console.error("check:docs — the documentation and the repository have come apart:\n");
  for (const problem of problems) console.error(`  ${problem}\n`);
  process.exit(1);
}

const mirrors = blocks.filter((block) => block.generated !== true).length;
const projections = documents.reduce((total, one) => total + one.projections.size, 0);
console.log(
  `check:docs — clean (${String(mirrors)} blocks in ${DOCUMENT}'s quick start, each the same ` +
    `bytes as the file it names, covering every file of ${EXAMPLE}; ` +
    `${String(projections)} generated block(s) matching what this repository projects)`,
);
