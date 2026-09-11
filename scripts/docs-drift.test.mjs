// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { EXAMPLE } from "./consumer-project.mjs";
import {
  SECTION,
  blocksInSection,
  driftBetween,
  framed,
  generatedRegions,
  projectionDrift,
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
