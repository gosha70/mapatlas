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
 * **It claims the quick-start section of `api.md`, and every package README, and nothing else.**
 * `api.md`'s other blocks are the *contract* — declarations, not mirrors of any file — and a gate
 * that claimed them would be asserting that the contract restates an example rather than the
 * other way round. A package README is claimed whole: it has no contract section, and a block in
 * it is either a file a consumer can compile or a generated region (T8.2 increment 1).
 *
 * **Per document, since T8.2.** The rules take a `MirroredDocument` — which file, which section of
 * it (or all of it), and which directory its blocks are mirrored from — rather than reading one
 * constant each. Until then `check:docs`'s projections were per-document and its mirror rule was
 * hard-wired to one file and one heading, which T8.2's survey found and its plan corrects.
 */

import { EXAMPLE } from "./consumer-project.mjs";

/**
 * A document whose fenced blocks mirror files.
 *
 * @typedef {{ path: string, heading: string | undefined, mirrors: string }} MirroredDocument
 *   `heading` is the exact section line the claim starts at, or `undefined` to claim the whole
 *   file; `mirrors` is the directory, relative to the repository root, that block sources must
 *   name a file in.
 */

/** The one document `PRD.md` §6 names. */
export const DOCUMENT = "specs/api.md";

/**
 * The section this gate owns, matched on the whole heading line.
 *
 * A prefix match would let a later `## 0. Quick start notes` silently extend the gate's reach, and
 * a match on "quick start" anywhere would let a sentence do it.
 */
export const SECTION = "## 0. Quick start";

/** The quick start as a mirrored document: `api.md` §0, mirrored from the example. */
export const QUICK_START = Object.freeze({ path: DOCUMENT, heading: SECTION, mirrors: EXAMPLE });

/**
 * A package README as a mirrored document: the whole file, mirrored from its own snippet
 * directory — `examples/readme/<package>` — and no other. A README that showed a file from
 * another package's directory, or from the quick start, would be presenting code that its own
 * snippet project never compiled.
 *
 * @param {string} directory e.g. `packages/maplibre`
 * @returns {MirroredDocument}
 */
export function readmeDocument(directory) {
  const name = directory.slice(directory.lastIndexOf("/") + 1);
  return { path: `${directory}/README.md`, heading: undefined, mirrors: `examples/readme/${name}` };
}

/** A fence opens or closes on three backticks at the start of a line. */
const FENCE = /^```(.*)$/;

/** Any `##`-level heading ends the section — the gate stops where the contract resumes. */
const SECTION_END = /^## /;

/**
 * A generated region: `<!-- generated:status -->` … `<!-- /generated:status -->`.
 *
 * An HTML comment rather than a fence, because what these hold is *rendered* markdown — a table a
 * reader sees as a table. The marker is invisible in the rendered page and unmissable in the
 * source, which is the right way round for something nobody may edit by hand.
 */
const REGION_OPEN = /^<!-- generated:([a-z][a-z0-9-]*) -->$/;
const REGION_CLOSE = /^<!-- \/generated:([a-z][a-z0-9-]*) -->$/;

/**
 * The generated regions of a document, with the text between their markers.
 *
 * Line-based for `blocksInSection`'s reason: the question is about bytes between two markers.
 *
 * @param {string} markdown
 * @returns {{ name: string, content: string, line: number, from: number, to: number }[]}
 */
export function generatedRegions(markdown) {
  const lines = markdown.split("\n");
  const regions = [];
  let open = null;

  for (const [index, line] of lines.entries()) {
    const opening = REGION_OPEN.exec(line);
    if (opening !== null) {
      if (open !== null) {
        throw new Error(
          `a generated region "${open.name}" opened at line ${String(open.line)} is still open ` +
            `where "${opening[1]}" opens at line ${String(index + 1)}`,
        );
      }
      open = { name: opening[1], line: index + 1, body: [] };
      continue;
    }

    const closing = REGION_CLOSE.exec(line);
    if (closing !== null) {
      if (open === null || closing[1] !== open.name) {
        throw new Error(
          `line ${String(index + 1)} closes a generated region "${closing[1]}" that is not open`,
        );
      }
      regions.push({
        name: open.name,
        content: open.body.join("\n"),
        line: open.line,
        from: open.line,
        to: index + 1,
      });
      open = null;
      continue;
    }

    if (open !== null) open.body.push(line);
  }

  if (open !== null) {
    throw new Error(
      `the generated region "${open.name}" opened at line ${String(open.line)} is never closed`,
    );
  }
  return regions;
}

/**
 * A projection as it sits between its markers: one blank line either side.
 *
 * Exported because `--write` has to produce exactly what this compares against — two independent
 * notions of "framed" would be a gate and a writer that disagree, and the writer would lose.
 *
 * @param {string} projected
 * @returns {string}
 */
export function framed(projected) {
  return `\n${projected}\n`;
}

/**
 * What a document's generated regions and their projections disagree about.
 *
 * Both directions are failures and neither is a warning: a region whose projection is missing is a
 * block nothing can check, and a projection with no region is a claim the document stopped making
 * while the code that produces it stayed.
 *
 * @param {{ document: string, regions: ReturnType<typeof generatedRegions>,
 *   expected: Map<string, string> }} input
 * @returns {string[]}
 */
export function projectionDrift({ document, regions, expected }) {
  const problems = [];
  const seen = new Set();

  for (const region of regions) {
    const at = `${document}:${String(region.line)}`;
    if (!expected.has(region.name)) {
      problems.push(
        `${at} — "${region.name}" is not a projection this gate knows how to produce, so the ` +
          `block between its markers is generated by nothing and checked by nothing.`,
      );
      continue;
    }
    if (seen.has(region.name)) {
      problems.push(`${at} — "${region.name}" appears twice; two copies can say different things.`);
      continue;
    }
    seen.add(region.name);

    // **Exactly, including the framing.** `trim()` was here and was wrong: it let the projected
    // text be indented, and four spaces of indentation turns a markdown table into a code block —
    // a rendering change the gate called identical. The framing is one blank line either side,
    // which is what `--write` produces and what separates a block from the prose around it, so it
    // is part of what is checked rather than something to normalise away.
    if (region.content !== framed(expected.get(region.name) ?? "")) {
      problems.push(
        `${at} — the "${region.name}" block is not what this repository projects, byte for byte ` +
          `and including the blank line either side of it. It is generated, not written: run ` +
          `\`npm run docs:write\` rather than editing it.`,
      );
    }
  }

  for (const name of expected.keys()) {
    if (seen.has(name)) continue;
    problems.push(
      `${document} — there is no "<!-- generated:${name} -->" region, so the projection has ` +
        `nowhere to land and the document says nothing where it used to.`,
    );
  }

  return problems;
}

/**
 * The fenced blocks inside the named section.
 *
 * Deliberately line-based rather than a markdown parse: the question is about *bytes between two
 * fences*, and a parser that normalised entities, tabs or line endings on the way through would
 * answer a slightly different question than the one being asked.
 *
 * @param {string} markdown
 * @param {MirroredDocument} document whose `heading` starts the claimed section, or `undefined`
 *   for the whole file
 * @returns {{ info: string, source: string | undefined, content: string, line: number,
 *   generated: boolean }[]}
 */
export function blocksIn(markdown, document) {
  const { heading } = document;
  const lines = markdown.split("\n");
  const blocks = [];
  // Lines a generated region owns. A fence inside one is produced by a projection and checked by
  // it, so requiring it to name a source file would be requiring two owners for one block.
  const generated = new Set();
  for (const region of generatedRegions(markdown)) {
    for (let line = region.from; line <= region.to; line += 1) generated.add(line);
  }

  // A whole-file claim is "in the section" from the first line and never leaves it.
  let inSection = heading === undefined;
  let open = null;

  for (const [index, line] of lines.entries()) {
    if (open === null && heading !== undefined && line === heading) {
      inSection = true;
      continue;
    }
    // Only outside a fence: a `## ` inside a block is a comment in the code being shown, not the
    // end of the section. `index.html` alone would end it three lines in.
    if (open === null && inSection && heading !== undefined && SECTION_END.test(line)) break;
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
      open = { info, source, line: index + 1, body: [], generated: generated.has(index + 1) };
    } else {
      blocks.push({
        info: open.info,
        source: open.source,
        content: open.body.join("\n"),
        line: open.line,
        generated: open.generated,
      });
      open = null;
    }
  }

  if (open !== null) {
    throw new Error(
      `${document.path}: the block opened at line ${String(open.line)} is never closed`,
    );
  }
  return blocks;
}

/** The quick start's blocks — the call `check:docs` made before there was more than one document. */
export function blocksInSection(markdown, heading) {
  return blocksIn(markdown, { ...QUICK_START, heading });
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
 * @param {{ document?: MirroredDocument, blocks: ReturnType<typeof blocksIn>,
 *   shipped: Map<string, string> }} input `shipped` maps each file the document may mirror —
 *   relative to `document.mirrors` — to its contents; `document` defaults to the quick start.
 * @returns {string[]}
 */
export function driftBetween({ document = QUICK_START, blocks, shipped }) {
  const problems = [];
  const shown = new Map();
  const where = document.heading === undefined ? "this README" : "the quick start";
  const consumer =
    document.heading === undefined
      ? "the files this package's README snippets are compiled from"
      : "the files a consumer's project is built from";

  for (const block of blocks) {
    const at = `${document.path}:${String(block.line)}`;

    // Projected, not mirrored: `projectionDrift` owns it, and it names no file because no file is
    // what it shows.
    if (block.generated === true) continue;

    if (block.source === undefined) {
      problems.push(
        `${at} — a \`\`\`${block.info} block in ${where} names no source file. Every block ` +
          `here mirrors one, so that it can be checked; a block that cannot be checked is not ` +
          `presented as something to copy.`,
      );
      continue;
    }

    // The prefix is stripped to name a candidate, and settles nothing on its own: whether that
    // candidate is part of the example is the next question, and it is the only one that matters.
    const relative = block.source.startsWith(`${document.mirrors}/`)
      ? block.source.slice(document.mirrors.length + 1)
      : undefined;

    if (relative === undefined || !shipped.has(relative)) {
      problems.push(
        document.heading === undefined
          ? `${at} — the block mirrors "${block.source}", which is not one of the ` +
              `${String(shipped.size)} ${consumer}. This README shows what its snippet project ` +
              `compiles and nothing else, so a file that is merely readable — another package's ` +
              `snippet, the quick start, or one reached through them — is not showable here.`
          : `${at} — the block mirrors "${block.source}", which is not one of the ` +
              `${String(shipped.size)} files a consumer's project is built from. The quick start ` +
              `shows the example a consumer receives and nothing else, so a file that is merely ` +
              `readable — one beside the example, or one reached through it — is not showable here.`,
      );
      continue;
    }

    const previous = shown.get(relative);
    if (previous !== undefined) {
      problems.push(
        `${at} — "${block.source}" is already shown at ${document.path}:${String(previous)}. Two blocks ` +
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
      document.heading === undefined
        ? `${document.path} — never shows "${document.mirrors}/${relative}", which is compiled ` +
            `for it. A snippet that documents nothing is dead code with a gate.`
        : `${document.path} — the quick start never shows "${document.mirrors}/${relative}", ` +
            `which the example is built from. A reader copying what is here would not have a ` +
            `project that builds.`,
    );
  }

  return problems;
}

/**
 * The link grammar this gate reads, and the rule for what it cannot.
 *
 * Every place a README can point somewhere, on one line: an inline link `[text](dest "title")`
 * — the destination bare or in `<…>`, the title in `"…"`, `'…'` or `(…)` or absent — an HTML
 * anchor with `href` in any quoting and any case, CommonMark's two autolinks — `<scheme:…>` for
 * any scheme, and `<local@domain>`, which renders as `mailto:` — and, because Markdown has them
 * and a gate that claims "every link" cannot skip them, a reference **definition** `[label]: dest`
 * and a reference **usage** `[text][label]` or `[text][]`. A definition is the link that matters:
 * its target is judged like any other, used or not. A usage is judged for naming a label that has
 * no definition, since an unresolved reference renders as literal brackets and is a dead link too.
 *
 * **Markdown context first.** Inline code spans and backslash-escaped punctuation are masked —
 * replaced by spaces, so line numbers hold — before any link form is read: `` `[x](../y)` `` is
 * code and `\[x](../y)` is literal text, and a scanner that consumed either would be reading
 * Markdown wrong (found in review). Fenced blocks are skipped whole.
 *
 * **What the grammar does not read, it refuses.** Each recognised form is removed from the line
 * as it is read; if what remains still looks like a link — `[…](`, `<a`, an `href=` inside a tag,
 * or an unread `<…>` with a `:` or `@` in it — the line is reported as link-like syntax this gate cannot
 * interpret, rather than passed. A subset grammar that silently skipped `<a href='…'>`,
 * `[x](../y 'title')` or `<mailto:…>` was the finding this replaces, twice.
 */
const CODE_SPAN = /(`+)(?!`)[\s\S]*?[^`]\1(?!`)/g;
const ESCAPED = /\\[!-/:-@[-`{-~]/g;
const INLINE = /\[[^\]]*\]\(\s*(?:<([^>]*)>|([^\s)]+))(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
/** CommonMark: a URI autolink is `<scheme:…>` with a 2–32 character scheme and no spaces. */
const URI_AUTOLINK = /<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\s]*)>/g;
/** And an email autolink is `<local@domain>`, which renders as a `mailto:` link. */
const EMAIL_AUTOLINK =
  /<([A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*)>/g;
const ANCHOR = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi;
const DEFINITION = /^\s{0,3}\[([^\]]+)\]:\s*(?:<([^>]*)>|(\S+))/;
const USAGE = /\[([^\]]+)\]\[([^\]]*)\]/g;
/**
 * Anything link-shaped the forms above did not consume: a bracketed span followed by `(`, an
 * anchor tag, an `href` inside any tag, or any `<…:…>` / `<…@…>`. Shaped as a link must be, so
 * that the literal text an escape leaves behind — `\[x](../y)` is the text `[x](../y)` — is not
 * mistaken for one.
 */
const LINK_LIKE = /\[[^\]]*\]\(|<a\b|<[a-z][^>]*\bhref\s*=|<[^<>\s]*[:@][^<>\s]*>/i;
/** A target that resolves wherever the README is read: any scheme, not only `http(s)`. */
const ABSOLUTE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** Whether a relative path stays inside the tarball root once normalised: no `..`, no absolute. */
const escapes = (path) =>
  path.startsWith("/") || path.split("/").some((segment) => segment === "..");

/**
 * Links in a package README that would not resolve for the reader it is written for.
 *
 * **A README is read from a tarball** (T8.2's settled item 1), and a tarball holds exactly the
 * files npm packed — not `specs/`, not `SECURITY.md`, not the repository. So `../../specs/api.md`
 * works in the checkout and is a dead link for exactly the consumer this document serves, and so
 * is `dist/not-shipped.js`, and so is `dist/../../specs/api.md`, which stays lexically "under
 * `dist`" while leaving it. Every link is therefore either an **absolute URL**, a fragment of this
 * page, or the exact path of a file **in the packed tarball**, with no traversal. Fenced blocks
 * are skipped: a URL in code is code.
 *
 * @param {{ document: MirroredDocument, markdown: string, tarball: Set<string> }} input `tarball`
 *   is the set of paths the package's tarball actually carries — see `tarballMembers`.
 * @returns {string[]}
 */
export function linkProblems({ document, markdown, tarball }) {
  const problems = [];
  const defined = new Set();
  const targets = [];
  const usages = [];
  let inFence = false;
  for (const [index, line] of markdown.split("\n").entries()) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const at = index + 1;
    // Masked before anything is read, and to the same length: code is code and `\[` is a bracket.
    let rest = line.replace(CODE_SPAN, (span) => " ".repeat(span.length)).replace(ESCAPED, "  ");

    const definition = DEFINITION.exec(rest);
    if (definition !== null) {
      defined.add(definition[1].toLowerCase());
      targets.push({ line: at, target: definition[2] ?? definition[3] });
      rest = rest.slice(definition[0].length);
    }
    // Each form is consumed as it is read, so that what is left can be judged as a whole.
    rest = rest.replace(INLINE, (_, bracketed, bare) => {
      targets.push({ line: at, target: bracketed ?? bare });
      return " ";
    });
    rest = rest.replace(URI_AUTOLINK, (_, target) => {
      targets.push({ line: at, target });
      return " ";
    });
    rest = rest.replace(EMAIL_AUTOLINK, (_, address) => {
      targets.push({ line: at, target: `mailto:${address}` });
      return " ";
    });
    rest = rest.replace(ANCHOR, (_, dq, sq, bare) => {
      targets.push({ line: at, target: dq ?? sq ?? bare });
      return " ";
    });
    rest = rest.replace(USAGE, (_, text, label) => {
      usages.push({ line: at, label: (label === "" ? text : label).toLowerCase() });
      return " ";
    });
    if (LINK_LIKE.test(rest)) {
      problems.push(
        `${document.path}:${String(at)} — link-like syntax this gate cannot read: ` +
          `${JSON.stringify(rest.trim().slice(0, 60))}. Every link here is judged, so a form the ` +
          `grammar does not cover is refused rather than skipped.`,
      );
    }
  }

  for (const { line, target } of targets) {
    if (ABSOLUTE.test(target) || target.startsWith("#")) continue;
    const path = target.replace(/^\.\//, "").split("#")[0];
    if (!escapes(path) && tarball.has(path)) continue;
    problems.push(
      `${document.path}:${String(line)} — the link "${target}" is not an absolute URL and not ` +
        `a file in this package's tarball. This README is read from the tarball, where that ` +
        `link is dead; link to https://github.com/… or to a shipped file, by its exact path.`,
    );
  }
  for (const { line, label } of usages) {
    if (defined.has(label)) continue;
    problems.push(
      `${document.path}:${String(line)} — the reference link "[${label}]" has no definition in ` +
        `this README, so it renders as literal brackets and points nowhere.`,
    );
  }
  return problems;
}

/**
 * The paths a package's tarball carries, exactly: what `npm pack --dry-run --json` reports it
 * would pack, normalised. Read from npm rather than derived from `files`, because a manifest
 * says which directories are packed and not which files exist in them — and a link into a
 * shipped directory at a file that is not there is as dead as one out of the tarball.
 *
 * @param {readonly string[]} packedPaths the `files[].path` entries npm reports
 * @returns {Set<string>}
 */
export function tarballMembers(packedPaths) {
  return new Set(packedPaths.map((path) => path.replace(/^\.\//, "")));
}
