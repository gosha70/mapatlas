// SPDX-License-Identifier: Apache-2.0

/**
 * Prove, with real subprocesses, that the experiment's two arms run different runtimes.
 *
 * **Why this exists and why it cannot be a unit test.** T8.1 increments 2c and 2d compare default
 * Node against one other runtime mode — `--jitless`, then `--no-opt` — over the identical
 * `npm run test:coverage`, with the difference travelling as an environment marker that
 * `vitest.config.ts` turns into the workers' `execArgv`. Two designs
 * for that transport failed before this one, and **both passed every assertion over the
 * constructed environment**:
 *
 * - `NODE_OPTIONS=--jitless` — Node permits it, but it disables WebAssembly process-wide and
 *   Vite's parent throws `ReferenceError: WebAssembly is not defined` before a single test runs.
 *   Every variant run would have been an unrelated failure and every experiment contaminated.
 * - `poolOptions.forks.execArgv` — Vitest 4.1.11 discards it. The suite passed, the worker ran
 *   default Node, and the two arms were silently the same mode: a null the design would have read
 *   as "no difference".
 *
 * Neither is reachable by checking what we *build*. Only spawning the thing and reading what the
 * child actually got will do, which is what this does.
 *
 * **It is not part of `test:coverage`, deliberately.** The experiment repeats that command 120
 * times and this spawns a nested Vitest run; putting it inside would inflate every run of the
 * thing being measured. It runs in `npm run verify` instead — a standing guard on the transport,
 * outside the measured suite. The per-run certificate is written by
 * `runtime-mode.fixture.test.mjs`, which is cheap and does run inside every measured run.
 *
 * **It spawns what the runner spawns.** Both arms come through `spawnArm`, the runner's own spawn
 * path, with the environment `spawnPlan` builds for that arm — so the control here is
 * `marker=default` over the 95-file suite, as in the experiment, and not an unmarked run the
 * experiment never makes. An earlier version built its own environment and made its own
 * `spawnSync` call, and so stayed green while the runner's call delivered no environment at all.
 * The facts come back the way the runner gets them, as files, and are judged by the same
 * `judgeRun`.
 *
 * **Four things are proven, each of which has been silently false once — or, for the fourth,
 * would be silent if it were.**
 *
 * 1. *Each arm's worker was started as its arm, and the run's structured results arrive.* The
 *    worker records its **whole** startup argument list; the control's must be exactly Vitest's
 *    own, and the variant's exactly the control's followed by the arm's flags. Nothing is searched
 *    for: `--max-opt=2` and `--no-opt --opt` both get past a search.
 * 2. *The two arms collect the same files.* The marker being present in both arms does not show
 *    it: an exclusion keyed to the variant alone left both arms marked, every unit test green, and
 *    Vitest collecting 97 files for one arm and 95 for the other. So the collected sets are
 *    compared, through the real config — and the unmarked suite is required to still contain both
 *    excluded files, since an exclusion that leaked into ordinary runs would be two test files
 *    nobody runs and nobody is told about.
 * 3. *A hit does not hide what failed beside it, and nothing passes for the hit that is not it.*
 *    The fixture fails every way the tally has got wrong, at once: the recorded failure raised by
 *    production in both its forms, an unrelated test, an unrelated hook, an unrelated teardown
 *    error *on the same test* as a hit, and two errors that only *carry* the signature — behind a
 *    prefix, and on a later line. The tally has to keep the hit, leave the two genuine forms
 *    alone, name every other failure, contaminate the arm, and never reach Fisher.
 * 4. *`--no-opt` means what the plan says it means, on this Node.* The first three show a flag
 *    *delivered*. None shows what it does, and unlike `--jitless` it has no consequence a worker
 *    can see for itself. So three plain Node processes run one hot function and report the tier it
 *    reached: by default it must reach one that `--no-opt` does not, and `--no-opt` must equal
 *    `--no-turbofan` exactly. **The first half is what keeps the proof from being vacuous** — a
 *    function that never got hot reports the same tier three times, and that fails here rather
 *    than passing. It needs `--allow-natives-syntax`, which is why it is a process of its own:
 *    that flag must never be in a measured arm, and proof 1 would refuse it there.
 *
 *    **What this leaves unproven, stated:** the meaning is shown in a plain process and the
 *    delivery in a Vitest worker. What joins them is 2c, where a flag delivered the same way
 *    demonstrably took V8 effect in the worker — WebAssembly was gone.
 */

import { spawnSync } from "node:child_process";
import { relative } from "node:path";

import {
  CERTIFICATE_ENV,
  CONTROL,
  RESULTS_ENV,
  RUNTIME_MODES,
  RUNTIME_MODE_ENV,
  SELFTEST_ENV,
  SELFTEST_MIXED,
  VARIANT,
  controlBaseline,
  judgeRun,
  relativeArguments,
  runExperiment,
  verdict,
} from "./flake-experiment.mjs";
import { classifyRun, interpretSpawn } from "./flake-probe.mjs";
import { spawnArm } from "./spawn-arm.mjs";

/** The fixture alone, through the **real** `vitest.config.ts`: a bespoke config here would prove
 * that some config can carry the flag, which is not the claim. */
const FIXTURE_ALONE = { command: "npx", args: ["vitest", "run", "runtime-mode.fixture"] };
/** What Vitest would collect, without running it. */
const LIST_FILES = { command: "npx", args: ["vitest", "list", "--filesOnly", "--json"] };

/**
 * What the self-test fixture fails with **besides** its two clean hits, by a fragment of each name.
 * The clean hits are the recorded failure as production raises it, bare and from the tiles stage.
 */
const MIXED_CONTAMINATES = [
  "self-test: an unrelated test",
  "self-test: an unrelated hook",
  "the recorded failure, and then its teardown fails too",
  "an arbitrary prefix before the signature",
  "the signature on a later line",
];

/** The two files `vitest.config.ts` excludes while probing, and from no other run. */
const EXCLUDED_WHILE_PROBING = [
  "scripts/generate-service-worker.test.mjs",
  "scripts/serve-archives.test.mjs",
];

const problems = [];

/** @param {string} claim @param {boolean} held @param {string} [detail] */
function require_(claim, held, detail) {
  if (held) return;
  problems.push(detail === undefined ? claim : `${claim} — ${detail}`);
}

const outputOf = (spawn) => `${spawn.stdout ?? ""}${spawn.stderr ?? ""}`;

/**
 * The environment every spawn below starts from: this process's, **without `NODE_OPTIONS`**.
 *
 * Not a convenience. The runner refuses to start with any `NODE_OPTIONS` inherited, so no measured
 * run ever has one, and this check proves the instrument under the conditions a run has. A
 * developer whose shell exports one would otherwise see `verify` fail on a certificate that is
 * doing its job.
 */
const baseEnv = { ...process.env };
delete baseEnv.NODE_OPTIONS;

// Where the workers run, which is what their arguments' one path is relative to.
const root = process.cwd();
// As in the runner: every variant run is held against a control run's own arguments.
let baseline;

// 1. Each arm's worker is in its arm's runtime, and its structured results arrive.
for (const arm of [CONTROL, VARIANT]) {
  const started = Date.now();
  const { spawn, certificate, results } = spawnArm(arm, baseEnv, FIXTURE_ALONE);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`check:runtime-mode — ${arm}: exit ${String(spawn.status)} (${seconds}s)`);

  require_(`the ${arm} arm completes Vitest`, spawn.status === 0, `exit ${String(spawn.status)}`);
  if (certificate === undefined) {
    // Distinguished from a wrong mode: a child that wrote no certificate has told us nothing about
    // the runtime, and reporting that as "the flag did not arrive" would name the wrong failure.
    // The whole output goes to the log so the real one is readable.
    problems.push(
      `the ${arm} arm wrote no certificate, so its runtime is unknown. Output follows:\n` +
        outputOf(spawn),
    );
    continue;
  }

  const startedWith = Array.isArray(certificate.execArgv)
    ? relativeArguments(certificate.execArgv, root).join(" ")
    : "(not recorded)";
  console.log(`  worker: marker=${String(certificate.marker)} started with: ${startedWith}`);
  const judged = judgeRun({
    arm,
    interpreted: interpretSpawn(spawn),
    certificate,
    results,
    root,
    baseline,
  });
  baseline ??= controlBaseline(arm, certificate, root);
  require_(
    `the ${arm} arm has no instrument fault`,
    judged.instrumentFault === undefined,
    judged.instrumentFault,
  );
  require_(
    `nothing failed in the ${arm} arm's fixture run`,
    judged.unrelated.length === 0,
    judged.unrelated.join("; "),
  );
}

// 2. The two arms collect the same files, and an ordinary run still collects the excluded two.
/** @returns {string[] | undefined} repo-relative, sorted */
function collected(spawn) {
  try {
    return JSON.parse(spawn.stdout ?? "")
      .map((one) => relative(process.cwd(), one.file))
      .sort();
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

const unmarkedEnv = { ...baseEnv };
for (const name of [RUNTIME_MODE_ENV, CERTIFICATE_ENV, RESULTS_ENV, SELFTEST_ENV]) {
  delete unmarkedEnv[name];
}
const suites = {
  [CONTROL]: collected(spawnArm(CONTROL, baseEnv, LIST_FILES).spawn),
  [VARIANT]: collected(spawnArm(VARIANT, baseEnv, LIST_FILES).spawn),
  unmarked: collected(
    spawnSync(LIST_FILES.command, LIST_FILES.args, {
      encoding: "utf8",
      shell: false,
      env: unmarkedEnv,
    }),
  ),
};

if (Object.values(suites).some((files) => files === undefined || files.length === 0)) {
  problems.push("the collected files could not be listed, so the arms' suites were not compared");
} else {
  for (const [name, files] of Object.entries(suites)) {
    console.log(`check:runtime-mode — ${name} collects ${String(files.length)} test files`);
  }
  const onlyIn = (these, those) => these.filter((file) => !those.includes(file));
  require_(
    "both arms collect the identical test files",
    onlyIn(suites[CONTROL], suites[VARIANT]).length === 0 &&
      onlyIn(suites[VARIANT], suites[CONTROL]).length === 0,
    `only in ${CONTROL}: [${onlyIn(suites[CONTROL], suites[VARIANT]).join(", ")}]; ` +
      `only in ${VARIANT}: [${onlyIn(suites[VARIANT], suites[CONTROL]).join(", ")}]`,
  );
  require_(
    "an ordinary, unmarked run differs from an arm by exactly the two excluded files",
    JSON.stringify(onlyIn(suites.unmarked, suites[CONTROL])) ===
      JSON.stringify(EXCLUDED_WHILE_PROBING) &&
      onlyIn(suites[CONTROL], suites.unmarked).length === 0,
    `unmarked has [${onlyIn(suites.unmarked, suites[CONTROL]).join(", ")}] besides; ` +
      `the arm has [${onlyIn(suites[CONTROL], suites.unmarked).join(", ")}] besides`,
  );
}

// 3. A hit does not hide what failed beside it.
const mixedEnv = { ...baseEnv, [SELFTEST_ENV]: SELFTEST_MIXED };
const fisher = { calls: 0 };
const counts = runExperiment({
  runsPerArm: 1,
  runSuite: ({ arm }) => {
    const { spawn, certificate, results } = spawnArm(arm, mixedEnv, FIXTURE_ALONE);
    const judged = judgeRun({
      arm,
      interpreted: interpretSpawn(spawn),
      certificate,
      results,
      root,
      baseline,
    });
    console.log(
      `check:runtime-mode — mixed failure in ${arm}: exit ${String(spawn.status)}, ` +
        `${classifyRun(judged)}, also failed: [${judged.unrelated.join("; ")}]`,
    );
    require_(`the mixed run in ${arm} fails`, spawn.status === 1, `exit ${String(spawn.status)}`);
    require_(
      `the mixed run in ${arm} has no instrument fault`,
      judged.instrumentFault === undefined,
      judged.instrumentFault,
    );
    require_(`the mixed run in ${arm} is still a hit`, classifyRun(judged) === "signature");
    // Every failure in the fixture says in its own name which it must be, so the two lists below
    // cannot drift from the fixture: a `clean hit` that is named, or a `contaminates` that is not,
    // is the defect.
    for (const mustBeNamed of MIXED_CONTAMINATES) {
      require_(
        `the mixed run in ${arm} names "${mustBeNamed}" as unrelated`,
        judged.unrelated.some((where) => where.includes(mustBeNamed)),
        `named [${judged.unrelated.join("; ")}]`,
      );
    }
    require_(
      `the mixed run in ${arm} names nothing else — and above all neither clean hit`,
      judged.unrelated.length === MIXED_CONTAMINATES.length &&
        !judged.unrelated.some((where) => where.includes("clean hit")),
      `named [${judged.unrelated.join("; ")}]`,
    );
    return judged;
  },
});
const mixed = verdict({
  ...counts,
  fisher: () => {
    fisher.calls += 1;
    return 1;
  },
});
for (const arm of [CONTROL, VARIANT]) {
  const tally = counts.arms[arm];
  require_(
    `the ${arm} arm keeps the hit and counts the run as unrelated as well`,
    tally.signature === 1 && tally.other === 1 && tally.instrument === 0,
    `signature=${String(tally.signature)} other=${String(tally.other)} instrument=${String(tally.instrument)}`,
  );
}
require_(
  "a hit beside an unrelated failure contaminates the experiment, and Fisher is never called",
  mixed.outcome === "contaminated" && fisher.calls === 0,
  `outcome=${mixed.outcome} fisher calls=${String(fisher.calls)}`,
);

// 4. `--no-opt` means what the plan says it means, on this Node.
/** Enough calls, in enough separate batches, for a function this small to reach the top tier. */
const HOT_BATCHES = 20;
const CALLS_PER_BATCH = 1_000_000;
const TIER_PROBE = `
  function hot(a, b) { return (a * 31 + b) | 0; }
  let sum = 0;
  for (let batch = 0; batch < ${String(HOT_BATCHES)}; batch += 1) {
    for (let i = 0; i < ${String(CALLS_PER_BATCH)}; i += 1) sum = hot(sum, i);
  }
  console.log(%GetOptimizationStatus(hot));
`;

/** The tier bitmask one plain Node process reports for the hot function, or `undefined`. */
function tierReached(flags) {
  const spawn = spawnSync(
    process.execPath,
    ["--allow-natives-syntax", ...flags, "-e", TIER_PROBE],
    { encoding: "utf8", shell: false, env: baseEnv },
  );
  const status = Number.parseInt((spawn.stdout ?? "").trim(), 10);
  return spawn.status === 0 && Number.isInteger(status) ? status : undefined;
}

const tiers = {
  default: tierReached(RUNTIME_MODES[CONTROL]),
  "no-opt": tierReached(RUNTIME_MODES["no-opt"]),
  "no-turbofan": tierReached(["--no-turbofan"]),
};
const bits = (status) => (status === undefined ? "unreadable" : status.toString(2));
console.log(
  `check:runtime-mode — tier reached by a hot function on ${process.version}: ` +
    Object.entries(tiers)
      .map(([name, status]) => `${name} ${bits(status)}`)
      .join(", "),
);

if (Object.values(tiers).includes(undefined)) {
  problems.push(
    "the tier a hot function reaches could not be read, so what --no-opt means is unknown",
  );
} else {
  require_(
    "by default a hot function reaches a tier that --no-opt keeps it from",
    (tiers.default & ~tiers["no-opt"]) !== 0,
    `default ${bits(tiers.default)} has nothing --no-opt ${bits(tiers["no-opt"])} lacks: either ` +
      `the function never got hot enough to be optimised, and this proves nothing, or --no-opt ` +
      `does not disable the top tier on this Node`,
  );
  require_(
    "--no-opt is --no-turbofan, as `node --v8-options` says",
    tiers["no-opt"] === tiers["no-turbofan"],
    `--no-opt ${bits(tiers["no-opt"])} against --no-turbofan ${bits(tiers["no-turbofan"])}`,
  );
}

if (problems.length > 0) {
  console.error("\ncheck:runtime-mode — the experiment's instrument is not sound:\n");
  for (const problem of problems) console.error(`  ${problem}\n`);
  process.exit(1);
}

console.log(
  "\ncheck:runtime-mode — clean (each arm's worker was started as its arm, the two differing by " +
    "exactly the variant's flags, and its structured results arrive; both arms collect the " +
    "identical files and an ordinary run keeps the two excluded ones; a hit beside an unrelated " +
    "failure is kept, and contaminates; --no-opt keeps a hot function from the tier it reaches " +
    "by default, and is --no-turbofan)",
);
