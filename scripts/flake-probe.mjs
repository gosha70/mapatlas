// SPDX-License-Identifier: Apache-2.0

/**
 * What one spawned run of the suite *was* — the low-level seam, and nothing above it.
 *
 * Four things live here and no more: the signature the probe is looking for, the rule that says
 * which of the three kinds a run was, the list of what *else* failed in it, and the reading of a
 * `spawnSync` result. Every budget,
 * schedule, gate and statistic belongs to the experiment being run, and those are in
 * `flake-experiment.mjs`; this module is what both the 2b single-arm probe and 2c's two-arm
 * comparison have had in common, and duplicating it into a second runner is the one thing that
 * would put two different definitions of "the recorded failure" into the repository.
 *
 * Pure, and separate from the loop that drives it, on `isolation-rules.mjs`'s terms: a
 * classification that can only be checked by spending an hour of CI is one nobody checks.
 */

/**
 * The failure this probe is looking for, byte for byte.
 *
 * Four occurrences in issue #30 were matched to each other by exactly this text, and
 * `stitchSurface` preserves it (PR #48) precisely so that matching keeps working. A *different*
 * overlap, a gap or a different union is a second defect and is counted separately.
 *
 * **The whole line, including the gap count.** An earlier version began at "covered by none",
 * which matched `17 sample(s) covered by none and 3955 by more than one, over 46x113` — a
 * different failure, with a hole in the union that the recorded one does not have. Every number in
 * the sentence is part of the identity.
 */
export const SIGNATURE =
  "the crops do not tile their union: 0 sample(s) covered by none and 3955 by more than one, " +
  "over 46x113";

/**
 * What one run of the suite was.
 *
 * **A passing run is passing, whatever its output says.** The signature is meaningful only as a
 * failure, and this repository's own tests now assert on messages of that shape — keying purely on
 * the text would let a green run be counted as a reproduction, which is the worst error this
 * probe could make.
 *
 * **The recorded line has to *end* where it ends.** `includes` accepted `over 46x1130` as
 * `over 46x113`, so a union ten times the width would have been counted as the recorded failure.
 * The match is anchored to the end of a line instead — the diagnostics added in PR #48 begin on
 * the following line, so anchoring costs nothing and closes the prefix.
 *
 * @param {{ exitCode: number, output: string }} run
 * @returns {"passed" | "signature" | "other"}
 */
export function classifyRun({ exitCode, output }) {
  if (exitCode === 0) return "passed";
  return carriesSignature(output) ? "signature" : "other";
}

/** Whether some line of `text` ends with the recorded failure — the one definition of a match. */
export function carriesSignature(text) {
  return text.split(/\r?\n/).some((line) => bare(line).trimEnd().endsWith(SIGNATURE));
}

/** How `BuildError` labels the tiles stage, which is where `stitchSurface` runs in a real build. */
const TILES_STAGE_PREFIX = 'fixture build failed at stage "tiles": ';

/**
 * The first line of the recorded failure's **own message**, in the only two forms it has.
 *
 * **One identity, two representations — not two signatures.** The log and the structured results
 * describe the same failure and both are built on `SIGNATURE`; what differs is how much each can
 * demand. A log line arrives behind whatever the reporter printed before it (`SurfaceError: `,
 * `BuildError: `, a stack frame's indent), so `carriesSignature` can only anchor the *end* of a
 * line. A structured message arrives bare, so here the **whole first line** is known: either the
 * sentence as `stitchSurface` throws it, or that sentence behind the exact label `BuildError`
 * gives the tiles stage — which is the form a real build fails with, and the reason "equals
 * `SIGNATURE`" alone would reject every genuine hit. `flake-probe.test.mjs` derives both from the
 * real `SurfaceError` and `BuildError`, so a change to either wording fails there.
 */
export const RECORDED_FIRST_LINES = Object.freeze([SIGNATURE, `${TILES_STAGE_PREFIX}${SIGNATURE}`]);

/**
 * Whether one structured error message **is** the recorded failure.
 *
 * Stricter than `carriesSignature`, deliberately and only here. The end-anchored match is what
 * decides a *hit*, and that is unchanged; this decides whether an error is **exempt from
 * contaminating** the run, and an end-anchored match exempts too much: `rebuild failed:
 * <signature>` ends the way the recorded line ends, and so does an unrelated error that merely
 * quotes the signature on a later line. Both were accepted as clean hits and reached Fisher (shown
 * in review). The diagnostics appended after the first line are untouched by this — only the first
 * line is identity.
 *
 * @param {string} message
 */
export function isRecordedFailure(message) {
  const [firstLine] = message.split(/\r?\n/);
  return RECORDED_FIRST_LINES.includes(firstLine);
}

/**
 * Whether `results` is what `probe-results-reporter.mjs` writes, as far as this module reads it.
 *
 * @param {unknown} results
 * @returns {results is { failures: { where: string, messages: string[] }[] }}
 */
export function readableResults(results) {
  return (
    typeof results === "object" &&
    results !== null &&
    Array.isArray(results.failures) &&
    results.failures.every((one) => typeof one?.where === "string" && Array.isArray(one?.messages))
  );
}

/**
 * What failed in a run **besides** the recorded failure.
 *
 * **`classifyRun` answers one question and cannot answer two.** It says whether the recorded
 * failure is in the run, and a run in which the recorded failure *and* an unrelated test both
 * failed is — correctly — a hit. But that run did not complete the same trial as the runs beside
 * it, and counting it as a clean hit lets a contaminated arm through to the comparison: shown in
 * review with a real fixture, which tallied `signature=1, other=0` and reached Fisher. The kinds
 * are mutually exclusive; contamination is not. So this is asked separately, of the structured
 * results rather than of the text.
 *
 * **Every error is judged, not every entry.** One entry can hold several errors: Vitest attaches
 * a teardown's error to the test it ran after, so a test that throws the recorded failure and
 * whose `afterEach` then throws something else is *one* failed test with *two* messages. Clearing
 * the entry because some message in it carried the signature cleared the other error with it —
 * the same masking, one level down, and shown in review the same way: `signature=1, other=0`,
 * Fisher called. So an entry is the recorded failure only if **every** error in it is; any other
 * error in it is unrelated, and a failure with no message at all cannot be the recorded one.
 *
 * **And "is" means `isRecordedFailure`, not `carriesSignature`.** A run whose log carries the
 * signature is a hit and stays one; an error that only *carries* the line — behind an arbitrary
 * prefix, or on a later line — is not the recorded failure, and contaminates the run it is in.
 *
 * **A failing exit with nothing failed is unrelated too.** A coverage threshold, or anything else
 * that fails the command outside a test, leaves an empty list and a non-zero exit; whatever that
 * was, it was not the recorded failure.
 *
 * @param {{ exitCode: number,
 *   results: { failures: { where: string, messages: string[] }[] } }} run
 * @returns {string[]} where each unrelated failure was, empty when there is none
 */
export function unrelatedFailures({ exitCode, results }) {
  if (exitCode !== 0 && results.failures.length === 0) {
    return [
      `exit ${String(exitCode)} with no failed test, hook, module or unhandled error recorded`,
    ];
  }
  return results.failures
    .filter(
      (one) =>
        one.messages.length === 0 || !one.messages.every((message) => isRecordedFailure(message)),
    )
    .map((one) => {
      if (one.messages.some((message) => isRecordedFailure(message))) {
        return `${one.where} — another error beside the recorded failure`;
      }
      return one.messages.some((message) => carriesSignature(message))
        ? `${one.where} — carries the signature line, but is not the recorded failure`
        : one.where;
    });
}

/** Colour codes, stripped so the comparison is about the sentence rather than about vitest's ink. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const bare = (line) => line.replace(ANSI, "");

/**
 * What a `spawnSync` result means for this probe.
 *
 * **Three outcomes, not two, and `error` does not separate them.** It is set when the child never
 * launched — `npm` missing, an `ENOENT`, `pid` 0 — and *also* after a child ran and was cut off,
 * most commonly `ENOBUFS`, which carries a real `pid`, a `null` status and **the output captured up
 * to that point**. And a child killed by a signal sets **no error at all**: `status: null`,
 * `signal: "SIGTERM"`, output intact. All measured rather than assumed.
 *
 * So the question is not "was there an error" but **"did the suite exit on its own terms"**. A
 * missing exit status means it did not, however it got there.
 *
 * So a launch failure aborts the probe, and an interrupted or truncated run is kept: its output is
 * classified as usual, so a captured signature is still counted, and the run is additionally
 * marked as an **instrument failure**, which keeps the result non-actionable. A rate measured
 * partly through a broken instrument is not a rate a fix can be falsified against.
 *
 * @param {{ error?: { message: string }, pid?: number, status: number | null, stdout?: string,
 *   stderr?: string }} spawn
 * @returns {{ spawned?: boolean, truncated?: boolean, reason?: string, exitCode: number,
 *   output: string }}
 */
export function interpretSpawn(spawn) {
  const output = `${spawn.stdout ?? ""}${spawn.stderr ?? ""}`;
  const exitCode = spawn.status ?? 1;
  // A pid means a child existed. `ENOENT` reports 0, and some platforms report nothing at all.
  const started = typeof spawn.pid === "number" && spawn.pid > 0;

  if (spawn.error !== undefined && !started) {
    return { spawned: false, reason: spawn.error.message, exitCode, output };
  }

  // **No exit status is the general case, and `error` is only one way to arrive at it.** A child
  // killed by a signal reports `status: null` with `signal` set and **no error at all** — so a
  // run that printed the signature and was then terminated would otherwise have been counted as an
  // ordinary hit, and would have authorised a fix. What these have in common is that the suite did
  // not finish on its own terms, which is exactly what makes the run unusable as a rate.
  if (spawn.status === null || spawn.status === undefined || spawn.error !== undefined) {
    const reason =
      spawn.error?.message ??
      `terminated by ${typeof spawn.signal === "string" ? spawn.signal : "an unknown signal"}`;
    return { truncated: true, reason, exitCode, output };
  }

  return { exitCode, output };
}
