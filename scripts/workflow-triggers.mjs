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
