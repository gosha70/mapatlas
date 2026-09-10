// SPDX-License-Identifier: Apache-2.0

/**
 * The rules behind `check:docs`: does the documentation still show the code it claims to show?
 * (T7.2 increment 2)
 *
 * Pure, and separate from the gate that runs them, on the same terms as `isolation-rules.mjs`:
 * a module that reads a file and calls `process.exit` when it is imported cannot be unit-tested,
 * because importing it *is* running the gate — and a test suite would then die on a repository
 * the gate happened to dislike.
 *
 * `PRD.md` §6 asks that a developer reach a working loop *"reading only `api.md`"*, and a snippet
 * pasted out of a source file satisfies that on the day it is pasted and not one day longer. The
 * API moves, the snippet does not, and nothing goes red — which is `CONTINUE.md`'s mistake **7c**
 * wearing a different hat: code repeated forward from an interface rather than checked against it.
 *
 * So the quick start does not *contain* code. It **mirrors** the example that
 * `check:packaging` compiles and the browser lane runs, byte for byte, and this is what makes the
 * mirror a fact rather than an intention. Editing either side alone fails the build.
 *
 * **Four rules, and each is one a reader would care about:**
 *
 * 1. every fenced block in the quick start declares which file it shows;
 * 2. that file is part of the example, so the section cannot quietly mirror something a consumer
 *    never receives;
 * 3. the block's bytes are the file's bytes;
 * 4. and every file the consumer project is built from appears — a quick start showing five of six
 *    files hands the reader a project that does not build, with nothing wrong in the five it did
 *    show.
 *
 * **It claims the quick-start section and nothing else.** `api.md`'s other blocks are the
 * *contract* — declarations, not mirrors of any file — and a gate that claimed them would be
 * asserting that the contract restates an example rather than the other way round.
 */

import { EXAMPLE } from "./consumer-project.mjs";

/** The one document, because `PRD.md` §6 says one. */
export const DOCUMENT = "specs/api.md";

/**
 * The section this gate owns, matched on the whole heading line.
 *
 * A prefix match would let a later `## 0. Quick start notes` silently extend the gate's reach, and
 * a match on "quick start" anywhere would let a sentence do it.
 */
export const SECTION = "## 0. Quick start";

/** A fence opens or closes on three backticks at the start of a line. */
const FENCE = /^```(.*)$/;

/** Any `##`-level heading ends the section — the gate stops where the contract resumes. */
const SECTION_END = /^## /;

/**
 * The fenced blocks inside the named section.
 *
 * Deliberately line-based rather than a markdown parse: the question is about *bytes between two
 * fences*, and a parser that normalised entities, tabs or line endings on the way through would
 * answer a slightly different question than the one being asked.
 *
 * @param {string} markdown
 * @param {string} heading the exact heading line the section starts at
 * @returns {{ info: string, source: string | undefined, content: string, line: number }[]}
 */
export function blocksInSection(markdown, heading) {
  const lines = markdown.split("\n");
  const blocks = [];

  let inSection = false;
  let open = null;

  for (const [index, line] of lines.entries()) {
    if (open === null && line === heading) {
      inSection = true;
      continue;
    }
    // Only outside a fence: a `## ` inside a block is a comment in the code being shown, not the
    // end of the section. `index.html` alone would end it three lines in.
    if (open === null && inSection && SECTION_END.test(line)) break;
    if (!inSection) continue;

    const fence = FENCE.exec(line);
    if (fence === null) {
      if (open !== null) open.body.push(line);
      continue;
    }

    if (open === null) {
      const info = (fence[1] ?? "").trim();
      // The first word is the language, for highlighting; the rest is the path. Both are for a
      // reader as much as for this gate — a block that does not say which file it is cannot be
      // copied into the right place.
      const [, source] = info.split(/\s+/, 2);
      open = { info, source, line: index + 1, body: [] };
    } else {
      blocks.push({
        info: open.info,
        source: open.source,
        content: open.body.join("\n"),
        line: open.line,
      });
      open = null;
    }
  }

  if (open !== null) {
    throw new Error(`${DOCUMENT}: the block opened at line ${String(open.line)} is never closed`);
  }
  return blocks;
}

/**
 * What the quick start and the example disagree about.
 *
 * **`shipped` is one map, not a list plus a reader, and that is the load-bearing part.** An
 * earlier version took the set of required files and a `read` function separately, and decided
 * membership by asking whether the declared path *started with* the example's directory. A prefix
 * is a spelling, not a membership: `examples/quick-start/notes.ts` is readable and is not part of
 * what a consumer receives, and `examples/quick-start/../../packages/core/src/index.ts` has the
 * prefix too. Both were accepted. Collapsing the two inputs into the map of files the consumer
 * project is actually built from removes the question — a block is checked against a file if and
 * only if that file is one a consumer gets.
 *
 * Injected rather than read here so the rules can be tested against documents and trees that do
 * not exist on disk. A gate whose only test is "run it on the repository" passes for as long as
 * the repository happens to be right, and says nothing about what it would catch.
 *
 * @param {{ blocks: ReturnType<typeof blocksInSection>, shipped: Map<string, string> }} input
 *   `shipped` maps each file of the example — relative to its root — to its contents.
 * @returns {string[]}
 */
export function driftBetween({ blocks, shipped }) {
  const problems = [];
  const shown = new Map();

  for (const block of blocks) {
    const at = `${DOCUMENT}:${String(block.line)}`;

    if (block.source === undefined) {
      problems.push(
        `${at} — a \`\`\`${block.info} block in the quick start names no source file. Every block ` +
          `here mirrors one, so that it can be checked; a block that cannot be checked is not ` +
          `presented as something to copy.`,
      );
      continue;
    }

    // The prefix is stripped to name a candidate, and settles nothing on its own: whether that
    // candidate is part of the example is the next question, and it is the only one that matters.
    const relative = block.source.startsWith(`${EXAMPLE}/`)
      ? block.source.slice(EXAMPLE.length + 1)
      : undefined;

    if (relative === undefined || !shipped.has(relative)) {
      problems.push(
        `${at} — the block mirrors "${block.source}", which is not one of the ` +
          `${String(shipped.size)} files a consumer's project is built from. The quick start ` +
          `shows the example a consumer receives and nothing else, so a file that is merely ` +
          `readable — one beside the example, or one reached through it — is not showable here.`,
      );
      continue;
    }

    const previous = shown.get(relative);
    if (previous !== undefined) {
      problems.push(
        `${at} — "${block.source}" is already shown at ${DOCUMENT}:${String(previous)}. Two blocks ` +
          `for one file can disagree with each other while both match it in part.`,
      );
      continue;
    }
    shown.set(relative, block.line);

    // The file ends with a newline and the block's body does not carry the fence's own line break,
    // so the file's trailing newline is what is being reconciled here — not a normalisation of
    // whatever else the two might differ by.
    if (block.content !== (shipped.get(relative) ?? "").replace(/\n$/, "")) {
      problems.push(
        `${at} — the block and "${block.source}" are not the same bytes. Whichever was edited, ` +
          `the other has to follow: the document does not describe the example, it shows it.`,
      );
    }
  }

  for (const relative of shipped.keys()) {
    if (shown.has(relative)) continue;
    problems.push(
      `${DOCUMENT} — the quick start never shows "${EXAMPLE}/${relative}", which the example is ` +
        `built from. A reader copying what is here would not have a project that builds.`,
    );
  }

  return problems;
}
