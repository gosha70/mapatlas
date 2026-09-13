// SPDX-License-Identifier: Apache-2.0

/**
 * Classifying and summarising a run of the flake probe (T8.1 step 2b).
 *
 * Step 2a matched two of the three environment differences locally and came back null over its
 * full 200-run budget, which bounds the rate here at 1.487% and settles nothing about the runner.
 * So the same probe runs the predeclared 100-run budget where the failure has actually been seen.
 *
 * **The budget is not an input.** Exactly `PLANNED_RUNS`, written down here, because a run count
 * chosen at dispatch time is a probabilistic bar selected after the fact — the thing T8.1's plan
 * spends its longest section refusing. Changing it means editing this file under review.
 *
 * Pure, and separate from the loop that drives it, on `isolation-rules.mjs`'s terms: a verdict
 * that can only be checked by spending an hour of CI is a verdict nobody checks.
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

/** The budget, fixed before the attempt and not selectable at dispatch. */
export const PLANNED_RUNS = 100;

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
  return output.split(/\r?\n/).some((line) => bare(line).trimEnd().endsWith(SIGNATURE))
    ? "signature"
    : "other";
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

/**
 * Why an argument is refused rather than ignored.
 *
 * The probe takes none — the budget is deliberately not selectable — and it ignored anything it
 * was given, so `npm run probe:flake -- --help` silently started an hour-long loop instead of
 * printing help. Anything on the command line is therefore a mistake about what this does, and the
 * cheapest response is to say so before spending the runner time.
 *
 * @param {string[]} args everything after the script name
 * @returns {string | undefined} why it was refused, or `undefined` to proceed
 */
export function refusedArguments(args) {
  if (args.length === 0) return undefined;
  return (
    `this probe takes no arguments, and was given ${args.map((a) => JSON.stringify(a)).join(" ")}. ` +
    `It runs the suite exactly ${String(PLANNED_RUNS)} times — a budget fixed in ` +
    `scripts/flake-probe.mjs rather than chosen at the command line — and nothing else. ` +
    `Run it with no arguments.`
  );
}

/**
 * Drive the suite `planned` times and count what happened.
 *
 * **The runner is injected**, so the one behaviour that matters most here can be tested without
 * spending an hour of CI: that the loop **keeps going after a hit**. The deliverable is a rate,
 * and a probe that stopped at its first success would report one hit over an unknown number of
 * runs — which cannot falsify a fix in either direction.
 *
 * **A run that could not be spawned is not a run.** `npm` missing, or a fork that fails outright,
 * is not a failing suite: counting it as `other` would let a machine that can run nothing at all
 * report a hundred unrelated failures. The loop stops and reports how far it got, which is the
 * path that makes a partial `completed` reachable.
 *
 * @param {{ planned: number, runSuite: (run: number) => { spawned?: boolean, reason?: string,
 *   exitCode: number, output: string }, onRun?: (event: object) => void }} options
 * @returns {{ planned: number, completed: number, signature: number, other: number,
 *   aborted: string | undefined }}
 */
export function runProbe({ planned, runSuite, onRun }) {
  let completed = 0;
  let signature = 0;
  let other = 0;
  let instrument = 0;
  let aborted;

  for (let run = 1; run <= planned; run += 1) {
    const result = runSuite(run);
    if (result.spawned === false) {
      aborted = result.reason ?? "the suite could not be started";
      break;
    }
    completed += 1;
    const kind = classifyRun(result);
    // A hit inside a truncated run still happened, and is still counted. What the truncation costs
    // is the *rate*: `instrument` keeps the result non-actionable, so the hit is recorded and no
    // fix is authorised by it.
    if (kind === "signature") signature += 1;
    else if (kind === "other" && result.truncated !== true) other += 1;
    if (result.truncated === true) instrument += 1;
    onRun?.({ run, kind, output: result.output, truncated: result.truncated === true });
  }

  return { planned, completed, signature, other, instrument, aborted };
}

/**
 * One-sided upper bound on the per-run rate, given no hits in `runs` runs.
 *
 * The same 95% bound 2a reported. It is what a null result is *entitled* to say; "we ran it a lot
 * and it was fine" is not.
 */
export function zeroHitUpperBound(runs, alpha = 0.05) {
  return 1 - Math.pow(alpha, 1 / runs);
}

/**
 * The probe's verdict.
 *
 * **Two claims are hedged, not one.** A *clean null* requires the whole budget to have been spent
 * and no unrelated failure — a probe that stopped early, or whose runs broke for another reason,
 * has not shown the signature is absent, only that it did not finish asking. And an *actionable*
 * reproduction requires the same two things: a fix has to be falsified against a rate, and a rate
 * measured over a short or contaminated budget is not one. A hit on run 3 of a probe that then
 * failed to spawn is a real observation and is reported as such — it is not a licence to start
 * fixing.
 *
 * `completed < planned` is reached when the suite could not be spawned at all and `runProbe`
 * stopped. It is **not** how a workflow timeout arrives: a killed job never reaches this function,
 * which is why the workflow's own header says a timeout prevents a verdict rather than producing
 * one.
 *
 * @param {{ planned: number, completed: number, signature: number, other: number,
 *   instrument?: number }} counts
 * @returns {{ reproduced: boolean, actionable: boolean, clean: boolean, lines: string[] }}
 */
export function verdict({ planned, completed, signature, other, instrument = 0 }) {
  const reproduced = signature > 0;
  const finished = completed === planned;
  const intact = finished && other === 0 && instrument === 0;
  const actionable = reproduced && intact;
  const clean = intact && signature === 0;

  const lines = [
    "--- T8.1 2b result ---",
    `planned runs        ${String(planned)}`,
    `runs completed      ${String(completed)}`,
    `exact signature     ${String(signature)}`,
    `other failures      ${String(other)}`,
    `instrument failures ${String(instrument)}`,
    "",
  ];

  const spoiled = [
    finished ? undefined : `only ${String(completed)} of ${String(planned)} runs completed`,
    other > 0 ? `${String(other)} run(s) failed for an unrelated reason` : undefined,
    instrument > 0
      ? `${String(instrument)} run(s) were interrupted or had their output truncated`
      : undefined,
  ].filter((one) => one !== undefined);

  if (actionable) {
    lines.push(
      `REPRODUCED: the exact signature appeared ${String(signature)} time(s) in ` +
        `${String(completed)} run(s) — an observed rate of ` +
        `${(signature / completed).toFixed(4)}.`,
      "The placement report for each hit is above. A fix may now be attempted, and must be",
      "falsified in both directions against this reproduction.",
    );
    return { reproduced, actionable, clean, lines };
  }

  if (reproduced) {
    lines.push(
      `OBSERVED BUT INCONCLUSIVE: the exact signature appeared ${String(signature)} time(s), and`,
      `that observation stands — but ${spoiled.join(", and ")}, so the rate is not measured over`,
      "a clean budget. Record the hit and its placement report; no fix follows from this run.",
    );
    return { reproduced, actionable, clean, lines };
  }

  if (spoiled.length > 0) {
    lines.push(
      `INCONCLUSIVE: ${spoiled.join(", and ")}. A probe that did not finish asking, or whose runs`,
      "did not all ask this question, has not shown the signature is absent — and no bound",
      "follows from it.",
    );
    return { reproduced, actionable, clean, lines };
  }

  lines.push(
    `NOT REPRODUCED: no exact signature in ${String(completed)} complete runs, and no unrelated`,
    "failures. One-sided 95% upper bound on the per-run rate: " +
      `${(zeroHitUpperBound(completed) * 100).toFixed(3)}%.`,
    "This is a bound, not an absence, and no fix follows from it.",
  );
  return { reproduced, actionable, clean, lines };
}
