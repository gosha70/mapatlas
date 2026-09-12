// SPDX-License-Identifier: Apache-2.0

/**
 * What actually triggers a workflow (T8.1 increment 2.0).
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
