// SPDX-License-Identifier: Apache-2.0

/**
 * The two-arm runtime-mode experiment (T8.1 increments 2c, 2d and 2e).
 *
 * **What this is for.** Positional narrowing closed: the probe at `c20b417`, with ten diagnostic
 * stages inside the suspect window, returned 0 hits in 100 complete runs against ten hits at the
 * previous head, and every added stage does real work inside the interval it measures. So the
 * question changes from *where* to *whether the failure depends on one property of the runtime*.
 * 2c ran default Node against `--jitless` and the rate differed (8/60 against 0/60, p = 0.00609).
 * 2d, the pair this file is now fixed to, is the narrowest cut that still removes a whole named
 * component: default against `--no-opt`, which disables TurboFan and leaves Ignition, Sparkplug
 * and Maglev running.
 *
 * **Everything selectable is written down here and nowhere else**, because the plan's longest
 * section is about not choosing a bar after seeing the result. The budget, the design rate, the
 * rejection threshold, the test convention and the permitted conclusions are all fixed by the
 * amendments dated 2026-09-17 (2c), 2026-09-20 (2d) and 2026-09-23 (2e, approved). **2e's
 * implementation is under review and its dispatch requires separate approval**, as every dispatch
 * in this plan has. Changing any of them means editing this file under review.
 *
 * Pure. The spawning belongs to `spawn-arm.mjs` — one spawn path, shared by the runner and by the
 * check that proves it — and the classification of one run belongs to `flake-probe.mjs`: one
 * definition of the recorded failure, shared, never copied.
 */

import { classifyRun, readableResults, unrelatedFailures } from "./flake-probe.mjs";

/**
 * What each arm adds to the test workers' `execArgv` — one table, read by `vitest.config.ts`, by
 * the fixture inside the worker and by the runner that judges it, so the three cannot disagree
 * about what an arm is.
 *
 * `jitless` is the arm 2c ran. It stays so that 2c's record remains reproducible from this tree;
 * the experiment is fixed to one pair at a time, below, and the runner takes no arguments.
 */
export const RUNTIME_MODES = Object.freeze({
  default: Object.freeze([]),
  jitless: Object.freeze(["--jitless"]),
  "no-opt": Object.freeze(["--no-opt"]),
});

/** The control arm: the runtime the failure has actually been seen under. */
export const CONTROL = "default";
/**
 * The variant arm: the same command, with the marker naming a different row of the table.
 *
 * **`--no-opt`, and what that is.** Read from the binary rather than remembered — `node
 * --v8-options` on Node 24 lists `--opt (alias for --turbofan)`, with `--maglev` and `--sparkplug`
 * both enabled by default. So this arm runs with TurboFan disabled and everything beneath it
 * running. `check-runtime-mode.mjs` re-establishes that on whatever Node it is run with.
 */
export const VARIANT = "no-opt";

/** An arm's added arguments as a reader would type them, for the log and the report. */
const flagsOf = (arm) => RUNTIME_MODES[arm].join(" ");

/**
 * The marker the variant arm sets, and the only difference between the two arms.
 *
 * **Why a marker and not the flag itself.** Both arms must run the identical
 * `npm run test:coverage`, so the difference cannot be in the command. It cannot be in
 * `NODE_OPTIONS` either: there a flag reaches Vite's parent as well as the workers — `--jitless`
 * stops the parent starting at all, measured in 2c — and Node refuses `--no-opt` there outright.
 * `vitest.config.ts` reads this marker, looks the arm up in `RUNTIME_MODES`, and makes its flags
 * the workers' `execArgv`, so the parent starts normally and only the workers running the suite
 * are in the other mode.
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
 * **150 since increment 2e (option B, ruled 2026-09-23); 60 before it.** Against a true rate of
 * zero in the variant arm, the two-sided Fisher exact test at α = 0.05 rejects on **six or more**
 * hits in 150 (`p = 0.029698` at six, `0.060420` at five) — the same threshold six the 60-run
 * budget had, at a budget two and a half times the size.
 *
 * **Not the smallest budget clearing a bar, and deliberately not described as one.** The 60-run
 * budget genuinely was: it was the minimum for 80% power at a 13% design rate, and said so. 150
 * is a **fixed budget at a cost ceiling** — 300 runs, one job — whose properties are stated
 * rather than optimised for; `N = 149` gives 76.003% power at a 5% rate against 150's 76.556%, so
 * nothing turns on the last run. What 150 buys is stated in {@link POWER_RATES} and in the
 * one-sided bound a null control now prints: at this budget a control that does not reproduce is
 * a bound on the day's rate rather than the shrug increment 2d ended in.
 */
export const RUNS_PER_ARM = 150;

/**
 * The design rate: the rate measured at `025cdbe`, the last head carrying only increment 1's
 * placement report — which is the shape PR #57 restored and this experiment measures. The 10%, 2%
 * and 0% figures were all measured on builds carrying hot-path tracing that is now gone, and
 * recomputing the budget from any of them is not permitted.
 */
export const DESIGN_RATE = 0.13;

/**
 * The control rates the report states design power at — a curve, predeclared, not one number.
 *
 * **Because 13% is the assumption that failed.** Increments 2c and 2d each printed a single
 * figure, "80.876% at 13.000% in default", resting on a rate measured once at `025cdbe`; the
 * runner has since produced 10%, 2%, 10%, 0%, 13.3% and 0%. At `RUNS_PER_ARM = 150` that single
 * figure would read 99.995% — near-certainty derived from the one number this record has already
 * disproved, which is worse than the smaller claim it replaces.
 *
 * So the report states power at each of these instead: the original design rate, and the two
 * rates that bracket where the runner has actually been. Fixed here, before dispatch, so the rate
 * a result is read against cannot be chosen once the result is known.
 */
export const POWER_RATES = Object.freeze([DESIGN_RATE, 0.05, 0.03]);

/** The threshold for this one comparison. No other comparison in T8.1 is entitled to it. */
export const ALPHA = 0.05;

/**
 * What Vitest itself starts a worker with, its one path relative to the project.
 *
 * Read unfiltered from inside a worker through the real config (Vitest 4.1.11), twice, and
 * identical both times. **The control arm's arguments must be exactly these**, which is how the
 * control certifies that it carries *no* argument of its own. Held as an exact list on purpose: a
 * list of flags to look for fails **open** — `--max-opt=2` turns TurboFan off and matches nothing
 * anyone thought to list — while this fails **closed**. A Vitest upgrade that changes its own
 * arguments turns `check:runtime-mode` red, to be re-read under review rather than waved through.
 */
export const VITEST_WORKER_ARGUMENTS = Object.freeze([
  "--experimental-import-meta-resolve",
  "--require",
  "node_modules/vitest/suppress-warnings.cjs",
  "--conditions",
  "node",
  "--conditions",
  "development",
]);

/**
 * Which arm each run belongs to, alternating.
 *
 * **Alternating rather than grouped, so that time is not a second difference between the arms.**
 * Any drift over the job's duration — a runner warming, a neighbour starting — falls on both arms
 * instead of entirely on whichever ran second. It also means run *k* of one arm and run *k* of the
 * other happened side by side, so the recorded hit indices of the two arms can be read against
 * each other.
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
 * A worker's arguments with the project's own location taken out, so that the same list is the
 * same list on a laptop and on a runner. Nothing else is normalised: order and repetition are part
 * of what an argument list means — `--no-opt --opt` turns TurboFan back **on**.
 *
 * @param {string[]} execArgv
 * @param {string} root the project root the worker ran in
 */
export function relativeArguments(execArgv, root) {
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return execArgv.map((one) => (one.startsWith(prefix) ? one.slice(prefix.length) : one));
}

const sameList = (these, those) =>
  these.length === those.length && these.every((one, index) => one === those[index]);

/** How `actual` departs from `wanted`, in words: what it has besides, and what it lacks. */
function departure(actual, wanted) {
  const besides = [...actual];
  const lacking = [];
  for (const one of wanted) {
    const at = besides.indexOf(one);
    if (at === -1) lacking.push(one);
    else besides.splice(at, 1);
  }
  if (besides.length === 0 && lacking.length === 0)
    return "the same arguments in a different order";
  return [
    besides.length > 0 ? `has ${JSON.stringify(besides)} besides` : undefined,
    lacking.length > 0 ? `lacks ${JSON.stringify(lacking)}` : undefined,
  ]
    .filter((one) => one !== undefined)
    .join(" and ");
}

/**
 * Why one run's certificate does not certify the arm it was scheduled in — empty when it does.
 *
 * **Judged against the arm, never against the certificate's own marker.** A certificate that is
 * merely self-consistent — marker `default`, no flag — is exactly what a *variant* run produces
 * when its environment went astray, and the fixture inside the worker cannot tell: it has only the
 * marker to go by. The expectation therefore comes from the one party that knows what was
 * intended, which is the schedule.
 *
 * **A missing certificate is a problem, not an absence of problems.** It is what a run leaves when
 * the environment never reached the child, or the suite died before the fixture ran; either way
 * nothing is known about the runtime that run measured.
 *
 * **The whole startup argument list, held directly — not searched.** Looking for `--no-opt`, or
 * for the absence of a list of known flags, certifies the wrong runtime two ways that were both
 * measured: `--max-opt=2` disables TurboFan and matches nothing listed, and `--no-opt --opt` still
 * contains `--no-opt` with TurboFan back on. So:
 *
 * 1. the **control's** arguments are exactly `VITEST_WORKER_ARGUMENTS` — Vitest's own and nothing
 *    else, tier-changing or not;
 * 2. the **variant's** are exactly a certified control run's **followed by the arm's flags** — the
 *    two arms differ by that and by nothing else, in order. A property of the *pair*, so it is
 *    judged against a real control run, `baseline`, and not against a second copy of the list;
 * 3. the worker's `NODE_OPTIONS` is unset.
 *
 * **What this cannot see:** the startup argument list distinguishes these command-line
 * configurations and no more. A V8 flag set later from code — `v8.setFlagsFromString` — leaves
 * `execArgv` untouched. Nothing in this repository calls it.
 *
 * @param {string} arm the arm the runner scheduled this run in
 * @param {{ marker?: unknown, execArgv?: unknown, nodeOptions?: unknown, wasm?: unknown }
 *   | undefined} certificate
 * @param {{ root: string, baseline?: string[] }} against the project root, and the arguments of a
 *   control run that certified — see `controlBaseline`
 * @returns {string[]}
 */
export function certificateProblems(arm, certificate, { root, baseline }) {
  if (certificate === undefined) {
    return [`no runtime-mode certificate was written, so the ${arm} arm's runtime is unknown`];
  }
  const intended = arm;
  const expected = {
    marker: intended,
    nodeOptions: null,
    // The one consequence a worker can observe for itself: `--jitless` takes WebAssembly away.
    wasm: RUNTIME_MODES[intended].includes("--jitless") ? "undefined" : "object",
  };
  const problems = Object.keys(expected)
    .filter((fact) => certificate[fact] !== expected[fact])
    .map(
      (fact) =>
        `scheduled in the ${arm} arm, but the worker certified ${fact}=` +
        `${JSON.stringify(certificate[fact])} where ${JSON.stringify(expected[fact])} was intended`,
    );

  const { execArgv } = certificate;
  if (!Array.isArray(execArgv) || !execArgv.every((one) => typeof one === "string")) {
    return [...problems, `the ${arm} arm's worker did not record its startup arguments`];
  }
  const actual = relativeArguments(execArgv, root);
  if (intended === CONTROL) {
    if (!sameList(actual, VITEST_WORKER_ARGUMENTS)) {
      problems.push(
        `the ${arm} arm's worker was not started with exactly Vitest's own arguments: it ` +
          `${departure(actual, VITEST_WORKER_ARGUMENTS)}`,
      );
    }
  } else if (baseline === undefined) {
    problems.push(
      `no control run has certified yet, so there is nothing to hold the ${arm} arm's ` +
        `arguments against`,
    );
  } else if (!sameList(actual, [...baseline, ...RUNTIME_MODES[intended]])) {
    problems.push(
      `the ${arm} arm's worker does not differ from the control by exactly ` +
        `${JSON.stringify(RUNTIME_MODES[intended])}: against the control followed by that, it ` +
        `${departure(actual, [...baseline, ...RUNTIME_MODES[intended]])}`,
    );
  }
  return problems;
}

/**
 * The arguments every variant run is held against: a **control run's own**, once one has
 * certified. `undefined` for a variant run, and for a control run that did not certify — a
 * baseline taken from a run that was itself wrong would pass its error on to the other arm.
 *
 * @param {string} arm
 * @param {Parameters<typeof certificateProblems>[1]} certificate
 * @param {string} root
 * @returns {string[] | undefined}
 */
export function controlBaseline(arm, certificate, root) {
  if (arm !== CONTROL || certificateProblems(arm, certificate, { root }).length > 0) {
    return undefined;
  }
  return relativeArguments(certificate.execArgv, root);
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
 *   certificate: Parameters<typeof certificateProblems>[1], results: unknown, root: string,
 *   baseline?: string[] }} run
 */
export function judgeRun({ arm, interpreted, certificate, results, root, baseline }) {
  const readable = readableResults(results);
  const faults = [
    ...certificateProblems(arm, certificate, { root, baseline }),
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
 * **Three ways it can already be wrong, and each is fatal before anything is spawned.** A control
 * arm that inherits the marker is not a control — both arms would run the same mode and the
 * comparison would be between an arm and itself. The check's self-test, inherited, fails every
 * run on purpose. And **any** `NODE_OPTIONS` at all: it reaches the Vite parent *and* every worker
 * of both arms, no value of it is needed to run this experiment, and it is where a runtime can be
 * changed without touching a single argument the certificate reads. 2c's refusal searched it for
 * `--jitless` and let everything else through — `--max-opt=2` included, which disables TurboFan
 * in both arms and would have made 2d a comparison between an arm and itself. That Node itself
 * rejects `--no-opt` there covers one spelling on one Node version.
 *
 * Checked up front, because hours of runner time should not be spent on a comparison that
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
  if ((baseEnv.NODE_OPTIONS ?? "").trim() !== "") {
    return (
      `NODE_OPTIONS is set (${JSON.stringify(baseEnv.NODE_OPTIONS)}). It reaches the Vite parent ` +
      `and every worker of both arms, and can change the runtime they run in without appearing ` +
      `in any worker's arguments. An arm's flags belong to the workers, through ` +
      `${RUNTIME_MODE_ENV}, and nothing else may set one. Unset it and dispatch again.`
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
 * The runner is injected so the behaviours that matter can be checked without spending hours
 * of CI: that the loop **keeps going after a hit** — the deliverable is a pair of rates, not an
 * occurrence — and that a run which could not be spawned stops the experiment rather than being
 * counted as a failing suite.
 *
 * **Hit indices are recorded per arm**, one-based within that arm, because *where* in an arm the
 * hits fell cannot be read off a total — it is what shows drift over the job, and what any later
 * ruling on a validation budget would have to be read from.
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
 * convention produces every design figure this experiment is judged at — the rejection threshold
 * of six hits and the power curve at `POWER_RATES` — and a different one, doubling a one-sided
 * tail say, would move all of them.
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

/**
 * The design power at each predeclared rate — what the report prints in place of one figure.
 *
 * @param {{ runsPerArm?: number, alpha?: number }} [options]
 * @returns {{ rate: number, rejectAt: number, power: number }[]}
 */
export function designPowerCurve({ runsPerArm = RUNS_PER_ARM, alpha = ALPHA } = {}) {
  return POWER_RATES.map((rate) => ({ rate, ...designPower({ runsPerArm, rate, alpha }) }));
}

/**
 * The one-sided upper confidence bound on a rate that produced **no** hits in `runs`.
 *
 * `1 − α^(1/runs)`: the largest rate under which observing zero hits would still not be
 * surprising at level α. It is the number a null arm is entitled to, and increment 2e is the
 * first increment whose report prints it rather than leaving it to be computed by hand after the
 * fact — which is how 2d's 4.87% reached its result section, and is the shape of a figure chosen
 * once the result is known.
 *
 * **Narrower than `clopperPearson`'s upper limit, and not interchangeable with it.** That
 * function splits α across two tails, so at 0 hits it returns the 97.5% upper limit — 2.429% at
 * 150 runs against this function's 1.977%. Both are correct for what they are; the report says
 * which it is printing.
 *
 * **A bound on that job's rate, and nothing more.** Not a probability about the true rate, not a
 * claim that the rate is stable between jobs — the whole finding of 2d is that it is not.
 *
 * @param {number} runs
 * @param {number} [alpha]
 * @returns {number}
 */
export function oneSidedUpperBound(runs, alpha = ALPHA) {
  if (runs <= 0) throw new Error("a bound needs at least one run");
  return 1 - Math.pow(alpha, 1 / runs);
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
      statement: "inconclusive; the experiment was contaminated and no comparison was computed",
    };
  }

  if (control.signature === 0) {
    return {
      ...base,
      outcome: "control-null",
      comparison: undefined,
      statement: "inconclusive; the control did not reproduce",
    };
  }

  const p = fisher(
    control.signature,
    runsPerArm - control.signature,
    variant.signature,
    runsPerArm - variant.signature,
  );
  // The **predeclared** power — a constant of the design at `RUNS_PER_ARM` and `POWER_RATES`, not
  // a number recomputed from whatever budget happened to run. Recomputing it here would make the
  // reported power follow the data, which is the shape of a post-hoc figure.
  const curve = designPowerCurve();
  return {
    ...base,
    outcome: p <= alpha ? "differs" : "undistinguished",
    comparison: { p, alpha, designPower: curve },
    statement:
      p <= alpha
        ? `the failure rate differs between ${CONTROL} and ${flagsOf(VARIANT)} on this runner`
        : "this budget did not distinguish the two runtime modes",
  };
}

const percent = (value) => `${(value * 100).toFixed(3)}%`;

/**
 * The probe job's exit code: 0 only when the experiment answered its own question.
 *
 * **Extracted so the rule is falsifiable.** It used to be one predicate at the bottom of
 * `run-flake-probe.mjs`, where nothing could reach it without running the experiment — so a
 * change that turned an answerless job green would have gone unnoticed. Increment 2e makes that
 * change tempting: a null control now carries a finding of its own, the one-sided bound on the
 * day's control rate, and a reader who saw that might reasonably think the job had produced
 * something. **It has not produced what the job asks.** The question is whether the rate differs
 * between runtime modes; a bound on the control is an observation about the day, not an answer
 * about the variant, and a contaminated budget is not an answer either.
 *
 * @param {ReturnType<typeof verdict>} result
 * @returns {0 | 1}
 */
export function exitCode(result) {
  return result.comparison === undefined ? 1 : 0;
}

/**
 * What a difference against each variant is, and is not, entitled to mean — printed with the
 * result so the limit travels with the claim. Written before any dispatch, per variant, because
 * the two cuts license different things: `--jitless` removes every compiler, `--no-opt` one tier.
 */
const LIMITS = Object.freeze({
  jitless: [
    "This says the rate depends on the runtime mode under this experiment. It does not say",
    "optimisation is the cause, which optimisation, or that this repository's JavaScript is",
    "free of defects: --jitless changes timing, allocation behaviour and execution throughout.",
  ],
  "no-opt": [
    "That is TurboFan-enabled against TurboFan-disabled execution, and no more. It does not say",
    "optimisation caused the failure, or that TurboFan has a defect: disabling a tier changes",
    "which code runs, how long it takes to get hot, what is inlined and when garbage is",
    "collected, and any of those could expose or mask an ordinary defect in this repository's",
    "JavaScript. It narrows a variable. It does not name a mechanism.",
  ],
});

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
  const lines = [`--- T8.1 runtime-mode result: ${CONTROL} against ${VARIANT} ---`];

  for (const name of [CONTROL, VARIANT]) {
    const arm = result.arms[name];
    const label = name === VARIANT ? `${name} (${flagsOf(name)})` : name;
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
    // **What a null control is entitled to say, printed rather than left to be worked out.**
    // Only for a null control, and only because that arm is intact by construction: the
    // contamination gate runs first, so reaching `control-null` means both arms completed every
    // run with nothing else wrong. A contaminated arm has no denominator and gets no bound.
    if (result.outcome === "control-null") {
      const control = result.arms[CONTROL];
      lines.push(
        "",
        `The one-sided ${String((1 - ALPHA) * 100)}% upper bound on this job's control rate is ` +
          `${percent(oneSidedUpperBound(control.completed))} ` +
          `(0 in ${String(control.completed)}).`,
        "A bound on the rate this job ran at — not a probability about the true rate, and not a",
        "claim that the rate holds between jobs; increment 2d's finding is that it does not.",
      );
    }
    return lines;
  }

  const { p, alpha, designPower: curve } = result.comparison;
  lines.push(`Fisher exact, two-sided: p = ${p.toFixed(5)} (α = ${String(alpha)})`);
  // **A curve, not a figure.** One number would have to be quoted at one assumed control rate,
  // and that assumption is the one this plan has already had contradicted — see `POWER_RATES`.
  // `RUNS_PER_ARM`, not `result.runsPerArm`: this curve is a constant of the **predeclared
  // design**, so the budget it names must be the design's own. Reading the run's budget here
  // would print a threshold computed for 150 beside whatever number happened to run, which is
  // two different designs in one sentence. The run's own budget is on every arm's first line.
  lines.push(
    `Predeclared design power, at a true variant rate of zero (rejects at ` +
      `≥ ${String(curve[0].rejectAt)} hits in ${String(RUNS_PER_ARM)}):`,
  );
  for (const { rate, power } of curve) {
    lines.push(`  if ${CONTROL} runs at ${percent(rate).padStart(7)}   ${percent(power)}`);
  }
  lines.push(
    "",
    `${result.outcome === "differs" ? "DIFFERS" : "UNDISTINGUISHED"}: ${result.statement}.`,
  );
  if (result.outcome === "differs") lines.push(...LIMITS[VARIANT]);
  // Said rather than left to be inferred from silence: the closing line used to read `M = 51` off
  // the control's hit indices, and the owner has since ruled on it. The indices are still above.
  lines.push(
    "",
    "No statement about M follows from this experiment; see specs/plans/t8-1-fixture-flake.md.",
  );
  return lines;
}
