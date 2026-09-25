// SPDX-License-Identifier: Apache-2.0

/**
 * What actually triggers a workflow, and what it then runs (T8.1 increments 2.0 and 2d).
 *
 * **Because a comment is not a guarantee.** `t8-1-flake-probe.yml` says it is manual-only and has
 * to be: a probe that also fired on push or pull request would add CI cost to every change and
 * become a source of runs nobody reads — the habit issue #30 warns about. That property was
 * "checked" once by hand, which means adding `push:` tomorrow would leave every test green.
 *
 * Line-based rather than a YAML dependency, on `docs-drift.mjs`'s terms: the question is which
 * keys sit under `on:`, and a parser is not needed to answer it. **It refuses what it does not
 * understand** instead of returning an empty list, because a trigger reader that silently found
 * nothing would make the assertion above pass on a file it could not read.
 */

/** `on:`, `"on":` or `'on':` at the start of a line, with whatever follows it. */
const ON = /^(?:on|"on"|'on'):[ \t]*(.*)$/;

/** A key nested one level under it: two spaces, a name, a colon. */
const NESTED = /^ {2}([A-Za-z_][A-Za-z0-9_-]*):/;

/**
 * The trigger names a workflow declares, in the order they appear.
 *
 * Handles the three forms GitHub accepts — a block of nested keys, a flow list (`on: [push]`) and
 * a bare scalar (`on: push`) — and throws on a file with no `on:` at all.
 *
 * @param {string} yaml
 * @returns {string[]}
 */
export function triggersOf(yaml) {
  const lines = yaml.split("\n");
  const index = lines.findIndex((line) => ON.test(line));
  if (index === -1) {
    throw new Error("this workflow declares no `on:` block, so its triggers cannot be read");
  }

  const inline = (ON.exec(lines[index])?.[1] ?? "").trim();
  if (inline !== "" && !inline.startsWith("#")) {
    // `on: [push, pull_request]` or `on: push`.
    return inline
      .replace(/^\[|\]$/g, "")
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name !== "");
  }

  const triggers = [];
  for (const line of lines.slice(index + 1)) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    // A line that is not indented has left the block: `permissions:`, `jobs:`, and so on.
    if (!line.startsWith(" ")) break;
    const nested = NESTED.exec(line);
    if (nested !== null) triggers.push(nested[1]);
  }
  return triggers;
}

/** A step's command: `run:` and what follows it on the line. */
const RUN = /^\s*(?:- )?run:[ \t]*(.*)$/;

/**
 * The commands a workflow's steps run, in order.
 *
 * **The whole list, so that order is part of what is asserted.** The probe certifies its instrument
 * on the runtime it is about to measure, and that only means something if it happens *before* the
 * loop: "the file mentions the check" would stay true with the step moved after it, or into a
 * comment.
 *
 * **It refuses a block scalar** (`run: |`) rather than reporting `|` as a command: a reader that
 * returned something for a step it could not read would let the assertion compare against noise.
 *
 * @param {string} yaml
 * @returns {string[]}
 */
export function runCommandsOf(yaml) {
  const commands = [];
  for (const line of yaml.split("\n")) {
    if (line.trimStart().startsWith("#")) continue;
    const run = RUN.exec(line);
    if (run === null) continue;
    const command = run[1].trim();
    if (command === "" || command.startsWith("|") || command.startsWith(">")) {
      throw new Error(
        "this workflow has a multi-line `run:` step, which cannot be read as one command",
      );
    }
    commands.push(command);
  }
  return commands;
}

/** A job's `timeout-minutes:`, which is the only number standing between a long job and a kill. */
const TIMEOUT = /^\s*timeout-minutes:[ \t]*(\d+)\s*$/;

/**
 * The job ceiling a workflow declares, in minutes.
 *
 * **Asserted rather than commented, because a ceiling is a correctness property of an
 * experiment, not an operational preference.** A probe job killed part-way through has an arm
 * that did not complete its budget, which the experiment's own contamination gate then reports as
 * inconclusive — so a ceiling set too low for the budget does not merely waste a run, it
 * guarantees an answerless one. Increment 2e raised the budget 2.5×, which is exactly the change
 * that makes a stale ceiling dangerous.
 *
 * **Refuses anything but a single declared ceiling**, so a workflow that grew a second job, or
 * lost the line entirely, fails here instead of being read as whichever number matched first.
 *
 * @param {string} yaml
 * @returns {number}
 */
export function timeoutOf(yaml) {
  const found = yaml
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .map((line) => TIMEOUT.exec(line))
    .filter((match) => match !== null);
  if (found.length !== 1) {
    throw new Error(`expected exactly one timeout-minutes, found ${String(found.length)}`);
  }
  return Number(found[0][1]);
}

/** A step's own keys, at the indentation `- name:`/`- uses:` sets. */
/**
 * The step keys an assertion in this repository needs.
 *
 * **`continue-on-error` is here because leaving it out made a falsifier invisible.** A mutant that
 * added `continue-on-error: true` to the probe — turning an answerless job green — survived, not
 * because the assertion was wrong but because this reader silently dropped the key it asserted on.
 * A reader that omits a key reports `undefined` for it, which is indistinguishable from absence.
 */
const STEP_KEYS = "name|uses|run|if|continue-on-error";
const STEP_START = new RegExp(`^(\\s*)- (${STEP_KEYS}):[ \\t]*(.*)$`);
const STEP_KEY = new RegExp(`^\\s*(${STEP_KEYS}):[ \\t]*(.*)$`);
const WITH_KEY = /^\s*([a-z0-9-]+):[ \t]*(.*)$/i;

/**
 * A workflow's steps in order, each with the keys an assertion needs.
 *
 * **Ordering is the property, which is why this returns a list and not a lookup.** The probe's
 * durable output is uploaded by a step that has to come *after* the probe — an upload scheduled
 * before it would archive an empty directory — and "the file contains an upload step" stays true
 * however the two are arranged. `runCommandsOf` already makes this argument for `run:` steps;
 * this extends it to steps that `uses:` an action, which have no command to read.
 *
 * **Deliberately shallow.** It reads `name`, `uses`, `run`, `if` and a flat `with:` block, which
 * is what this repository's workflows contain; anything nested inside `with:` is not represented
 * rather than half-represented. It is not a YAML parser and does not pretend to be one — the same
 * bargain the readers above make, with the same reason: a reader that returned something for
 * input it could not understand would let an assertion compare against noise.
 *
 * @param {string} yaml
 * @returns {{ name?: string, uses?: string, run?: string, if?: string, with: Record<string, string> }[]}
 */
export function stepsOf(yaml) {
  const steps = [];
  let current;
  /** Indentation of the open `with:` block, or `null` when not inside one. */
  let withIndent = null;
  for (const raw of yaml.split("\n")) {
    if (raw.trimStart().startsWith("#") || raw.trim() === "") continue;
    const indent = raw.length - raw.trimStart().length;

    // **A `with:` block ends at the first line no deeper than the `with:` itself.** Tracked by
    // indentation rather than by key name, because `with:` legitimately contains keys that are
    // also step keys — `name:` is one, and reading it as the step's name renamed the upload step
    // after its artifact and emptied its `with` block. Found by running this against the real
    // file rather than by reasoning about it.
    if (withIndent !== null && indent > withIndent) {
      const pair = WITH_KEY.exec(raw);
      if (pair !== null && current !== undefined) current.with[pair[1]] = pair[2].trim();
      continue;
    }
    withIndent = null;

    const start = STEP_START.exec(raw);
    if (start !== null) {
      current = { with: {} };
      steps.push(current);
      current[start[2]] = start[3].trim();
      continue;
    }
    if (current === undefined) continue;
    if (/^\s*with:\s*$/.test(raw)) {
      withIndent = indent;
      continue;
    }
    const key = STEP_KEY.exec(raw);
    if (key !== null) current[key[1]] = key[2].trim();
  }
  return steps;
}
