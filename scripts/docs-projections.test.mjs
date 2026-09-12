// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { renderInstall, renderStatus, taskStatus } from "./docs-projections.mjs";

const md = (...lines) => lines.join("\n");

describe("taskStatus", () => {
  it("counts a task as recorded only when its own body carries the marker", () => {
    const status = taskStatus(
      md(
        "## Phase 4 — Renderer",
        "- **T4.1 One.** does a thing",
        "  **Done** (2026-01-01).",
        "- **T4.2 Two.** does another",
        "  still not done",
      ),
    );
    expect(status.phases).toHaveLength(1);
    expect(status.phases[0]?.tasks).toStrictEqual(["T4.1", "T4.2"]);
    expect(status.phases[0]?.done).toStrictEqual(["T4.1"]);
    expect(status.done).toBe(1);
    expect(status.tasks).toBe(2);
  });

  /**
   * `tasks.md` ends with a "Global definition of done" section. Reading its prose as the last
   * task's body would attribute its words to that task — and that section is precisely where the
   * word appears without belonging to anyone.
   */
  it("closes a phase at the next heading, so trailing prose belongs to no task", () => {
    const status = taskStatus(
      md(
        "## Phase 7 — Demo",
        "- **T7.1 Demo.** builds it",
        "## Global definition of done",
        "  **Done** means the gates pass.",
      ),
    );
    expect(status.done).toBe(0);
    expect(status.phases).toHaveLength(1);
  });

  it("counts a task once however many times its body says Done", () => {
    const status = taskStatus(
      md("## Phase 1 — Core", "- **T1.1 Types.** x", "  **Done** (a).", "  **Done** again (b)."),
    );
    expect(status.phases[0]?.done).toStrictEqual(["T1.1"]);
  });

  it("names the first task in document order that carries a record", () => {
    const status = taskStatus(
      md(
        "## Phase 4 — Renderer",
        "- **T4.1 One.** x",
        "- **T4.6 Six.** x",
        "  **Done**.",
        "## Phase 5 — React",
        "- **T5.1 Hooks.** x",
        "  **Done**.",
      ),
    );
    expect(status.firstRecord).toBe("T4.6");
  });

  /**
   * **A task outside a phase is refused rather than dropped.**
   *
   * The projection counts phases, so an entry under any other heading used to vanish from the
   * README's status block in silence — from the block whose entire purpose is to stop the front
   * page under-reporting. Plausible numbers and a disagreeing backlog is the worst of the
   * available outcomes, so the parser fails closed instead.
   */
  it("refuses a task written under a heading that is not a phase", () => {
    expect(() =>
      taskStatus(md("## Follow-ups", "- **T8.4 Something.** recorded outside a phase")),
    ).toThrow(/T8\.4 is written as a task but sits under "## Follow-ups"/);
  });

  it("names the line, so the entry can be found rather than hunted for", () => {
    expect(() =>
      taskStatus(md("# Backlog", "", "## Follow-ups", "- **T8.4 Something.** x")),
    ).toThrow(/line 4/);
  });

  /** Before any heading at all is the same failure, and says so rather than naming nothing. */
  it("refuses a task before the first heading", () => {
    expect(() => taskStatus(md("- **T0.1 Root.** x"))).toThrow(/sits under no heading/);
  });

  /** Prose under a non-phase heading is untouched: only task-shaped entries are refused. */
  it("leaves a section that contains no task entries alone", () => {
    const status = taskStatus(
      md(
        "## Phase 7 — Demo",
        "- **T7.1 Demo.** x",
        "  **Done**.",
        "## Global definition of done (every task)",
        "`build` + `typecheck` green; consequential decisions appended to `decisions.md`.",
      ),
    );
    expect(status.done).toBe(1);
    expect(status.phases).toHaveLength(1);
  });

  /**
   * **Why the rendered sentence may not say a convention *started* anywhere.** This value is
   * document order and nothing else: backfill a record onto an older task and it moves. A block
   * that had claimed the convention began at T4.6 would, after this edit, assert a history that
   * never happened — so it claims only where the first record sits.
   */
  it("moves when an older task is backfilled, which is why it dates nothing", () => {
    const backfilled = taskStatus(
      md(
        "## Phase 4 — Renderer",
        "- **T4.1 One.** x",
        "  **Done** (backfilled).",
        "- **T4.6 Six.** x",
        "  **Done**.",
      ),
    );
    expect(backfilled.firstRecord).toBe("T4.1");
  });
});

describe("renderStatus", () => {
  /**
   * The caveat is generated with the numbers it explains. A hand-written one would still say the
   * convention starts at T4.6 after someone backfilled the earlier phases — an explanation that
   * has come apart from the table beside it is worse than none.
   */
  it("states the coverage and where the first record sits, beside the table", () => {
    const rendered = renderStatus(
      taskStatus(md("## Phase 4 — Renderer", "- **T4.6 Six.** x", "  **Done**.")),
    );
    expect(rendered).toContain("record for 1 of its 1 tasks");
    expect(rendered).toContain("first in document order is T4.6");
    expect(rendered).toContain("| 4 — Renderer | 1 | 1 |");
  });

  /** Document order supports where a record is, never when a practice began. */
  it("makes no claim about when the convention started", () => {
    const rendered = renderStatus(
      taskStatus(md("## Phase 4 — Renderer", "- **T4.6 Six.** x", "  **Done**.")),
    );
    expect(rendered).not.toMatch(/convention (starts|began|began at)/i);
    expect(rendered).toContain("not *no completed work*");
  });

  it("says so rather than naming a task when nothing is recorded at all", () => {
    const rendered = renderStatus(taskStatus(md("## Phase 0 — Toolchain", "- **T0.1 Root.** x")));
    expect(rendered).toContain("none of them");
    expect(rendered).toContain("| 0 — Toolchain | 1 | 0 |");
  });
});

const INSTALL = {
  packages: [
    { name: "@mapatlas/core", version: "0.0.0", directory: "packages/core" },
    { name: "@mapatlas/react", version: "0.0.0", directory: "packages/react" },
  ],
  dependencies: { react: "19.2.8", vite: "8.2.2" },
  into: "/tmp/mapatlas",
};

describe("renderInstall", () => {
  /**
   * **A regression test for a command that was shipped wrong once.** `npm pack packages/core`
   * reads the bare path as a package spec and resolves it as the GitHub shorthand
   * `packages/core`, failing with "Repository not found". Only a path npm can see as a path packs
   * the local folder — which running the block, rather than reading it, is what caught.
   */
  it("packs local folders by a path npm cannot mistake for a package spec", () => {
    expect(renderInstall(INSTALL)).toContain("./packages/core");
    expect(renderInstall(INSTALL)).not.toMatch(/^\s+packages\/core/m);
  });

  it("names the tarball npm pack actually writes for a scoped package", () => {
    expect(renderInstall(INSTALL)).toContain('"$TARBALLS"/mapatlas-core-0.0.0.tgz');
  });

  /**
   * **Two directories, and the block must say where each command runs.** Step 1 only works inside
   * a checkout — `./packages/core` is relative to it — and step 2 must not run there, or the
   * tarballs are installed back into the workspace that produced them instead of the reader's
   * project. Running the block is what exposed the gap: the walkthrough supplied the change of
   * directory without noticing that the document never had.
   */
  it("changes directory into the checkout before packing, and out of it before installing", () => {
    const lines = renderInstall(INSTALL).split("\n");
    const at = (needle) => lines.findIndex((line) => line.includes(needle));
    expect(at('cd "$MAPATLAS"')).toBeGreaterThan(-1);
    expect(at('cd "$PROJECT"')).toBeGreaterThan(-1);
    expect(at('cd "$MAPATLAS"')).toBeLessThan(at("npm pack"));
    expect(at("npm pack")).toBeLessThan(at('cd "$PROJECT"'));
    expect(at('cd "$PROJECT"')).toBeLessThan(at("npm install \\"));
  });

  /**
   * `maplibre-gl` is a peer of `@mapatlas/maplibre` pinned to one exact version, and npm places it
   * from that declaration. Naming it in the install line would teach a reader to pin it
   * themselves, which is the thing the peer declaration exists to prevent — and the quick start
   * says so in prose, so the prose and the block have to agree.
   */
  it("never installs the renderer peer directly", () => {
    expect(renderInstall(INSTALL)).not.toContain("maplibre-gl@");
  });

  it("is a fenced block, so a changed package list cannot leave it rendering as prose", () => {
    const rendered = renderInstall(INSTALL);
    expect(rendered.startsWith("```sh\n")).toBe(true);
    expect(rendered.endsWith("\n```")).toBe(true);
  });

  /** A dangling backslash continues into nothing and swallows the next line of the reader's shell. */
  it("continues every line of a command except its last", () => {
    for (const line of renderInstall(INSTALL).split("\n")) {
      if (line.trim() === "" || !line.startsWith("  ")) continue;
      expect(line.endsWith(" \\") || line === "  vite@8.2.2" || line === "  ./packages/react").toBe(
        true,
      );
    }
    expect(renderInstall(INSTALL)).not.toContain("\\\n```");
  });
});
