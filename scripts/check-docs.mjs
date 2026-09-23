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
 *   the backlog carries a Done record, which peers a package declares — generated from that fact
 *   rather than typed. The root README is why: it said *"Phase 0 complete; core implementation
 *   begins in Phase 1"* through seven phases of work, and no gate could have known.
 *
 * **Per document, since T8.2 increment 1.** The quick start is mirrored from the example a
 * consumer builds; each package README is mirrored, whole, from its own `examples/readme/<pkg>`
 * snippets, which `check:packaging` compiles against the packed tarballs. A README's links must
 * also survive being read from the tarball. Which READMEs exist is read from the package
 * inventory, asserted against `packages/*` first — a package the inventory does not know is a
 * README nobody checks.
 *
 * `--write` reprojects the generated regions. It never touches a mirror: those have two authors
 * and the gate cannot know which one is right.
 *
 * The rules live in `docs-drift.mjs` and `docs-projections.mjs` so they can be tested; this reads
 * the repository, decides, and reports.
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  CONSUMER_DEPENDENCIES,
  EXAMPLE,
  PACKAGES,
  ROOT,
  exampleFiles,
  manifest,
  pinnedVersions,
  run,
} from "./consumer-project.mjs";
import {
  DOCUMENT,
  QUICK_START,
  blocksIn,
  driftBetween,
  framed,
  generatedRegions,
  linkProblems,
  projectionDrift,
  readmeDocument,
  tarballMembers,
} from "./docs-drift.mjs";
import {
  renderAddToInstall,
  renderInstall,
  renderPeers,
  renderStatus,
  taskStatus,
} from "./docs-projections.mjs";
import {
  PACKAGE_DIRECTORIES,
  inventoryDrift,
  packageDirectoriesOnDisk,
} from "./package-inventory.mjs";

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

/**
 * Every package's README, as a mirrored document — and every package has one (T8.2 increment 2).
 * A package whose README is missing is a problem here as well as in `check:packaging`: without it,
 * that package's snippets are compiled and shown nowhere, and nothing would say so.
 */
const readmes = PACKAGE_DIRECTORIES.map((directory) => ({
  directory,
  document: readmeDocument(directory),
}));
const missing = readmes.filter(({ document }) => !existsSync(join(ROOT, document.path)));
if (missing.length > 0) {
  console.error("check:docs — every package ships a README, and these do not:\n");
  for (const { document } of missing) console.error(`  ${document.path}\n`);
  process.exit(1);
}

for (const { directory, document } of readmes) {
  const packageManifest = manifest(join(ROOT, directory, "package.json"));
  const projections = new Map([["peers", renderPeers(packageManifest)]]);
  // Only a package the quick start does not pack has an "add to install" region to project; the
  // region is what says a README carries one, and `projectionDrift` refuses one nothing produces.
  if (!PACKAGES.includes(directory)) {
    projections.set("add-to-install", renderAddToInstall({ ...packageManifest, directory }));
  }
  documents.push({ path: document.path, projections });
}

// Counted by a different route from `readmes` — a directory walk rather than the inventory — so
// that a gate which came to claim no README at all would fail here instead of passing on READMEs
// nobody read. `missing` above cannot catch that: an empty list has nothing missing from it.
const readmesOnDisk = readdirSync(join(ROOT, "packages"), { withFileTypes: true }).filter(
  (entry) => entry.isDirectory() && existsSync(join(ROOT, "packages", entry.name, "README.md")),
).length;
if (readmes.length !== readmesOnDisk) {
  console.error(
    `check:docs — ${String(readmesOnDisk)} package README(s) exist under packages/*, but this ` +
      `gate is about to check ${String(readmes.length)}. A README nobody reads is not checked.`,
  );
  process.exit(1);
}

const problems = [...inventoryDrift(PACKAGE_DIRECTORIES, packageDirectoriesOnDisk(ROOT))];
if (problems.length > 0) {
  // Nothing below is trusted while "each package" is in dispute.
  console.error("check:docs — the package inventory and packages/* disagree:\n");
  for (const problem of problems) console.error(`  ${problem}\n`);
  process.exit(1);
}

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

const blocks = blocksIn(read(DOCUMENT), QUICK_START);

if (blocks.length === 0) {
  console.error(
    `check:docs — ${DOCUMENT} has no "${QUICK_START.heading}" section, or the section shows no code. ` +
      `The gate exists to hold that section to the example; with nothing to hold it would pass ` +
      `for the wrong reason.`,
  );
  process.exit(1);
}

problems.push(...driftBetween({ blocks, shipped }));

/** Every file under a directory, relative to it — the snippets a README may mirror. */
function filesUnder(directory) {
  const walk = (relative) => {
    const absolute = join(directory, relative);
    if (!statSync(absolute).isDirectory()) return [relative];
    return readdirSync(absolute)
      .sort()
      .flatMap((entry) => walk(relative === "" ? entry : `${relative}/${entry}`));
  };
  return existsSync(directory) ? walk("") : [];
}

/**
 * What npm would pack for a package, without packing it. Asked of npm rather than derived from
 * `files`, so a link into `dist/` is held to a file that is really there; ~1 s per README, once.
 */
function packedPaths(directory) {
  const [report] = JSON.parse(run("npm", ["pack", "--dry-run", "--json"], join(ROOT, directory)));
  return report.files.map((file) => file.path);
}

let readmeMirrors = 0;
for (const { directory, document } of readmes) {
  const markdown = read(document.path);
  const snippets = new Map(
    filesUnder(join(ROOT, document.mirrors)).map((relative) => [
      relative,
      read(`${document.mirrors}/${relative}`),
    ]),
  );
  const readmeBlocks = blocksIn(markdown, document);
  const mirrored = readmeBlocks.filter((block) => block.generated !== true).length;
  readmeMirrors += mirrored;
  // Not vacuously green: a README with no snippet and no block has no drift and no usage either,
  // and once the other packages keep the shared snippet project non-empty, one package could lose
  // both together with every gate staying green. The plan's scope is one usage block per README.
  if (mirrored === 0) {
    problems.push(
      `${document.path} — shows no compiled snippet at all. Every package README carries at least ` +
        `one usage block mirrored from ${document.mirrors}; a README with none is not checked, ` +
        `it is merely not wrong.`,
    );
  }
  problems.push(
    ...driftBetween({ document, blocks: readmeBlocks, shipped: snippets }),
    ...linkProblems({ document, markdown, tarball: tarballMembers(packedPaths(directory)) }),
  );
}

if (problems.length > 0) {
  console.error("check:docs — the documentation and the repository have come apart:\n");
  for (const problem of problems) console.error(`  ${problem}\n`);
  process.exit(1);
}

const mirrors = blocks.filter((block) => block.generated !== true).length;
const projections = documents.reduce((total, one) => total + one.projections.size, 0);
console.log(
  `check:docs — clean (${String(mirrors)} blocks in ${DOCUMENT}'s quick start, each the same ` +
    `bytes as the file it names, covering every file of ${EXAMPLE}; all ` +
    `${String(PACKAGE_DIRECTORIES.length)} package READMEs present, their ${String(readmeMirrors)} ` +
    `block(s) each the bytes of a compiled snippet and their links tarball-safe; ` +
    `${String(projections)} generated block(s) matching what this repository projects)`,
);
