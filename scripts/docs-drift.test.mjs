// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { EXAMPLE } from "./consumer-project.mjs";
import {
  SECTION,
  blocksIn,
  blocksInSection,
  driftBetween,
  framed,
  generatedRegions,
  linkProblems,
  projectionDrift,
  readmeDocument,
  tarballMembers,
} from "./docs-drift.mjs";

/**
 * Documents built here rather than read from the repository.
 *
 * A gate whose only test is "run it on this repository" passes for as long as the repository
 * happens to be right, and says nothing about what it would catch. Each rule below is given a
 * document that breaks exactly one thing.
 */
const document_ = (...lines) => lines.join("\n");
const block = (info, ...body) => document_("```" + info, ...body, "```");

/**
 * `shipped` is the files a consumer's project is built from, and their contents.
 *
 * There is nothing else to supply, and that is the fix for the finding: a file that exists, is
 * readable, and is not part of the example is simply not a key here, so there is no path by which
 * the rules could reach it.
 */
const check = (markdown, shipped) =>
  driftBetween({
    blocks: blocksInSection(markdown, SECTION),
    shipped: new Map(Object.entries(shipped)),
  });

describe("blocksInSection", () => {
  it("reads only the named section", () => {
    const markdown = document_(
      block("ts before.ts", "before"),
      SECTION,
      block(`ts ${EXAMPLE}/src/a.ts`, "inside"),
      "## 1. After",
      block("ts after.ts", "after"),
    );
    expect(blocksInSection(markdown, SECTION).map((b) => b.content)).toStrictEqual(["inside"]);
  });

  /**
   * A `##` inside a block is code being shown, not the end of the section — `index.html`'s own
   * comments would otherwise close it three lines in, and every block after that would silently
   * stop being checked.
   */
  it("is not ended by a heading that is inside a block", () => {
    const markdown = document_(
      SECTION,
      block(`md ${EXAMPLE}/src/a.md`, "## not a heading here"),
      block(`ts ${EXAMPLE}/src/b.ts`, "still inside"),
    );
    expect(blocksInSection(markdown, SECTION)).toHaveLength(2);
  });

  it("splits the info string into a language and a path", () => {
    const [only] = blocksInSection(
      document_(SECTION, block(`tsx ${EXAMPLE}/src/a.tsx`, "x")),
      SECTION,
    );
    expect(only?.source).toBe(`${EXAMPLE}/src/a.tsx`);
  });

  it("refuses a block that is never closed, rather than reading to the end of the file", () => {
    expect(() => blocksInSection(document_(SECTION, "```ts x.ts", "body"), SECTION)).toThrow(
      /never closed/,
    );
  });
});

describe("driftBetween", () => {
  it("says nothing when every block is its file", () => {
    const markdown = document_(SECTION, block(`ts ${EXAMPLE}/src/a.ts`, "one", "two"));
    expect(check(markdown, { "src/a.ts": "one\ntwo\n" })).toStrictEqual([]);
  });

  it("reports a block whose bytes have moved away from the file", () => {
    const markdown = document_(SECTION, block(`ts ${EXAMPLE}/src/a.ts`, "one", "TWO"));
    expect(check(markdown, { "src/a.ts": "one\ntwo\n" })).toStrictEqual([
      expect.stringContaining("not the same bytes"),
    ]);
  });

  /**
   * The direction that is easy to forget: the *file* is what moved. It has to be the same failure,
   * because "which one is wrong" is not a question a gate can answer — only "these disagree".
   */
  it("reports the same drift when the file is what changed", () => {
    const markdown = document_(SECTION, block(`ts ${EXAMPLE}/src/a.ts`, "one", "two"));
    expect(check(markdown, { "src/a.ts": "one\ntwo\nthree\n" })).toStrictEqual([
      expect.stringContaining("not the same bytes"),
    ]);
  });

  it("refuses a block that names no file, instead of letting it through unchecked", () => {
    const markdown = document_(
      SECTION,
      block("sh", "npm install @mapatlas/react"),
      block(`ts ${EXAMPLE}/src/a.ts`, "one"),
    );
    expect(check(markdown, { "src/a.ts": "one\n" })).toStrictEqual([
      expect.stringContaining("names no source file"),
    ]);
  });

  it("refuses a block that mirrors something outside the example", () => {
    const markdown = document_(
      SECTION,
      block("ts packages/core/src/index.ts", "x"),
      block(`ts ${EXAMPLE}/src/a.ts`, "one"),
    );
    expect(check(markdown, { "src/a.ts": "one\n" })).toStrictEqual([
      expect.stringContaining("not one of the 1 files"),
    ]);
  });

  /**
   * **The finding this shape exists to close.** A file can sit under the example's directory, be
   * perfectly readable, and still not be one a consumer receives — `EXAMPLE_FILES` copies
   * `index.html`, `tsconfig.json` and `src/`, so anything else beside them is not shipped. The
   * previous rule decided membership by a lexical prefix and accepted it, and completeness could
   * not object either: completeness only notices required files that are *missing*, never extras.
   */
  it("refuses a readable file that sits under the example but is not shipped", () => {
    const markdown = document_(
      SECTION,
      block(`ts ${EXAMPLE}/notes.ts`, "readable, and not part of the project"),
      block(`ts ${EXAMPLE}/src/a.ts`, "one"),
    );
    expect(check(markdown, { "src/a.ts": "one\n" })).toStrictEqual([
      expect.stringContaining(`mirrors "${EXAMPLE}/notes.ts"`),
    ]);
  });

  /** And a path that only *reaches* the example carries the prefix too. */
  it("refuses a path that traverses back out of the example", () => {
    const markdown = document_(
      SECTION,
      block(`ts ${EXAMPLE}/../../packages/core/src/index.ts`, "x"),
      block(`ts ${EXAMPLE}/src/a.ts`, "one"),
    );
    expect(check(markdown, { "src/a.ts": "one\n" })).toStrictEqual([
      expect.stringContaining("not one of the 1 files"),
    ]);
  });

  /**
   * Two blocks for one file can each match part of it and disagree with each other, and a reader
   * copying the second would silently overwrite the first.
   */
  it("refuses the same file shown twice", () => {
    const markdown = document_(
      SECTION,
      block(`ts ${EXAMPLE}/src/a.ts`, "one"),
      block(`ts ${EXAMPLE}/src/a.ts`, "one"),
    );
    expect(check(markdown, { "src/a.ts": "one\n" })).toStrictEqual([
      expect.stringContaining("is already shown"),
    ]);
  });

  /**
   * The completeness half. Nothing about the file that *is* shown is wrong, so byte comparison
   * alone would pass while a reader copying the section got a project that does not build.
   */
  it("reports a file of the example the quick start never shows", () => {
    const markdown = document_(SECTION, block(`ts ${EXAMPLE}/src/a.ts`, "one"));
    expect(check(markdown, { "src/a.ts": "one\n", "src/b.ts": "two\n" })).toStrictEqual([
      expect.stringContaining("never shows"),
    ]);
  });
});

describe("generatedRegions", () => {
  it("returns the text between the markers, and neither marker", () => {
    const markdown = document_(
      "intro",
      "<!-- generated:status -->",
      "a",
      "b",
      "<!-- /generated:status -->",
      "after",
    );
    expect(generatedRegions(markdown)).toStrictEqual([
      { name: "status", content: "a\nb", line: 2, from: 2, to: 5 },
    ]);
  });

  it("refuses a region that is never closed, rather than swallowing the rest of the file", () => {
    expect(() => generatedRegions(document_("<!-- generated:status -->", "a"))).toThrow(
      /never closed/,
    );
  });

  it("refuses a close that does not match the region that is open", () => {
    expect(() =>
      generatedRegions(document_("<!-- generated:status -->", "<!-- /generated:install -->")),
    ).toThrow(/not open/);
  });

  it("refuses a region opened inside another, which has no meaning", () => {
    expect(() =>
      generatedRegions(document_("<!-- generated:status -->", "<!-- generated:install -->")),
    ).toThrow(/still open/);
  });
});

describe("projectionDrift", () => {
  const check = (markdown, expected) =>
    projectionDrift({
      document: "README.md",
      regions: generatedRegions(markdown),
      expected: new Map(Object.entries(expected)),
    });

  it("says nothing when the block is what the repository projects", () => {
    const markdown = document_(
      "<!-- generated:status -->",
      "",
      "one",
      "",
      "<!-- /generated:status -->",
    );
    expect(check(markdown, { status: "one" })).toStrictEqual([]);
  });

  /**
   * The failure the whole mechanism exists for: `tasks.md` moved and the block did not, or the
   * block was edited by hand. Neither is distinguishable from the other and neither is allowed.
   */
  it("reports a block that no longer matches its projection", () => {
    const markdown = document_("<!-- generated:status -->", "one", "<!-- /generated:status -->");
    expect(check(markdown, { status: "two" })).toStrictEqual([
      expect.stringContaining("is not what this repository projects"),
    ]);
  });

  it("refuses a region nothing knows how to produce", () => {
    const markdown = document_("<!-- generated:invented -->", "x", "<!-- /generated:invented -->");
    expect(check(markdown, {})).toStrictEqual([
      expect.stringContaining("not a projection this gate knows how to produce"),
    ]);
  });

  /** A projection with nowhere to land is a claim the document quietly stopped making. */
  it("reports a projection the document has no region for", () => {
    expect(check(document_("nothing here"), { status: "one" })).toStrictEqual([
      expect.stringContaining('no "<!-- generated:status -->" region'),
    ]);
  });

  it("refuses the same region twice, since two copies can say different things", () => {
    const markdown = document_(
      "<!-- generated:status -->",
      "",
      "one",
      "",
      "<!-- /generated:status -->",
      "<!-- generated:status -->",
      "",
      "one",
      "",
      "<!-- /generated:status -->",
    );
    expect(check(markdown, { status: "one" })).toStrictEqual([
      expect.stringContaining("appears twice"),
    ]);
  });
});

describe("a fence inside a generated region", () => {
  const markdown = document_(
    SECTION,
    "<!-- generated:install -->",
    block("sh", "npm install"),
    "<!-- /generated:install -->",
    block(`ts ${EXAMPLE}/src/a.ts`, "one"),
  );

  it("is marked as generated rather than read as a mirror", () => {
    const blocks = blocksInSection(markdown, SECTION);
    expect(blocks.map((b) => b.generated)).toStrictEqual([true, false]);
  });

  /**
   * Otherwise it would be reported as a block naming no source file — asking two owners to check
   * one block, and making it impossible to put a projected command in the quick start at all.
   */
  it("is not required to name a source file, because its projection checks it", () => {
    expect(
      driftBetween({
        blocks: blocksInSection(markdown, SECTION),
        shipped: new Map([["src/a.ts", "one\n"]]),
      }),
    ).toStrictEqual([]);
  });
});

describe("the framing of a generated block", () => {
  const check = (body) =>
    projectionDrift({
      document: "README.md",
      regions: generatedRegions(
        document_("<!-- generated:status -->", ...body, "<!-- /generated:status -->"),
      ),
      expected: new Map([["status", "one"]]),
    });

  it("is one blank line either side, which is what --write produces", () => {
    expect(check(["", "one", ""])).toStrictEqual([]);
    expect(framed("one")).toBe("\none\n");
  });

  /**
   * **The hole a `trim()` left.** Four spaces of indentation turns a markdown table into a code
   * block — the page renders differently and says something else — and a comparison that trimmed
   * called the two identical. The framing is part of the projection, not noise around it.
   */
  it("rejects projected content that has been indented", () => {
    expect(check(["", "    one", ""])).toStrictEqual([expect.stringContaining("byte for byte")]);
  });

  it("rejects a block run into the prose around it", () => {
    expect(check(["one"])).toStrictEqual([expect.stringContaining("byte for byte")]);
  });

  it("rejects a blank line added or a trailing space left behind", () => {
    expect(check(["", "", "one", ""])).toStrictEqual([expect.stringContaining("byte for byte")]);
    expect(check(["", "one ", ""])).toStrictEqual([expect.stringContaining("byte for byte")]);
  });
});

/**
 * **The mirror rule, per document** (T8.2 increment 1). Until this increment the rule read one
 * constant each for its document, section and mirror directory, so a package README could not be
 * claimed at all — the finding T8.2's survey made. A README is claimed whole, mirrored from its own
 * snippet directory.
 */
describe("a package README as a mirrored document", () => {
  const readme = readmeDocument("packages/maplibre");
  const checkReadme = (markdown, shipped) =>
    driftBetween({
      document: readme,
      blocks: blocksIn(markdown, readme),
      shipped: new Map(Object.entries(shipped)),
    });

  it("is mirrored from its own snippet directory, whole", () => {
    expect(readme).toStrictEqual({
      path: "packages/maplibre/README.md",
      heading: undefined,
      mirrors: "examples/readme/maplibre",
    });
  });

  /** No heading, no section: every block in the file is claimed, wherever it sits. */
  it("claims every block in the file, under any heading", () => {
    const markdown = document_(
      "# title",
      block("ts examples/readme/maplibre/a.ts", "a"),
      "## later",
      block("ts examples/readme/maplibre/b.ts", "b"),
    );
    expect(checkReadme(markdown, { "a.ts": "a\n", "b.ts": "b\n" })).toStrictEqual([]);
    expect(blocksIn(markdown, readme)).toHaveLength(2);
  });

  it("reports a block whose bytes differ from its snippet, naming the README", () => {
    const markdown = document_(block("ts examples/readme/maplibre/a.ts", "edited"));
    expect(checkReadme(markdown, { "a.ts": "a\n" })).toStrictEqual([
      expect.stringMatching(/^packages\/maplibre\/README\.md:1 — .*not the same bytes/),
    ]);
  });

  /**
   * **Falsifier: a README block naming a file outside its own package's snippet directory.** A
   * file from the quick start, or from another package's snippets, is compiled — but not as this
   * README's snippet project sees it, so it is not showable here.
   */
  it("refuses a block that mirrors another package's snippet, or the quick start", () => {
    for (const source of ["examples/readme/core/x.ts", `${EXAMPLE}/src/main.tsx`]) {
      const problems = checkReadme(document_(block(`ts ${source}`, "x")), { "a.ts": "a\n" });
      expect(problems.some((one) => one.includes(`mirrors "${source}"`))).toBe(true);
    }
  });

  it("refuses a block that names no file, in a README and not only in api.md", () => {
    expect(checkReadme(document_(block("ts", "x")), {})).toStrictEqual([
      expect.stringMatching(/names no source file/),
    ]);
  });

  /** Rule 4, per document: a compiled snippet nobody shows is dead code with a gate. */
  it("reports a snippet the README never shows", () => {
    expect(checkReadme(document_("prose only"), { "a.ts": "a\n" })).toStrictEqual([
      expect.stringMatching(/never shows "examples\/readme\/maplibre\/a\.ts"/),
    ]);
  });

  it("leaves the quick start's own rules and wording alone", () => {
    expect(check(document_(SECTION, "prose"), { "src/x.ts": "x\n" })).toStrictEqual([
      expect.stringMatching(/the quick start never shows/),
    ]);
  });
});

/**
 * **Links must survive packing** (T8.2 plan, amendment 2). A README is read from a tarball, which
 * holds `dist`, `package.json` and the README — not `specs/`. A relative link into the checkout
 * is green in every gate and dead for the reader the document serves.
 */
describe("linkProblems", () => {
  const readme = readmeDocument("packages/maplibre");
  // What npm reports it would pack, exactly — not a directory to be lexically under.
  const tarball = tarballMembers(["package.json", "README.md", "dist/index.js", "dist/index.d.ts"]);
  const links = (...lines) =>
    linkProblems({ document: readme, markdown: document_(...lines), tarball });

  it("accepts absolute URLs, fragments, and files the tarball really carries", () => {
    expect(
      links(
        "[a](https://github.com/gosha70/mapatlas/blob/main/specs/api.md#0-quick-start)",
        "[b](#install) <https://example.org/x>",
        "[c](./package.json) [d](dist/index.js) [e](README.md#top)",
        "[f][def] and [def][]",
        "",
        "[def]: https://example.org/def",
      ),
    ).toStrictEqual([]);
  });

  /** The falsifier the plan names: works in the checkout, dead in the tarball. */
  it("refuses a relative link into the checkout", () => {
    expect(links("see [the contract](../../specs/api.md) here")).toStrictEqual([
      expect.stringMatching(
        /README\.md:1 — the link "\.\.\/\.\.\/specs\/api\.md" is not an absolute URL/,
      ),
    ]);
    expect(links("[s](SECURITY.md)")).toHaveLength(1);
  });

  /**
   * **Found in review: a directory in `files` is not a tarball member.** A link into `dist/` at a
   * file that is not there is as dead as one out of the tarball, and `dist/../../specs/api.md`
   * stays lexically "under dist" while leaving it. Members are exact paths, and traversal and
   * absolute paths are refused before the set is consulted.
   */
  it("refuses a file that is not in the tarball, even under a shipped directory", () => {
    expect(links("[x](dist/definitely-not-shipped.js)")).toHaveLength(1);
  });

  it("refuses traversal and absolute paths, whatever they would resolve to", () => {
    expect(links("[x](dist/../../specs/api.md)")).toHaveLength(1);
    expect(links("[x](dist/../package.json)")).toHaveLength(1);
    expect(links("[x](/etc/passwd)")).toHaveLength(1);
  });

  /**
   * **Found in review: reference-style links bypassed the rule.** `[contract][api]` with
   * `[api]: ../../specs/api.md` is standard Markdown and was never inspected. A definition's
   * target is judged like any other link, used or not; a usage with no definition is dead too.
   */
  it("judges a reference definition's target, and a usage with no definition", () => {
    expect(links("[contract][api]", "", "[api]: ../../specs/api.md")).toStrictEqual([
      expect.stringMatching(/README\.md:3 — the link "\.\.\/\.\.\/specs\/api\.md"/),
    ]);
    expect(links("see [contract][nowhere]")).toStrictEqual([
      expect.stringMatching(/the reference link "\[nowhere\]" has no definition/),
    ]);
    expect(links("[Nowhere][]", "", "[nowhere]: https://example.org")).toStrictEqual([]);
  });

  /**
   * **Found in review, twice.** A grammar that recognised a subset of Markdown and HTML let
   * `<a href='…'>`, `<a HREF="…">` and `[x](../y 'title')` through uninspected, and refused a
   * valid `[x](<https://…>)`. Every standard form is read now — and anything link-like the
   * grammar does not read is refused rather than skipped, which is the only rule under which
   * "every link" is a claim and not a hope.
   */
  it.each([
    ["a single-quoted href", "<a href='../outside.md'>x</a>"],
    ["an upper-case HREF", '<a HREF="../outside.md">x</a>'],
    ["an unquoted href", "<a href=../outside.md>x</a>"],
    ["a single-quoted title", "[x](../outside.md 'title')"],
    ["a parenthesised title", "[x](../outside.md (title))"],
    ["an angle-bracketed relative destination", "[x](<../outside.md>)"],
    ["an angle-bracketed definition", "[x][d]", "", "[d]: <../outside.md>"],
  ])("judges %s like any other link", (_, ...lines) => {
    expect(links(...lines)).toStrictEqual([
      expect.stringMatching(/outside\.md" is not an absolute URL/),
    ]);
  });

  it.each([
    ["an angle-bracketed absolute destination", "[x](<https://example.org/x>)"],
    ["an angle-bracketed shipped file with a title", '[x](<dist/index.js> "t")'],
    ["a double-quoted href to an absolute URL", '<a href="https://example.org">x</a>'],
    ["plain brackets and parentheses in prose", "plain [brackets] and (parens) here"],
  ])("accepts %s", (_, ...lines) => {
    expect(links(...lines)).toStrictEqual([]);
  });

  /** Fail closed: what the grammar cannot read is reported, not passed. */
  it("refuses link-like syntax it cannot read, rather than skipping it", () => {
    expect(links("[x](../y 'bad\" mix)")).toStrictEqual([
      expect.stringMatching(/link-like syntax this gate cannot read/),
    ]);
    expect(links('<a name="anchor">')).toHaveLength(1);
    expect(links("<AREA href=../x>")).toHaveLength(1);
    // A `<…>` with a `:` or `@` that neither autolink grammar read: refused, not skipped.
    expect(links("<weird@>")).toHaveLength(1);
    expect(links("<x@y@z>")).toHaveLength(1);
  });

  /**
   * **Found in review: autolinks are CommonMark's, not HTTP's.** `<foo@example.com>`,
   * `<mailto:…>` and `<ftp://…>` were neither read nor refused. Any scheme is absolute; an email
   * autolink renders as `mailto:`.
   */
  it.each([
    ["an email autolink", "<foo@example.com>"],
    ["a mailto autolink", "<mailto:foo@example.com>"],
    ["an ftp autolink", "<ftp://example.com/file>"],
    ["a mailto inline destination", "[x](mailto:a@b.co)"],
  ])("accepts %s as absolute", (_, ...lines) => {
    expect(links(...lines)).toStrictEqual([]);
  });

  /**
   * **Found in review: Markdown context comes first.** Code spans and backslash escapes are
   * masked before any link form is read — `` `[x](../y)` `` is code, `\[x](../y)` is the literal
   * text `[x](../y)` — and neither is a link, dead or otherwise. What is *not* inside them is
   * still read.
   */
  it.each([
    ["a link inside a code span", "`[x](../outside.md)`"],
    ["a link inside a double-backtick span", "``[x](../outside.md) `` ``"],
    ["an escaped opening bracket", "\\[x](../outside.md)"],
    ["an escaped closing bracket", "[x\\](../outside.md)"],
    ["an escaped anchor", '\\<a href="../x">'],
    ["comparison signs", "a < b and c > d"],
  ])("does not read %s as a link", (_, ...lines) => {
    expect(links(...lines)).toStrictEqual([]);
  });

  it("still reads a real link beside a code span, and inside an unterminated one", () => {
    expect(links("`code` then [x](../outside.md)")).toHaveLength(1);
    expect(links("`unterminated [x](../outside.md)")).toHaveLength(1);
  });

  it("does not read a URL inside a code block as a link", () => {
    expect(links("```ts", 'fetch("[x](../y)")', "```")).toStrictEqual([]);
  });

  it("takes the tarball's members from what npm reports it would pack", () => {
    expect([...tarballMembers(["./package.json", "dist/a.js"])].sort()).toStrictEqual([
      "dist/a.js",
      "package.json",
    ]);
  });
});
