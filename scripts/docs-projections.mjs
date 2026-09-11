// SPDX-License-Identifier: Apache-2.0

/**
 * What a generated block in the documentation says, derived from the repository (T7.2 increment 3).
 *
 * Two blocks, one reason. A getting-started page has to state things that are true *now* — which
 * packages to install, and how much of the backlog is recorded as delivered — and a sentence typed
 * once is a sentence that stops being true without anything going red. The root README is the
 * proof: it said *"Phase 0 complete; core implementation begins in Phase 1"* through seven phases
 * of work.
 *
 * So these are projections, not prose. `check:docs` compares the block byte for byte against what
 * these functions produce, and `--write` reprojects them; neither is edited by hand.
 *
 * Pure, and separate from the gate that runs them, for `docs-drift.mjs`'s reason.
 */

/** A `## Phase 4 — @mapatlas/maplibre` heading; the number and the title are both wanted. */
const PHASE = /^## Phase (\S+) — (.+)$/;

/** A task entry: `- **T4.6 Vertical acceptance fixture.** …`. */
const TASK = /^- \*\*(T[0-9]+\.[0-9a-z]*) /;

/** The completion marker this repository writes into a task's body. */
const DONE = /\*\*Done\*\*/;

/**
 * The phases of `tasks.md`, their tasks, and which of those carry a **Done** record.
 *
 * **"Carries a Done record" is not "is built", and the difference is the point.** The convention
 * began partway through the backlog, so phases finished before it record nothing — and a
 * projection that called that "0 of 8 complete" would put a fresh falsehood on the front page in
 * place of the stale one. What is mechanically knowable is what the document records, so that is
 * what is projected, and the block says so in its own words.
 *
 * @param {string} markdown the contents of `tasks.md`
 * `firstRecord` is **the first task in document order carrying a marker, and nothing more**. It
 * is tempting to read it as "where the convention started", and it cannot bear that: backfilling a
 * record onto an older task would move it, and the generated sentence would then assert a history
 * that never happened. What is derivable is where the first record *is*; the block says only that.
 *
 * @returns {{ phases: { number: string, title: string, tasks: string[], done: string[] }[],
 *   tasks: number, done: number, firstRecord: string | undefined }}
 */
export function taskStatus(markdown) {
  const phases = [];
  let phase;
  let task;

  for (const line of markdown.split("\n")) {
    const heading = PHASE.exec(line);
    if (heading !== null) {
      phase = { number: heading[1], title: heading[2], tasks: [], done: [] };
      phases.push(phase);
      task = undefined;
      continue;
    }
    // Any other `##` heading closes the phase: `tasks.md` ends with a "Global definition of done"
    // section, and reading its prose as task bodies would attribute its words to the last task.
    if (line.startsWith("## ")) {
      phase = undefined;
      task = undefined;
      continue;
    }
    if (phase === undefined) continue;

    const entry = TASK.exec(line);
    if (entry !== null) {
      task = entry[1];
      phase.tasks.push(task);
      continue;
    }
    if (task !== undefined && DONE.test(line) && !phase.done.includes(task)) {
      phase.done.push(task);
    }
  }

  const tasks = phases.reduce((total, one) => total + one.tasks.length, 0);
  const done = phases.reduce((total, one) => total + one.done.length, 0);
  const firstRecord = phases.flatMap((one) => one.done)[0];
  return { phases, tasks, done, firstRecord };
}

/**
 * The README's status block.
 *
 * **The caveat is generated too, and that is deliberate.** The table's zeros are honest only
 * beside the sentence that explains them, and a hand-written explanation of generated numbers is
 * the next thing to go stale. Both halves move together or neither does.
 *
 * **And the sentence claims only what the file shows.** It reports where the first record sits in
 * document order; it does not say a convention began there, because nothing here can know that.
 * The distinction matters for exactly the reason the zeros do: this table describes what
 * `tasks.md` records, and a reader must not be able to mistake it for what is built.
 *
 * @param {ReturnType<typeof taskStatus>} status
 * @returns {string}
 */
export function renderStatus(status) {
  const rows = status.phases.map(
    (phase) =>
      `| ${phase.number} — ${phase.title} | ${String(phase.tasks.length)} | ` +
      `${String(phase.done.length)} |`,
  );
  return [
    `[\`specs/tasks.md\`](specs/tasks.md) carries a **Done** record for ${String(status.done)} of ` +
      `its ${String(status.tasks)} tasks; the first in document order is ` +
      `${status.firstRecord ?? "none of them"}.`,
    "A zero below means *no Done record*, not *no completed work*: this table reports what that",
    "file records, and is generated from it.",
    "",
    "| Phase | Tasks | With a Done record |",
    "| --- | --- | --- |",
    ...rows,
  ].join("\n");
}

/**
 * The install step of the quick start.
 *
 * **Generated because it is a claim that can be wrong.** `@mapatlas/*` is not published: every
 * package is `0.0.0` and the registry has none of them, so `npm install @mapatlas/react` resolves
 * nothing. What does work is the tarball route — and it is not a workaround written for the
 * document, it is exactly what `check:packaging` and the browser lane do, which is why the example
 * is known to build and run against it.
 *
 * **`maplibre-gl` is absent on purpose.** It is a peer of `@mapatlas/maplibre`, pinned to one
 * exact version, and npm places it from the peer declaration. Naming it here would work and would
 * teach a reader to pin it themselves, which is the thing the peer declaration exists to avoid.
 *
 * **Two directories, and the block says which is which.** Step 1 only works inside a checkout of
 * this repository — `./packages/core` is a path relative to it — and step 2 must not run there, or
 * the tarballs are installed into the workspace that produced them rather than into the reader's
 * project. An unstated `cd` between the two is the kind of gap a reader supplies without noticing
 * and a document must not leave, so the boundary is two named variables and two explicit `cd`s.
 *
 * @param {{ packages: { name: string, version: string, directory: string }[],
 *   dependencies: Record<string, string>, into: string }} input
 * @returns {string}
 */
export function renderInstall({ packages, dependencies, into }) {
  const tarball = ({ name, version }) =>
    `${name.replace("@", "").replace("/", "-")}-${version}.tgz`;
  // Every line but the last of a command carries the continuation; assembling it here rather
  // than by hand is what keeps a changed package list from leaving a dangling backslash.
  const joined = (lines) =>
    lines.map((line, i) => `  ${line}${i === lines.length - 1 ? "" : " \\"}`);
  return [
    // Fenced by the projector rather than around it: the fence is part of what is generated, so a
    // changed package list cannot leave a block that renders as prose. `blocksInSection` knows a
    // fence inside a generated region is checked here and does not ask it to name a source file.
    "```sh",
    "# Two directories are involved. Set both before running anything below.",
    "MAPATLAS=~/src/mapatlas        # a checkout of this repository",
    "PROJECT=~/src/my-field-app     # the project you are adding the engine to",
    `TARBALLS=${into}`,
    "",
    "# 1. Build the engine's tarballs. This runs in the checkout, where ./packages/* exist.",
    'cd "$MAPATLAS"',
    "npm install && npm run build",
    'mkdir -p "$TARBALLS"',
    'npm pack --pack-destination "$TARBALLS" \\',
    // `./`-prefixed, and that is not cosmetic: `npm pack packages/core` reads the bare path as a
    // **package spec** and resolves it as the GitHub shorthand `packages/core`, failing with
    // "Repository not found". Only a path npm can see as a path packs the local folder.
    ...joined(packages.map((one) => `./${one.directory}`)),
    "",
    "# 2. Install them, beside what a consumer supplies themselves. This runs in *your* project:",
    "#    without the cd, the engine is installed back into the checkout that just built it.",
    'cd "$PROJECT"',
    "npm install \\",
    ...joined([
      ...packages.map((one) => `"$TARBALLS"/${tarball(one)}`),
      ...Object.entries(dependencies).map(([name, version]) => `${name}@${version}`),
    ]),
    "```",
  ].join("\n");
}
