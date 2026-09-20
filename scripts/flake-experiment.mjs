// SPDX-License-Identifier: Apache-2.0

/**
 * The two-arm runtime-mode experiment (T8.1 increment 2c).
 *
 * **What this is for.** Positional narrowing closed: the probe at `c20b417`, with ten diagnostic
 * stages inside the suspect window, returned 0 hits in 100 complete runs against ten hits at the
 * previous head, and every added stage does real work inside the interval it measures. So the
 * question changes from *where* to *whether the failure depends on one property of the runtime*:
 * default Node against `--jitless`, with everything else held.
 *
 * **Everything selectable is written down here and nowhere else**, because the plan's longest
 * section is about not choosing a bar after seeing the result. The budget, the design rate, the
 * rejection threshold, the test convention and the permitted conclusions are all fixed by the
 * amendment dated 2026-09-17, whose design was revised on 2026-09-19; the implementation is under
 * review and dispatch requires separate approval. Changing any of them means editing this file
 * under review.
 *
 * Pure. The spawning belongs to `spawn-arm.mjs` — one spawn path, shared by the runner and by the
 * check that proves it — and the classification of one run belongs to `flake-probe.mjs`: one
 * definition of the recorded failure, shared, never copied.
 */

import { classifyRun, readableResults, unrelatedFailures } from "./flake-probe.mjs";

/** The control arm: the runtime the failure has actually been seen under. */
export const CONTROL = "default";
/** The variant arm: the same command, with one marker added to the child's environment. */
export const VARIANT = "jitless";

/**
 * The marker the variant arm sets, and the only difference between the two arms.
 *
 * **Why a marker and not the flag itself.** Both arms must run the identical
 * `npm run test:coverage`, so the difference cannot be in the command. It cannot be in
 * `NODE_OPTIONS` either: Node permits `--jitless` there, but it disables WebAssembly
 * process-wide and Vite's parent then fails to start before a single test runs — measured, not
 * assumed. `vitest.config.ts` reads this marker and turns it into the workers' `execArgv`, so the
 * parent keeps WebAssembly and only the worker running the suite is jitless.
 */
export const RUNTIME_MODE_ENV = "MAPATLAS_PROBE_RUNTIME_MODE";

/**
 * Where the worker is told to write its runtime-mode certificate, one fresh path per run.
 *
 * **Why a file, and why the runner reads it.** `runtime-mode.fixture.test.mjs` can only compare the
 * worker's own environment against the worker's own flags — so a marker that never reaches the
 * child at all leaves no marker, no flag, agreement, and a green run in default Node under either
 * arm's label. The party that knows which arm was *intended* is the runner. The measured command's
 * output carries nothing from inside a worker, so the facts travel as a file: the fixture writes
 * them here, and the runner judges them against the arm it scheduled. An environment that was never
 * delivered then produces no certificate at all — red by absence.
 */
export const CERTIFICATE_ENV = "MAPATLAS_PROBE_CERTIFICATE";

/**
 * Where the run's structured results are written: everything that failed in it, by
 * `probe-results-reporter.mjs`, which `vitest.config.ts` adds when this is set. Read by the runner
 * to find failures that coexist with a hit — see `judgeRun`.
 */
export const RESULTS_ENV = "MAPATLAS_PROBE_RESULTS";

/**
 * Makes `runtime-mode.fixture.test.mjs` fail on purpose, several ways at once, so that
 * `check-runtime-mode.mjs` can prove with a real subprocess that a hit does not hide what failed
 * beside it. Never set in a measured run, and refused if inherited.
 */
export const SELFTEST_ENV = "MAPATLAS_PROBE_SELFTEST";
/**
 * The one self-test there is: the recorded failure as production raises it, in both its forms;
 * an unrelated test; an unrelated hook; an unrelated teardown error on the same test as a hit; and
 * two errors that only carry the signature. The fixture lists them and says which must be named.
 */
export const SELFTEST_MIXED = "mixed-failure";

/**
 * The budget, per arm, fixed by the plan rather than at dispatch.
 *
 * 60 is the smallest equal-arm budget meeting an 80% power bar: against a true rate of zero in the
 * variant arm, the two-sided Fisher exact test at α = 0.05 rejects on **six or more** hits in 60,
 * which under `Binomial(60, 0.13)` has probability 80.876%. 59 gives 79.566%.
 */
export const RUNS_PER_ARM = 60;

/**
 * The design rate: the rate measured at `025cdbe`, the last head carrying only increment 1's
 * placement report — which is the shape PR #57 restored and this experiment measures. The 10%, 2%
 * and 0% figures were all measured on builds carrying hot-path tracing that is now gone, and
 * recomputing the budget from any of them is not permitted.
 */
export const DESIGN_RATE = 0.13;

/** The threshold for this one comparison. No other comparison in T8.1 is entitled to it. */
export const ALPHA = 0.05;

/**
 * The count at which a reverted-fix validation is expected to see at least one failure.
 *
 * The control arm runs 60, not 51, so reproducing *somewhere* in 60 is not the same evidence: only
 * a hit within the first 51 control runs shows that a 51-run reverted validation could have
 * falsified anything. Read off the hit indices, which is why they are recorded.
 *
 * **That makes `M` eligible to transfer, and transfers nothing.** `M` was derived from a 13% rate
 * on a suite with different membership, and a control hit does not establish that the old bound
 * applies to this one; the transfer is the owner's separate ruling, and `M` stays frozen until it.
 */
export const M_TRANSFER_RUNS = 51;

/**
 * Which arm each run belongs to, alternating.
 *
 * **Alternating rather than grouped, for two reasons.** Any drift over the job's duration — a
 * runner warming, a neighbour starting — falls on both arms instead of entirely on whichever ran
 * second. And the control arm's *run indices* carry the `M` eligibility rule, so "the first 51 control
 * runs" has to mean a stretch spread across the job rather than its first third.
 *
 * @param {number} runsPerArm
 * @returns {string[]} arm names, one per run, in execution order
 */
export function schedule(runsPerArm) {
  const runs = [];
  for (let i = 0; i < runsPerArm; i += 1) runs.push(CONTROL, VARIANT);
  return runs;
}

/**
 * The command and environment one arm is spawned with.
 *
 * **Both arms spawn identical argv.** The flag travels in the child's environment and nowhere else:
 * delivering it by substituting a different runner command would make the arms differ in more than
 * runtime mode, and the comparison would no longer be about the runtime. The base environment is
 * carried through untouched so that everything else the job sets still reaches both children.
 *
 * @param {string} arm
 * @param {Record<string, string | undefined>} baseEnv
 * @param {{ certificatePath: string, resultsPath: string }} paths where this run's worker writes
 *   its certificate, and where the run's structured results go
 * @returns {{ command: string, args: string[], env: Record<string, string | undefined> }}
 */
export function spawnPlan(arm, baseEnv, { certificatePath, resultsPath }) {
  // Set in **both** arms, not only the variant. The config keys two things off it: the worker's
  // runtime, which differs, and the exclusion of two files a worker without WebAssembly cannot
  // run, which must not — excluding them from one arm alone would add "which tests ran" as a
  // second difference to an experiment whose design is that there is exactly one.
  return {
    command: "npm",
    args: ["run", "test:coverage"],
    env: {
      ...baseEnv,
      [RUNTIME_MODE_ENV]: arm,
      [CERTIFICATE_ENV]: certificatePath,
      [RESULTS_ENV]: resultsPath,
    },
  };
}

/**
 * Why one run's certificate does not certify the arm it was scheduled in — empty when it does.
 *
 * **Judged against the arm, never against the certificate's own marker.** A certificate that is
 * merely self-consistent — marker `default`, no flag, WebAssembly present — is exactly what a
 * *variant* run produces when its environment went astray, and the fixture inside the worker
 * cannot tell: it has only the marker to go by. The expectation therefore comes from the one party
 * that knows what was intended, which is the schedule.
 *
 * **A missing certificate is a problem, not an absence of problems.** It is what a run leaves when
 * the environment never reached the child, or the suite died before the fixture ran; either way
 * nothing is known about the runtime that run measured.
 *
 * @param {string} arm the arm the runner scheduled this run in
 * @param {{ marker?: unknown, jitless?: unknown, wasm?: unknown } | undefined} certificate
 * @returns {string[]}
 */
export function certificateProblems(arm, certificate) {
  if (certificate === undefined) {
    return [`no runtime-mode certificate was written, so the ${arm} arm's runtime is unknown`];
  }
  const intended = arm;
  const expected = {
    marker: intended,
    jitless: intended === VARIANT,
    wasm: intended === VARIANT ? "undefined" : "object",
  };
  return Object.keys(expected)
    .filter((fact) => certificate[fact] !== expected[fact])
    .map(
      (fact) =>
        `scheduled in the ${arm} arm, but the worker certified ${fact}=` +
        `${JSON.stringify(certificate[fact])} where ${JSON.stringify(expected[fact])} was intended`,
    );
}

/**
 * Everything the runner knows about one run, put together: what `interpretSpawn` read, what the
 * worker certified, and what the structured results say failed.
 *
 * **Here rather than in the runner, because the runner cannot be imported** and this is where the
 * experiment was wrong. The kind of a run is one of three, so a run with the recorded failure
 * *and* an unrelated failure is a `signature` — and was tallied `other: 0`, intact, and compared.
 * The hit is kept, because it happened; what failed beside it is reported separately as
 * `unrelated`, and contaminates the arm.
 *
 * **Missing or unreadable results are an instrument fault, in a passing run as well.** Without
 * them a later hit could not be told from a mixed failure, and finding that out only at the first
 * hit would be finding it out too late; with them required of every run, results that never
 * arrive are red by absence, as the certificate is.
 *
 * @param {{ arm: string,
 *   interpreted: { exitCode: number, output: string, truncated?: boolean, reason?: string },
 *   certificate: Parameters<typeof certificateProblems>[1], results: unknown }} run
 */
export function judgeRun({ arm, interpreted, certificate, results }) {
  const readable = readableResults(results);
  const faults = [
    ...certificateProblems(arm, certificate),
    ...(readable
      ? []
      : [
          "no readable structured results were written, so what else failed in this run is unknown",
        ]),
  ];
  return {
    ...interpreted,
    unrelated: readable ? unrelatedFailures({ exitCode: interpreted.exitCode, results }) : [],
    ...(faults.length === 0 ? {} : { instrumentFault: faults.join("; ") }),
  };
}

/**
 * Why the inherited environment is refused.
 *
 * **Two ways it can already be wrong, and both are fatal before anything is spawned.** A control
 * arm that inherits the marker is not a control — both arms would run jitless and the comparison
 * would be between an arm and itself. And `--jitless` inherited through `NODE_OPTIONS` applies to
 * the Vite *parent*, which then cannot start at all: every run of both arms would be an unrelated
 * failure and the experiment would be contaminated from the first run to the last.
 *
 * Checked up front, because two hours of runner time should not be spent on a comparison that
 * cannot answer its own question.
 *
 * @param {Record<string, string | undefined>} baseEnv
 * @returns {string | undefined}
 */
export function refusedEnvironment(baseEnv) {
  if (baseEnv[RUNTIME_MODE_ENV] !== undefined) {
    return (
      `${RUNTIME_MODE_ENV} is already set to ${JSON.stringify(baseEnv[RUNTIME_MODE_ENV])}. ` +
      `The control arm must run default Node; with the marker inherited both arms would run the ` +
      `same mode and the comparison would be between an arm and itself. Unset it and dispatch again.`
    );
  }
  if (baseEnv[SELFTEST_ENV] !== undefined) {
    return (
      `${SELFTEST_ENV} is set to ${JSON.stringify(baseEnv[SELFTEST_ENV])}. It makes a fixture fail ` +
      `on purpose, for check:runtime-mode; inherited here it would fail every run of both arms. ` +
      `Unset it and dispatch again.`
    );
  }
  if ((baseEnv.NODE_OPTIONS ?? "").includes("--jitless")) {
    return (
      `NODE_OPTIONS contains --jitless (${JSON.stringify(baseEnv.NODE_OPTIONS)}). That applies to ` +
      `the Vite parent, which then starts without WebAssembly and fails before any test runs, in ` +
      `both arms. The flag belongs to the workers, through ${RUNTIME_MODE_ENV}. Unset it.`
    );
  }
  return undefined;
}

/**
 * Why an argument is refused rather than ignored.
 *
 * The experiment takes none: the budget is deliberately not selectable, for the reason the plan
 * gives at length. An earlier version of the single-arm probe ignored its arguments, so
 * `-- --help` silently started an hour-long loop instead of printing help.
 *
 * @param {string[]} args
 * @returns {string | undefined}
 */
export function refusedArguments(args) {
  if (args.length === 0) return undefined;
  return (
    `this experiment takes no arguments, and was given ${args.map((a) => JSON.stringify(a)).join(" ")}. ` +
    `It runs the suite exactly ${String(RUNS_PER_ARM)} times per arm — a budget fixed in ` +
    `scripts/flake-experiment.mjs rather than chosen at the command line — and nothing else. ` +
    `Run it with no arguments.`
  );
}

/** An empty tally for one arm. */
function emptyArm() {
  return { completed: 0, signature: 0, other: 0, instrument: 0, hitRuns: [] };
}

/**
 * Drive the schedule and count what happened, per arm.
 *
 * The runner is injected so the behaviours that matter can be checked without spending two hours
 * of CI: that the loop **keeps going after a hit** — the deliverable is a pair of rates, not an
 * occurrence — and that a run which could not be spawned stops the experiment rather than being
 * counted as a failing suite.
 *
 * **Hit indices are recorded per arm**, one-based within that arm, because the `M` eligibility rule
 * is about *where* in the control arm a hit fell and cannot be read off a total.
 *
 * @param {{ runsPerArm: number, runSuite: (job: { index: number, arm: string, armRun: number })
 *   => { spawned?: boolean, reason?: string, exitCode: number, output: string, truncated?: boolean,
 *   unrelated?: string[], instrumentFault?: string },
 *   onRun?: (event: object) => void }} options
 */
export function runExperiment({ runsPerArm, runSuite, onRun }) {
  const arms = { [CONTROL]: emptyArm(), [VARIANT]: emptyArm() };
  const order = schedule(runsPerArm);
  let aborted;

  for (const [position, arm] of order.entries()) {
    const tally = arms[arm];
    const armRun = tally.completed + 1;
    const result = runSuite({ index: position + 1, arm, armRun });
    if (result.spawned === false) {
      aborted = result.reason ?? "the suite could not be started";
      break;
    }
    tally.completed += 1;
    const kind = classifyRun(result);
    // A hit inside a truncated run still happened and is still counted. What the truncation costs
    // is the *rate*: `instrument` makes the arm contaminated, so the hit is on the record and no
    // comparison follows from it.
    if (kind === "signature") {
      tally.signature += 1;
      tally.hitRuns.push(armRun);
    }
    // **Not an `else`.** The kinds are mutually exclusive and contamination is not: a run can carry
    // the recorded failure and an unrelated one, and then it is a hit *and* it spoils its arm.
    const failedBesides = (result.unrelated?.length ?? 0) > 0;
    if (failedBesides || (kind === "other" && result.truncated !== true)) tally.other += 1;
    // A run with an instrument fault is the same kind of problem as a truncated one: whatever it
    // printed, either the runtime it measured is not known to be its arm's or what failed in it is
    // not known at all, so it cannot be counted toward that arm's rate.
    if (result.truncated === true || result.instrumentFault !== undefined) tally.instrument += 1;
    onRun?.({ ...result, arm, armRun, index: position + 1, kind });
  }

  return { runsPerArm, arms, aborted };
}

/** The regularised incomplete beta function, for exact binomial bounds. */
function logGamma(x) {
  const c = [
    76.18009172947146, -86.50532032941678, 24.01409824083091, -1.231739572450155,
    0.001208650973866179, -0.000005395239384953,
  ];
  let y = x;
  let t = x + 5.5;
  t -= (x + 0.5) * Math.log(t);
  let s = 1.000000000190015;
  for (let j = 0; j < 6; j += 1) {
    y += 1;
    s += c[j] / y;
  }
  return -t + Math.log((2.5066282746310007 * s) / x);
}

function betaContinuedFraction(a, b, x) {
  const MAX = 300;
  const EPS = 3e-16;
  const TINY = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAX; m += 1) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < EPS) break;
  }
  return h;
}

function incompleteBeta(a, b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x),
  );
  return x < (a + 1) / (a + b + 2)
    ? (front * betaContinuedFraction(a, b, x)) / a
    : 1 - (front * betaContinuedFraction(b, a, 1 - x)) / b;
}

function betaQuantile(p, a, b) {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 200; i += 1) {
    const mid = (lo + hi) / 2;
    if (incompleteBeta(a, b, mid) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * The exact two-sided Clopper–Pearson interval for `hits` in `runs`.
 *
 * Exact rather than normal-approximate because the counts here are small and the rates near the
 * edges: a Wald interval on 0/60 is `[0, 0]`, which would read as certainty where there is none.
 *
 * @param {number} hits
 * @param {number} runs
 * @param {number} [alpha]
 * @returns {{ lo: number, hi: number }}
 */
export function clopperPearson(hits, runs, alpha = ALPHA) {
  if (runs === 0) return { lo: 0, hi: 1 };
  return {
    lo: hits === 0 ? 0 : betaQuantile(alpha / 2, hits, runs - hits + 1),
    hi: hits === runs ? 1 : betaQuantile(1 - alpha / 2, hits + 1, runs - hits),
  };
}

/** The probability of one 2×2 table, hypergeometric. */
function tableProbability(a, b, c, d) {
  const n = a + b + c + d;
  const lc = (nn, kk) => logGamma(nn + 1) - logGamma(kk + 1) - logGamma(nn - kk + 1);
  return Math.exp(lc(a + b, a) + lc(c + d, c) - lc(n, a + c));
}

/**
 * Two-sided Fisher exact test, by the *sum of tables no more probable than the observed one*.
 *
 * The convention is part of the predeclaration, not an implementation detail: `p = Σ P(table)` over
 * every table with the same margins whose probability is at most the observed table's. The same
 * convention produced the design power of 80.876% at 60 per arm, and a different one — doubling a
 * one-sided tail, say — would move both the power and the threshold this experiment is judged at.
 *
 * @returns {number}
 */
export function fisherExactTwoSided(a, b, c, d) {
  const n = a + b + c + d;
  const rowOne = a + b;
  const colOne = a + c;
  const observed = tableProbability(a, b, c, d);
  let total = 0;
  for (let x = Math.max(0, colOne - (n - rowOne)); x <= Math.min(rowOne, colOne); x += 1) {
    const probability = tableProbability(x, rowOne - x, colOne - x, n - rowOne - colOne + x);
    // The `1 + 1e-9` is the usual tolerance for "no more probable": tables that are equally
    // probable in exact arithmetic can differ in the last bit after a sum of logarithms.
    if (probability <= observed * (1 + 1e-9)) total += probability;
  }
  return Math.min(1, total);
}

/**
 * The design power: the probability this budget rejects, if the variant arm's true rate is zero.
 *
 * Computed rather than quoted, so the number in the plan is checkable here and a change to the
 * budget or the convention cannot silently leave the recorded power behind.
 *
 * @param {{ runsPerArm?: number, rate?: number, alpha?: number }} [options]
 * @returns {{ rejectAt: number, power: number }}
 */
export function designPower({ runsPerArm = RUNS_PER_ARM, rate = DESIGN_RATE, alpha = ALPHA } = {}) {
  let rejectAt = runsPerArm + 1;
  for (let hits = 0; hits <= runsPerArm; hits += 1) {
    if (fisherExactTwoSided(hits, runsPerArm - hits, 0, runsPerArm) <= alpha) {
      rejectAt = hits;
      break;
    }
  }
  let power = 0;
  const lc = (nn, kk) => logGamma(nn + 1) - logGamma(kk + 1) - logGamma(nn - kk + 1);
  for (let hits = rejectAt; hits <= runsPerArm; hits += 1) {
    power += Math.exp(
      lc(runsPerArm, hits) + hits * Math.log(rate) + (runsPerArm - hits) * Math.log(1 - rate),
    );
  }
  return { rejectAt, power };
}

/** Whether an arm asked the same question `runsPerArm` times and nothing else happened to it. */
function intact(arm, runsPerArm) {
  return arm.completed === runsPerArm && arm.other === 0 && arm.instrument === 0;
}

/** Why an arm is not intact, in words a reader can act on. */
function spoiledBy(arm, runsPerArm) {
  return [
    arm.completed === runsPerArm
      ? undefined
      : `only ${String(arm.completed)} of ${String(runsPerArm)} runs completed`,
    arm.other > 0
      ? `${String(arm.other)} run(s) had an unrelated failure, alone or beside a hit`
      : undefined,
    arm.instrument > 0
      ? `${String(arm.instrument)} run(s) were interrupted, had their output truncated, or left ` +
        `no valid runtime-mode certificate or structured results`
      : undefined,
  ].filter((one) => one !== undefined);
}

/**
 * The experiment's verdict, and the only place the gates live.
 *
 * **Three gates, in this order, and each forbids the next.**
 *
 * 1. *Contamination.* An unrelated failure or an instrument fault in **either** arm makes the whole
 *    experiment inconclusive — not "inconclusive in that arm", which would leave room to compare a
 *    filtered or unequal pair of samples.
 * 2. *A null control.* If the control arm shows no hits, nothing is said about the variant however
 *    it came out. The tempting reading of a double null — "the flag fixed it" — is exactly the one
 *    this refuses.
 * 3. Only past both is the comparison computed at all.
 *
 * **`fisher` is injected so that "not computed" is testable.** A p-value *is* the comparison the
 * first two gates forbid; producing one and then declining to print it would be making that
 * comparison and censoring the output. A test passes a spy and asserts it was never called.
 *
 * @param {{ runsPerArm: number, arms: Record<string, object>, aborted?: string,
 *   fisher?: typeof fisherExactTwoSided, alpha?: number }} input
 */
export function verdict({
  runsPerArm,
  arms,
  aborted,
  fisher = fisherExactTwoSided,
  alpha = ALPHA,
}) {
  const control = arms[CONTROL];
  const variant = arms[VARIANT];
  const contaminated = [CONTROL, VARIANT].filter((name) => !intact(arms[name], runsPerArm));

  const base = {
    runsPerArm,
    arms,
    aborted,
    contaminated,
    intact: Object.fromEntries(
      [CONTROL, VARIANT].map((name) => [name, intact(arms[name], runsPerArm)]),
    ),
  };

  if (contaminated.length > 0) {
    return {
      ...base,
      outcome: "contaminated",
      comparison: undefined,
      eligibleForM: false,
      statement: "inconclusive; the experiment was contaminated and no comparison was computed",
    };
  }

  if (control.signature === 0) {
    return {
      ...base,
      outcome: "control-null",
      comparison: undefined,
      eligibleForM: false,
      statement: "inconclusive; the control did not reproduce",
    };
  }

  const p = fisher(
    control.signature,
    runsPerArm - control.signature,
    variant.signature,
    runsPerArm - variant.signature,
  );
  // The **predeclared** power — a constant of the design at `RUNS_PER_ARM` and `DESIGN_RATE`, not
  // a number recomputed from whatever budget happened to run. Recomputing it here would make the
  // reported power follow the data, which is the shape of a post-hoc figure.
  const { power } = designPower();
  return {
    ...base,
    outcome: p <= alpha ? "differs" : "undistinguished",
    comparison: { p, alpha, designPower: power },
    eligibleForM: control.hitRuns.some((run) => run <= M_TRANSFER_RUNS),
    statement:
      p <= alpha
        ? `the failure rate differs between ${CONTROL} and --jitless on this runner`
        : "this budget did not distinguish the two runtime modes",
  };
}

const percent = (value) => `${(value * 100).toFixed(3)}%`;

/**
 * The report, in three tiers, so that no field can be chosen after seeing the result.
 *
 * - **Raw counts, always**, for every arm, whatever happened. They are observations.
 * - **Rate and interval, only for an intact arm.** A contaminated arm has no valid denominator: an
 *   instrument failure can truncate output, so an apparent non-hit there may be an unobserved hit,
 *   and an unrelated failure means that run did not complete the same trial as the runs beside it.
 *   A rate over such a set is an inference the data does not support, and withholding the
 *   comparison does not make the arm's own rate sound.
 * - **Fisher and the predeclared design power, only when both arms are intact and the control
 *   reproduced.** Never a post-hoc "achieved power": computed from the observed rates, it adds
 *   nothing to the counts and the p-value it is derived from.
 *
 * @param {ReturnType<typeof verdict>} result
 * @returns {string[]}
 */
export function report(result) {
  const lines = ["--- T8.1 2c result ---"];

  for (const name of [CONTROL, VARIANT]) {
    const arm = result.arms[name];
    const label = name === VARIANT ? `${name} (--jitless)` : name;
    lines.push(
      `${label}:`,
      `  runs completed      ${String(arm.completed)} of ${String(result.runsPerArm)}`,
      `  exact signature     ${String(arm.signature)}`,
      `  other failures      ${String(arm.other)}`,
      `  instrument failures ${String(arm.instrument)}`,
    );
    if (arm.hitRuns.length > 0) {
      lines.push(`  hits at arm run(s)  ${arm.hitRuns.join(", ")}`);
    }
    if (result.intact[name]) {
      const { lo, hi } = clopperPearson(arm.signature, arm.completed);
      lines.push(
        `  rate                ${percent(arm.signature / arm.completed)} ` +
          `(exact 95% CI ${percent(lo)}–${percent(hi)})`,
      );
    } else {
      lines.push(
        `  rate                not reported — ${spoiledBy(arm, result.runsPerArm).join(", and ")};`,
        `                      a contaminated arm has no denominator a rate can be read from`,
      );
    }
    lines.push("");
  }

  if (result.aborted !== undefined) {
    lines.push(`stopped early: ${result.aborted}`, "");
  }

  if (result.comparison === undefined) {
    lines.push(
      `INCONCLUSIVE: ${result.statement}.`,
      "No Fisher test was computed — a p-value is itself the comparison this outcome forbids,",
      "so there is no number being withheld.",
    );
    return lines;
  }

  const { p, alpha, designPower: power } = result.comparison;
  lines.push(
    `Fisher exact, two-sided: p = ${p.toFixed(5)} (α = ${String(alpha)})`,
    `Predeclared design power: ${percent(power)} at ${percent(DESIGN_RATE)} in ${CONTROL}`,
    "",
    `${result.outcome === "differs" ? "DIFFERS" : "UNDISTINGUISHED"}: ${result.statement}.`,
  );
  if (result.outcome === "differs") {
    lines.push(
      "This says the rate depends on the runtime mode under this experiment. It does not say",
      "optimisation is the cause, which optimisation, or that this repository's JavaScript is",
      "free of defects: --jitless changes timing, allocation behaviour and execution throughout.",
    );
  }
  lines.push(
    "",
    result.eligibleForM
      ? `M = 51 is ELIGIBLE to transfer, and is not transferred: the control reproduced within its ` +
          `first ${String(M_TRANSFER_RUNS)} runs, on a suite whose membership differs from the one ` +
          `M was derived on. The transfer needs the owner's separate ruling.`
      : `M = 51 does NOT transfer: no control hit fell within the first ${String(M_TRANSFER_RUNS)} ` +
          `runs of that arm, so a 51-run reverted validation was not shown able to falsify anything.`,
  );
  return lines;
}
