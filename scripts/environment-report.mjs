// SPDX-License-Identifier: Apache-2.0

/**
 * What machine is this, exactly? (T8.1 increment 2.0)
 *
 * Issue #30's failure has been seen four times, always on a GitHub runner and never here, and
 * every attempt to reproduce it has run a different Node on a different platform at a different
 * worker count. Two of those three can be matched locally — but only once they are *known*, and
 * nothing in this repository prints them: a job log records the image, the runner version and the
 * Azure region, and never `availableParallelism()`.
 *
 * So this reports the environment as facts, and is careful about which of them are measured.
 *
 * **The Vitest worker count is derived, and says so.** `resolveMaxWorkers` returns
 * `Math.max(availableParallelism() - 1, 1)` for a non-watch run
 * (`node_modules/vitest/dist/chunks/cli-api.CnMVyzaz.js:3833`), and applying that formula here is a
 * restatement of a version that can change under us — not an observation of how many workers ran.
 * It is printed beside the measurements and labelled `computed`, because a derived number
 * presented as a measured one is exactly the claim T8.1 exists to refuse.
 */

/** What a non-watch Vitest run derives its worker count from. Mirrors `resolveMaxWorkers`. */
export function computedWorkers(availableParallelism) {
  return Math.max(availableParallelism - 1, 1);
}

/**
 * The report, as lines.
 *
 * Pure, and separate from the process that gathers the facts, on the same terms as
 * `isolation-rules.mjs` — so the labelling can be tested without a runner to run it on.
 *
 * @param {{ availableParallelism: number, node: string, vitest: string, platform: string,
 *   arch: string }} facts
 * @returns {string[]}
 */
export function environmentReport(facts) {
  return [
    "environment (measured):",
    `  availableParallelism  ${String(facts.availableParallelism)}`,
    `  node                  ${facts.node}`,
    `  vitest                ${facts.vitest}`,
    `  platform              ${facts.platform}`,
    `  arch                  ${facts.arch}`,
    "",
    "environment (computed, not observed):",
    // The label is part of the line rather than a heading alone, so a copied line carries it.
    // **The whole formula, floor included.** "computed as availableParallelism - 1" is wrong on a
    // single-core runner: the line would print 1 beside a formula giving 0, and a caveat that
    // contradicts the number it explains is worse than none — it is the sort of thing a reader
    // quotes and then cannot reconcile.
    `  vitest maxWorkers     ${String(computedWorkers(facts.availableParallelism))}  ` +
      `(computed as max(availableParallelism - 1, 1); not observed from running workers)`,
  ];
}
