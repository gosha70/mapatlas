// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";

import {
  ALPHA,
  CERTIFICATE_ENV,
  CONTROL,
  DESIGN_RATE,
  RESULTS_ENV,
  RUNTIME_MODE_ENV,
  SELFTEST_ENV,
  SELFTEST_MIXED,
  RUNS_PER_ARM,
  RUNTIME_MODES,
  VARIANT,
  VITEST_WORKER_ARGUMENTS,
  certificateProblems,
  clopperPearson,
  controlBaseline,
  designPower,
  designPowerCurve,
  exitCode,
  oneSidedUpperBound,
  fisherExactTwoSided,
  judgeRun,
  refusedArguments,
  refusedEnvironment,
  relativeArguments,
  report,
  runExperiment,
  schedule,
  spawnPlan,
  verdict,
} from "./flake-experiment.mjs";
import { SIGNATURE, interpretSpawn } from "./flake-probe.mjs";

/** A finished run of the given kind, in the shape `interpretSpawn` returns. */
const passed = () => ({ exitCode: 0, output: "ok" });
const hit = () => ({ exitCode: 1, output: `x\n${SIGNATURE}\n` });
const unrelated = () => ({ exitCode: 1, output: "something else failed" });
const truncated = () => ({ exitCode: 1, output: "", truncated: true, reason: "SIGTERM" });

/** An arm tally, written out so a test can state exactly the shape it is judging. */
const arm = ({ completed = 4, signature = 0, other = 0, instrument = 0, hitRuns = [] }) => ({
  completed,
  signature,
  other,
  instrument,
  hitRuns,
});

const arms = (control, variant) => ({ [CONTROL]: control, [VARIANT]: variant });

/** Where the pretended workers ran. */
const ROOT = "/repo";
/** What Vitest starts a worker with, as a worker under `ROOT` records it: one path, absolute. */
const vitestsOwn = () =>
  VITEST_WORKER_ARGUMENTS.map((one) => (one.startsWith("node_modules/") ? `${ROOT}/${one}` : one));
/** The certificate a correctly started worker of `which` arm writes, plus any `extra` arguments. */
const certificateOf = (which, extra = []) => ({
  marker: which,
  execArgv: [...vitestsOwn(), ...RUNTIME_MODES[which], ...extra],
  nodeOptions: null,
  wasm: RUNTIME_MODES[which].includes("--jitless") ? "undefined" : "object",
});
/** A control run's own arguments, as the runner keeps them once one has certified. */
const BASELINE = [...VITEST_WORKER_ARGUMENTS];
const against = { root: ROOT, baseline: BASELINE };
/** `record` with one fact left out — what a certificate that never recorded it looks like. */
const without = (record, fact) =>
  Object.fromEntries(Object.entries(record).filter(([name]) => name !== fact));

/** Where one run is told to write, as `spawn-arm.mjs` hands it to `spawnPlan`. */
const pathsOne = {
  certificatePath: "/tmp/one/certificate.json",
  resultsPath: "/tmp/one/results.json",
};
const pathsTwo = {
  certificatePath: "/tmp/two/certificate.json",
  resultsPath: "/tmp/two/results.json",
};

describe("the budget and the design it was chosen for", () => {
  /**
   * **The numbers in the plan, recomputed here.** The budget is the one thing the plan forbids
   * choosing after the fact, so quoting it in prose and hard-coding it in source without a check
   * would let the two drift apart. Increment 2e's amendment states every figure below.
   *
   * **And a claim this deliberately does *not* make.** Until 2e the budget was 60, which genuinely
   * was the smallest equal-arm budget clearing 80% power at the design rate, and this test
   * asserted that minimality. 150 is not minimal for any bar — `N = 149` clears 76.003% against
   * 150's 76.556% — it is a fixed budget at a cost ceiling whose properties are then stated. A
   * test asserting minimality here would be checking a sentence that is no longer true.
   */
  it("is the fixed budget increment 2e predeclared, with the properties the plan states", () => {
    expect(RUNS_PER_ARM).toBe(150);
    expect(DESIGN_RATE).toBe(0.13);

    const at150 = designPower({ runsPerArm: 150 });
    expect(at150.rejectAt).toBe(6);
    expect(at150.power * 100).toBeCloseTo(99.995, 3);

    // The curve the report prints, rate by rate, against a zero-rate variant arm.
    expect(designPowerCurve()).toEqual([
      { rate: 0.13, rejectAt: 6, power: expect.closeTo(0.99995233, 8) },
      { rate: 0.05, rejectAt: 6, power: expect.closeTo(0.7655645, 7) },
      { rate: 0.03, rejectAt: 6, power: expect.closeTo(0.29574429, 8) },
    ]);

    // The amendment's table also quotes 2c's own lower bound, which is not a printed rate but is
    // a stated figure — so it is asserted too, and the claim that every figure in that table is
    // checked here stays true.
    expect(designPower({ runsPerArm: 150, rate: 0.05936 }).power).toBeCloseTo(0.88580995805, 10);

    // Nothing turns on the last run: the budget is a ceiling, not a minimum.
    expect(designPower({ runsPerArm: 149, rate: 0.05 }).power * 100).toBeCloseTo(76.003, 3);
  });

  /**
   * **What a null control is entitled to say.** Increment 2d's null control said nothing but
   * "inconclusive", and the 4.87% bound its result section quotes was computed by hand after the
   * fact — a figure produced once the result was known. 2e prints it, so the finding does not
   * depend on someone remembering to do the arithmetic.
   *
   * Checked against exact arithmetic and against the two-tailed interval it must not be confused
   * with: `clopperPearson` splits α across both tails, so at zero hits it returns the 97.5% upper
   * limit, which is the larger and weaker number.
   */
  it("bounds a null arm one-sidedly, and not with the two-tailed interval", () => {
    // 1 − 0.05^(1/150), independently: 0.019773438…
    expect(oneSidedUpperBound(150) * 100).toBeCloseTo(1.977, 3);
    expect(oneSidedUpperBound(60) * 100).toBeCloseTo(4.87, 2);

    // Strictly tighter than the two-sided upper limit at the same α, at the same budget.
    expect(oneSidedUpperBound(150)).toBeLessThan(clopperPearson(0, 150).hi);
    expect(clopperPearson(0, 150).hi * 100).toBeCloseTo(2.429, 3);

    // A bound needs a denominator.
    expect(() => oneSidedUpperBound(0)).toThrow(/at least one run/);
  });

  it("refuses an argument rather than starting a two-hour loop on a typo", () => {
    expect(refusedArguments([])).toBeUndefined();
    expect(refusedArguments(["--help"])).toMatch(/takes no arguments/);
    expect(refusedArguments(["--runs=10"])).toMatch(/fixed in\s+scripts\/flake-experiment\.mjs/);
  });
});

describe("the exact statistics, against values computed independently", () => {
  /**
   * **Checked against exact arithmetic, not against itself.** The expectations below were computed
   * independently in BigInt rationals — binomial coefficients as exact integers, the tail as a
   * ratio of two of them — so they are ground truth for this convention rather than a transcript
   * of what the implementation happens to return. The convention is part of the predeclaration: a
   * different one, doubling a one-sided tail say, would move both the threshold and the design
   * power this experiment is judged at.
   */
  it("computes the two-sided Fisher exact test by summing no-more-probable tables", () => {
    // 13/100 against 2/100, and 10/100 against 0/100: both recorded on issue #30.
    expect(fisherExactTwoSided(13, 87, 2, 98)).toBeCloseTo(0.005450554847689658, 12);
    expect(fisherExactTwoSided(10, 90, 0, 100)).toBeCloseTo(0.0015420521254357006, 12);
    // Identical arms cannot be distinguished from each other.
    expect(fisherExactTwoSided(6, 54, 6, 54)).toBe(1);
  });

  it("brackets the rejection threshold at the budget it was sized for", () => {
    // **Increment 2e's budget**, which is what `RUNS_PER_ARM` is now: six hits reject, five do
    // not. The 60-per-arm pair below is 2d's and is kept as history — the two budgets happen to
    // share the threshold six, and a test that only checked 60 would have gone on passing while
    // describing a boundary this experiment no longer runs at.
    expect(fisherExactTwoSided(6, 144, 0, 150)).toBeCloseTo(0.02969809196780457, 12);
    expect(fisherExactTwoSided(5, 145, 0, 150)).toBeCloseTo(0.060420256072429984, 12);
    expect(fisherExactTwoSided(6, 144, 0, 150)).toBeLessThanOrEqual(ALPHA);
    expect(fisherExactTwoSided(5, 145, 0, 150)).toBeGreaterThan(ALPHA);

    // 2c's and 2d's budget, retained so their recorded p-values stay checkable here.
    expect(fisherExactTwoSided(6, 54, 0, 60)).toBeCloseTo(0.027411633549740966, 12);
    expect(fisherExactTwoSided(5, 55, 0, 60)).toBeCloseTo(0.05731523378582202, 12);
    expect(fisherExactTwoSided(6, 54, 0, 60)).toBeLessThanOrEqual(ALPHA);
    expect(fisherExactTwoSided(5, 55, 0, 60)).toBeGreaterThan(ALPHA);
  });

  /** Exact, because a Wald interval on 0/60 is `[0, 0]` — certainty where there is none. */
  it("gives an exact interval that does not collapse at zero hits", () => {
    const none = clopperPearson(0, 60);
    expect(none.lo).toBe(0);
    expect(none.hi * 100).toBeCloseTo(5.96, 1);

    const some = clopperPearson(13, 100);
    expect(some.lo * 100).toBeCloseTo(7.107, 2);
    expect(some.hi * 100).toBeCloseTo(21.204, 2);
  });
});

describe("the arms differ in the runtime mode and in nothing else", () => {
  /**
   * **Half of the falsifier for "both labelled arms actually run default Node".** Only half:
   * this checks what is *constructed*, and two transports have already passed a check of that
   * shape while the worker ran the wrong runtime — `NODE_OPTIONS=--jitless`, which stops Vite
   * starting at all, and `poolOptions.forks.execArgv`, which Vitest 4.1.11 discards. The other
   * half is `check-runtime-mode.mjs`, which spawns both arms through the runner's own spawn path
   * and reads what the worker certified, and `runtime-mode.fixture.test.mjs`, which writes that
   * certificate inside every measured run for the runner to judge against the arm it scheduled.
   */
  it("marks the variant's environment and leaves everything else alone", () => {
    const base = { PATH: "/usr/bin", CI: "true", NODE_OPTIONS: "--max-old-space-size=4096" };

    const control = spawnPlan(CONTROL, base, pathsOne);
    const variant = spawnPlan(VARIANT, base, pathsTwo);

    // Each child is told where to certify its runtime, or the runner would have nothing to judge.
    expect(control.env[CERTIFICATE_ENV]).toBe(pathsOne.certificatePath);
    expect(variant.env[CERTIFICATE_ENV]).toBe(pathsTwo.certificatePath);
    // And where to write down what failed, or a hit could hide what failed beside it.
    expect(control.env[RESULTS_ENV]).toBe(pathsOne.resultsPath);
    expect(variant.env[RESULTS_ENV]).toBe(pathsTwo.resultsPath);
    // Marked in both arms, with different values: the config keys the worker's runtime off the
    // value, and the exclusion of two files that need WebAssembly off the marker being present —
    // so both arms must carry it or they would run different suites.
    expect(control.env[RUNTIME_MODE_ENV]).toBe(CONTROL);
    expect(variant.env[RUNTIME_MODE_ENV]).toBe(VARIANT);
    // The flag never goes near NODE_OPTIONS: there it would apply to the Vite parent, which then
    // starts without WebAssembly and fails before any test runs.
    expect(variant.env.NODE_OPTIONS).toBe("--max-old-space-size=4096");
    for (const key of Object.keys(base)) {
      expect(control.env[key]).toBe(base[key]);
      expect(variant.env[key]).toBe(base[key]);
    }
  });

  /**
   * **Falsifier: the flag delivered by changing the command.** Substituting a different runner
   * command would make the arms differ in more than runtime mode, and the comparison would no
   * longer be about the runtime. Asserted as whole-argv identity, not as a prefix.
   */
  it("spawns byte-identical argv in both arms", () => {
    const control = spawnPlan(CONTROL, {}, pathsOne);
    const variant = spawnPlan(VARIANT, {}, pathsTwo);

    expect(control.command).toBe("npm");
    expect(control.args).toStrictEqual(["run", "test:coverage"]);
    expect(variant.command).toBe(control.command);
    expect(variant.args).toStrictEqual(control.args);
  });

  /**
   * **Both arms are marked — necessary for running the same suite, and not sufficient.** The
   * marker also excludes two files a worker without WebAssembly cannot run, and excluding them
   * from one arm only would add "which tests ran" as a second difference. But an exclusion keyed
   * to the variant's *value* leaves this green with the arms collecting two different sets, so the
   * property itself — identical collected suites — is held by `check-runtime-mode.mjs`, which
   * lists what Vitest collects for each arm through the real config.
   */
  it("marks both arms, which the shared exclusion needs", () => {
    const control = spawnPlan(CONTROL, {}, pathsOne);
    const variant = spawnPlan(VARIANT, {}, pathsTwo);

    expect(control.env[RUNTIME_MODE_ENV]).toBeDefined();
    expect(variant.env[RUNTIME_MODE_ENV]).toBeDefined();
    expect(control.env[RUNTIME_MODE_ENV]).not.toBe(variant.env[RUNTIME_MODE_ENV]);
  });

  /**
   * **Falsifier: the certificate compared against the marker instead of the arm.** The fixture
   * inside the worker can only check the worker against its own marker, so a variant run whose
   * environment never arrived is green in there: no marker, no flag, agreement. The runner is the
   * one party that knows which arm it scheduled, and these are its judgments.
   */
  describe("certifying a run against the arm it was scheduled in", () => {
    it("accepts each arm's own certificate", () => {
      expect(certificateProblems(CONTROL, certificateOf(CONTROL), against)).toStrictEqual([]);
      expect(certificateProblems(VARIANT, certificateOf(VARIANT), against)).toStrictEqual([]);
      // The arm 2c ran is still in the table, and still certifies — by its one visible
      // consequence as well as by its arguments.
      expect(certificateProblems("jitless", certificateOf("jitless"), against)).toStrictEqual([]);
    });

    /** The shape a run leaves when its environment never reached the child. */
    it("refuses a run that wrote no certificate", () => {
      expect(certificateProblems(VARIANT, undefined, against)).toStrictEqual([
        expect.stringMatching(/no runtime-mode certificate was written/),
      ]);
      expect(certificateProblems(CONTROL, undefined, against)).toHaveLength(1);
    });

    /**
     * Self-consistent, and wrong: every fact agrees with the certificate's own marker, and none
     * with the arm. A judgment that took its expectation from the marker would pass both.
     */
    it("refuses a self-consistent certificate from the other arm", () => {
      const asVariant = certificateProblems(VARIANT, certificateOf(CONTROL), against).join("\n");
      expect(asVariant).toMatch(/certified marker="default" where "no-opt" was intended/);
      expect(asVariant).toMatch(/does not differ from the control by exactly \["--no-opt"\]/);
      expect(asVariant).toMatch(/lacks \["--no-opt"\]/);

      const asControl = certificateProblems(CONTROL, certificateOf(VARIANT), against).join("\n");
      expect(asControl).toMatch(/certified marker="no-opt" where "default" was intended/);
      expect(asControl).toMatch(/not started with exactly Vitest's own arguments/);
      expect(asControl).toMatch(/has \["--no-opt"\] besides/);
    });

    /** The `poolOptions.forks.execArgv` failure: the marker arrives and the flag does not. */
    it("refuses a marker that arrived without its flag", () => {
      const problems = certificateProblems(
        VARIANT,
        { ...certificateOf(CONTROL), marker: VARIANT },
        against,
      );
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/lacks \["--no-opt"\]/);
    });

    /** An unmarked run — neither arm's — certifies neither. */
    it("refuses a certificate with no marker at all, even for the control", () => {
      const unmarked = without(certificateOf(CONTROL), "marker");
      expect(certificateProblems(CONTROL, unmarked, against)).toStrictEqual([
        expect.stringMatching(/certified marker=undefined where "default" was intended/),
      ]);
    });
  });

  /**
   * **The whole startup argument list, held directly.** Each case below was measured on Node 24
   * with a hot function and `%GetOptimizationStatus`, and each gets past a search for flags:
   * that is why nothing is searched for.
   */
  describe("holding a worker to its whole argument list", () => {
    /**
     * **Falsifier: `default + --max-opt=2`.** TurboFan is *off* in this worker and `--no-opt`
     * appears nowhere, so neither "is `--no-opt` absent?" nor a list of known flags notices. It
     * is refused for being unexpected, not for being recognised.
     */
    it("refuses a control carrying a tier-changing argument no list of flags names", () => {
      const problems = certificateProblems(
        CONTROL,
        certificateOf(CONTROL, ["--max-opt=2"]),
        against,
      );
      expect(problems).toStrictEqual([
        expect.stringMatching(
          /not started with exactly Vitest's own arguments.*has \["--max-opt=2"\] besides/,
        ),
      ]);
    });

    /**
     * **Falsifier: `no-opt + --opt`.** TurboFan is back *on* — the last flag wins — while
     * `--no-opt` is present, so a search for it passes. The arms differ by two elements.
     */
    it("refuses a variant whose flag is undone by the argument after it", () => {
      const problems = certificateProblems(VARIANT, certificateOf(VARIANT, ["--opt"]), against);
      expect(problems).toStrictEqual([
        expect.stringMatching(
          /does not differ from the control by exactly \["--no-opt"\].*has \["--opt"\] besides/,
        ),
      ]);
    });

    /** Order is meaning: `--opt --no-opt` is off, `--no-opt --opt` is on. Same elements. */
    it("refuses the right arguments in the wrong order", () => {
      const swapped = certificateOf(VARIANT);
      swapped.execArgv = [...RUNTIME_MODES[VARIANT], ...vitestsOwn()];
      expect(certificateProblems(VARIANT, swapped, against).join("\n")).toMatch(
        /the same arguments in a different order/,
      );
    });

    /**
     * **Falsifier: the same extra argument in *both* arms.** The pair still differs by exactly
     * `--no-opt`, so the pair rule alone would accept two arms that are wrong in the same way.
     * The control's exact list is what refuses it — and once the control is refused it is no
     * baseline, so the variant has nothing to be held against and is refused too.
     */
    it("refuses an argument shared by both arms, which the pair rule alone would accept", () => {
      const control = certificateOf(CONTROL, ["--max-opt=2"]);
      expect(certificateProblems(CONTROL, control, { root: ROOT })).toHaveLength(1);
      expect(controlBaseline(CONTROL, control, ROOT)).toBeUndefined();

      const variant = { ...certificateOf(VARIANT), execArgv: [...control.execArgv, "--no-opt"] };
      expect(
        certificateProblems(VARIANT, variant, { root: ROOT, baseline: undefined }),
      ).toStrictEqual([expect.stringMatching(/no control run has certified yet/)]);
      // And against a sound control it is refused on its own account.
      expect(certificateProblems(VARIANT, variant, against).join("\n")).toMatch(
        /has \["--max-opt=2"\] besides/,
      );
    });

    /** The flag that makes the meaning check possible must never be in a measured arm. */
    it("refuses --allow-natives-syntax in either arm", () => {
      for (const which of [CONTROL, VARIANT]) {
        expect(
          certificateProblems(which, certificateOf(which, ["--allow-natives-syntax"]), against),
        ).toHaveLength(1);
      }
    });

    it("refuses a worker that saw any NODE_OPTIONS", () => {
      const certificate = { ...certificateOf(CONTROL), nodeOptions: "--max-old-space-size=4096" };
      expect(certificateProblems(CONTROL, certificate, against)).toStrictEqual([
        expect.stringMatching(/certified nodeOptions="--max-old-space-size=4096" where null/),
      ]);
    });

    it("refuses a certificate that did not record its arguments at all", () => {
      const bare = without(certificateOf(CONTROL), "execArgv");
      expect(certificateProblems(CONTROL, bare, against)).toStrictEqual([
        expect.stringMatching(/did not record its startup arguments/),
      ]);
    });

    /** The pair rule is judged against a real control run, and only one that certified. */
    it("takes the baseline from a certified control run, and from nothing else", () => {
      expect(controlBaseline(CONTROL, certificateOf(CONTROL), ROOT)).toStrictEqual(BASELINE);
      expect(controlBaseline(VARIANT, certificateOf(VARIANT), ROOT)).toBeUndefined();
      expect(controlBaseline(CONTROL, undefined, ROOT)).toBeUndefined();
    });

    it("takes the project's own location out of a path, and normalises nothing else", () => {
      expect(
        relativeArguments(["--require", "/repo/node_modules/x.cjs", "/repository/y"], "/repo"),
      ).toStrictEqual(["--require", "node_modules/x.cjs", "/repository/y"]);
    });
  });

  /** A control arm that already carries the marker is a comparison between an arm and itself. */
  it("refuses to run when the marker is already inherited", () => {
    expect(refusedEnvironment({})).toBeUndefined();
    expect(refusedEnvironment({ PATH: "/usr/bin", CI: "true" })).toBeUndefined();
    expect(refusedEnvironment({ [RUNTIME_MODE_ENV]: VARIANT })).toMatch(/must run default Node/);
  });

  /** The self-test fails a fixture on purpose; inherited, it would fail all 300 runs. */
  it("refuses to run when the check's self-test is inherited", () => {
    expect(refusedEnvironment({ [SELFTEST_ENV]: SELFTEST_MIXED })).toMatch(/fail every run/);
  });

  /**
   * **Falsifier: any `NODE_OPTIONS` inherited at all.** 2c's refusal searched it for `--jitless`
   * and let everything else through — and `--max-opt=2` there disables TurboFan in *both* arms,
   * touching no worker's argument list. No value of it is needed to run this experiment, so all
   * of it is refused; an empty one is nothing.
   */
  it("refuses any inherited NODE_OPTIONS, not only the flags somebody thought of", () => {
    for (const value of ["--max-old-space-size=4096", "--max-opt=2", "--jitless", "--no-opt"]) {
      expect(refusedEnvironment({ NODE_OPTIONS: value })).toMatch(/NODE_OPTIONS is set/);
    }
    expect(refusedEnvironment({ NODE_OPTIONS: "" })).toBeUndefined();
    expect(refusedEnvironment({ NODE_OPTIONS: "  " })).toBeUndefined();
  });
});

describe("the schedule", () => {
  /**
   * **Falsifier: grouped execution replacing alternation.** Grouping would put any drift over the
   * job's duration entirely on whichever arm ran second — a runner warming, a neighbour starting
   * — and that is the whole reason now. (2c also read an `M` eligibility rule off the control's
   * first runs, which needed them spread across the job; 2d makes no statement about `M`, and that
   * rule is gone. The hit indices it used are still recorded.)
   */
  it("alternates the arms rather than grouping them", () => {
    const order = schedule(3);
    expect(order).toStrictEqual([CONTROL, VARIANT, CONTROL, VARIANT, CONTROL, VARIANT]);
  });

  it("gives each arm the same number of runs", () => {
    const order = schedule(RUNS_PER_ARM);
    expect(order).toHaveLength(RUNS_PER_ARM * 2);
    expect(order.filter((one) => one === CONTROL)).toHaveLength(RUNS_PER_ARM);
    expect(order.filter((one) => one === VARIANT)).toHaveLength(RUNS_PER_ARM);
  });
});

describe("driving the schedule", () => {
  /** The deliverable is a pair of rates; a loop that stopped at its first hit would have neither. */
  it("keeps going after a hit, and counts each arm separately", () => {
    const results = [hit(), passed(), passed(), hit(), hit(), passed()];
    let next = 0;

    const counts = runExperiment({ runsPerArm: 3, runSuite: () => results[next++] });

    expect(counts.arms[CONTROL]).toMatchObject({ completed: 3, signature: 2, hitRuns: [1, 3] });
    expect(counts.arms[VARIANT]).toMatchObject({ completed: 3, signature: 1, hitRuns: [2] });
  });

  /** One-based within the arm, because the `M` rule is about position in the control arm. */
  it("records hit indices within the arm, not within the whole schedule", () => {
    const results = [passed(), passed(), hit(), passed()];
    let next = 0;

    const counts = runExperiment({ runsPerArm: 2, runSuite: () => results[next++] });

    expect(counts.arms[CONTROL].hitRuns).toStrictEqual([2]);
  });

  /** A suite that cannot be started is not a failing suite, and is not counted as one. */
  it("stops when a run cannot be spawned rather than counting it as a failure", () => {
    const counts = runExperiment({
      runsPerArm: 3,
      runSuite: ({ index }) =>
        index === 3 ? { spawned: false, reason: "npm missing", exitCode: 1, output: "" } : passed(),
    });

    expect(counts.aborted).toBe("npm missing");
    expect(counts.arms[CONTROL].completed).toBe(1);
    expect(counts.arms[CONTROL].other).toBe(0);
  });

  it("counts a truncated run as an instrument failure and still records a hit inside it", () => {
    const counts = runExperiment({
      runsPerArm: 1,
      // A hit *inside* a truncated run: the signature is in the output, and the run was cut short.
      runSuite: ({ arm: which }) =>
        which === CONTROL ? { ...truncated(), output: hit().output } : unrelated(),
    });

    expect(counts.arms[CONTROL]).toMatchObject({ signature: 1, instrument: 1, other: 0 });
    // And an ordinary failure is `other`, not an instrument fault.
    expect(counts.arms[VARIANT]).toMatchObject({ signature: 0, instrument: 0, other: 1 });
  });

  /**
   * **The whole point of marking the instrument**, carried through the real adapter rather than a
   * hand-written tally: a run killed by a signal reports its output and a null status, so a hit
   * inside it is real and is counted — and the arm is contaminated, so no comparison follows.
   */
  it("counts a hit inside a killed run, and contaminates the arm it fell in", () => {
    const killed = () =>
      interpretSpawn({
        pid: 1,
        status: null,
        signal: "SIGKILL",
        stdout: `SurfaceError: ${SIGNATURE}`,
        stderr: "",
      });

    const counts = runExperiment({ runsPerArm: 1, runSuite: killed });
    const fisher = vi.fn(() => 0.001);
    const result = verdict({ ...counts, fisher });

    expect(counts.arms[CONTROL]).toMatchObject({ completed: 1, signature: 1, instrument: 1 });
    expect(result.outcome).toBe("contaminated");
    expect(fisher).not.toHaveBeenCalled();
    expect(report(result).join("\n")).toMatch(/interrupted, had their output truncated/);
  });

  /**
   * **A green run that is not known to be its arm's runtime is not a trial of that arm.** It
   * passed, so nothing else would ever flag it — which is the whole danger: sixty of them read as
   * a clean variant arm. It contaminates by the same gate as a truncated run.
   */
  it("counts a run with an instrument fault as one, even though it passed", () => {
    const counts = runExperiment({
      runsPerArm: 2,
      runSuite: ({ arm: which, armRun }) =>
        which === VARIANT && armRun === 2
          ? { ...passed(), instrumentFault: "no runtime-mode certificate was written" }
          : hit(),
    });
    const fisher = vi.fn(() => 0.001);
    const result = verdict({ ...counts, fisher });

    expect(counts.arms[VARIANT]).toMatchObject({ completed: 2, instrument: 1, other: 0 });
    expect(counts.arms[CONTROL]).toMatchObject({ completed: 2, instrument: 0 });
    expect(result.outcome).toBe("contaminated");
    expect(result.contaminated).toStrictEqual([VARIANT]);
    expect(fisher).not.toHaveBeenCalled();
    expect(report(result).join("\n")).toMatch(
      /left no valid runtime-mode certificate or structured results/,
    );
  });

  /**
   * **Falsifier: a signature masking an unrelated failure in the same run.** The kinds are
   * mutually exclusive and contamination is not. Shown in review with a real fixture: the recorded
   * failure and a second failing test in one run tallied `signature=1, other=0, instrument=0`,
   * Fisher was called, and `M` was marked as transferring — on a run that did not complete the same trial as the
   * runs beside it. The hit is kept, because it happened; the arm is spoiled, because so did the
   * other thing.
   */
  it("keeps a hit that has an unrelated failure beside it, and contaminates the arm", () => {
    const mixed = judgeRun({
      arm: CONTROL,
      interpreted: hit(),
      certificate: certificateOf(CONTROL),
      ...against,
      results: {
        failures: [
          {
            kind: "test",
            where: "build-fixture > builds",
            messages: [`${SIGNATURE}\n  placement`],
          },
          { kind: "test", where: "elsewhere > a test", messages: ["expected 1 to be 2"] },
        ],
      },
    });
    const clean = (which) =>
      judgeRun({
        arm: which,
        interpreted: passed(),
        certificate: certificateOf(which),
        ...against,
        results: { failures: [] },
      });

    const counts = runExperiment({
      runsPerArm: 2,
      runSuite: ({ arm: which, armRun }) =>
        which === CONTROL && armRun === 1 ? mixed : clean(which),
    });
    const fisher = vi.fn(() => 0.001);
    const result = verdict({ ...counts, fisher });

    expect(mixed.unrelated).toStrictEqual(["elsewhere > a test"]);
    expect(counts.arms[CONTROL]).toMatchObject({
      signature: 1,
      hitRuns: [1],
      other: 1,
      instrument: 0,
    });
    expect(counts.arms[VARIANT]).toMatchObject({ signature: 0, other: 0, instrument: 0 });
    expect(result.outcome).toBe("contaminated");
    expect(result.contaminated).toStrictEqual([CONTROL]);
    expect(fisher).not.toHaveBeenCalled();
    expect(report(result).join("\n")).toMatch(/had an unrelated failure, alone or beside a hit/);
  });

  /**
   * **The reviewer's second scenario, alone in its run**: the recorded failure and an unrelated
   * teardown error on the *same test*, which arrive as one entry. Alone matters — beside any other
   * failure the run is contaminated anyway, and the masking shows only in what gets named.
   */
  it("contaminates on an unrelated error attached to the very test that hit", () => {
    const counts = runExperiment({
      runsPerArm: 1,
      runSuite: ({ arm: which }) =>
        judgeRun({
          arm: which,
          interpreted: hit(),
          certificate: certificateOf(which),
          ...against,
          results: {
            failures: [
              {
                kind: "test",
                where: "build-fixture > builds",
                messages: [`${SIGNATURE}\n  placement`, "an unrelated failure in a teardown"],
              },
            ],
          },
        }),
    });
    const fisher = vi.fn(() => 0.001);
    const result = verdict({ ...counts, fisher });

    for (const name of [CONTROL, VARIANT]) {
      expect(counts.arms[name]).toMatchObject({ signature: 1, other: 1, instrument: 0 });
    }
    expect(result.outcome).toBe("contaminated");
    expect(fisher).not.toHaveBeenCalled();
  });

  /**
   * **Falsifier: an error that only *carries* the signature exempted from contamination.** The
   * log says hit, and the hit is kept — `classifyRun` is unchanged. But `rebuild failed:
   * <signature>`, or an unrelated error quoting the signature on a later line, is not the recorded
   * failure, and was accepted as a clean hit that reached Fisher (shown in review). Only the two
   * exact first lines production produces are exempt; see `isRecordedFailure`.
   */
  it.each([
    ["an arbitrary prefix", `rebuild failed: ${SIGNATURE}`],
    ["the signature on a later line", `cleanup failed after:\n${SIGNATURE}`],
  ])("keeps the logged hit and contaminates on %s", (_, message) => {
    const counts = runExperiment({
      runsPerArm: 1,
      runSuite: ({ arm: which }) =>
        judgeRun({
          arm: which,
          // What Vitest prints for it: the line ends as the recorded line ends, so it is a hit.
          interpreted: { exitCode: 1, output: `Error: ${message}\n` },
          certificate: certificateOf(which),
          ...against,
          results: { failures: [{ kind: "test", where: "somewhere", messages: [message] }] },
        }),
    });
    const fisher = vi.fn(() => 0.001);
    const result = verdict({ ...counts, fisher });

    for (const name of [CONTROL, VARIANT]) {
      expect(counts.arms[name]).toMatchObject({ signature: 1, hitRuns: [1], other: 1 });
    }
    expect(result.outcome).toBe("contaminated");
    expect(fisher).not.toHaveBeenCalled();
  });

  /** And the form a real build fails with is a clean hit, or every genuine hit would contaminate. */
  it("compares on a hit in the form the build reports it, from the tiles stage", () => {
    const message = `fixture build failed at stage "tiles": ${SIGNATURE}\n\ncrops as placed:\n  [0] …`;
    const counts = runExperiment({
      runsPerArm: 1,
      runSuite: ({ arm: which }) =>
        judgeRun({
          arm: which,
          interpreted:
            which === CONTROL ? { exitCode: 1, output: `BuildError: ${message}\n` } : passed(),
          certificate: certificateOf(which),
          ...against,
          results: {
            failures:
              which === CONTROL ? [{ kind: "test", where: "build", messages: [message] }] : [],
          },
        }),
    });
    const fisher = vi.fn(() => 0.5);
    const result = verdict({ ...counts, fisher });

    expect(counts.arms[CONTROL]).toMatchObject({ signature: 1, other: 0, instrument: 0 });
    expect(result.outcome).toBe("undistinguished");
    expect(fisher).toHaveBeenCalledTimes(1);
  });

  /** The same run with nothing beside the hit is a clean hit: the oracle above is not vacuous. */
  it("leaves a hit with nothing beside it intact, and compares", () => {
    const counts = runExperiment({
      runsPerArm: 1,
      runSuite: ({ arm: which }) =>
        judgeRun({
          arm: which,
          interpreted: which === CONTROL ? hit() : passed(),
          certificate: certificateOf(which),
          ...against,
          results: {
            failures:
              which === CONTROL
                ? [{ kind: "test", where: "build-fixture > builds", messages: [SIGNATURE] }]
                : [],
          },
        }),
    });
    const fisher = vi.fn(() => 0.5);

    expect(verdict({ ...counts, fisher }).outcome).toBe("undistinguished");
    expect(fisher).toHaveBeenCalledTimes(1);
  });

  /** Required of every run, so results that never arrive are found on run 1 and not at a hit. */
  it("makes missing structured results an instrument fault, in a passing run as well", () => {
    const judged = judgeRun({
      arm: CONTROL,
      interpreted: passed(),
      certificate: certificateOf(CONTROL),
      ...against,
      results: undefined,
    });

    expect(judged.instrumentFault).toMatch(/no readable structured results/);
    expect(judged.unrelated).toStrictEqual([]);
  });
});

describe("the gates", () => {
  /**
   * **Falsifier: a null control reaching the comparison.** Asserted on the *call*, not on the
   * wording: a runner that computed a p-value and then declined to print it has already made the
   * comparison the control rule forbids. There is nothing to suppress if it was never calculated.
   */
  it("never calls Fisher when the control did not reproduce", () => {
    const fisher = vi.fn(() => 0.001);

    const result = verdict({
      runsPerArm: 4,
      arms: arms(arm({ signature: 0 }), arm({ signature: 0 })),
      fisher,
    });

    expect(fisher).not.toHaveBeenCalled();
    expect(result.outcome).toBe("control-null");
    expect(result.comparison).toBeUndefined();
    expect(result.statement).toMatch(/the control did not reproduce/);
  });

  /**
   * **Falsifier: a contaminated arm netted into the comparison.** Contamination in *either* arm
   * makes the whole experiment inconclusive — "inconclusive in that arm" would leave room to
   * compare a filtered or unequal pair of samples.
   */
  it.each([
    { where: "control", control: arm({ signature: 2, other: 1 }), variant: arm({}) },
    {
      where: "variant",
      control: arm({ signature: 2, hitRuns: [1, 2] }),
      variant: arm({ other: 1 }),
    },
    {
      where: "either arm, by an instrument fault",
      control: arm({ signature: 2, hitRuns: [1, 2] }),
      variant: arm({ instrument: 1 }),
    },
    {
      where: "either arm, by a short budget",
      control: arm({ signature: 2, hitRuns: [1, 2], completed: 3 }),
      variant: arm({}),
    },
  ])("never calls Fisher when contamination is in $where", ({ control, variant }) => {
    const fisher = vi.fn(() => 0.001);

    const result = verdict({ runsPerArm: 4, arms: arms(control, variant), fisher });

    expect(fisher).not.toHaveBeenCalled();
    expect(result.outcome).toBe("contaminated");
    expect(result.comparison).toBeUndefined();
  });

  it("computes the comparison only once both arms are intact and the control reproduced", () => {
    const fisher = vi.fn(() => 0.01);

    const result = verdict({
      runsPerArm: 4,
      arms: arms(arm({ signature: 3, hitRuns: [1, 2, 3] }), arm({ signature: 0 })),
      fisher,
    });

    expect(fisher).toHaveBeenCalledWith(3, 1, 0, 4);
    expect(result.outcome).toBe("differs");
    expect(result.comparison).toMatchObject({ p: 0.01, alpha: ALPHA });
  });

  it("says the budget did not distinguish the modes when the test does not reject", () => {
    const result = verdict({
      runsPerArm: 4,
      arms: arms(arm({ signature: 2, hitRuns: [1, 2] }), arm({ signature: 2, hitRuns: [1, 2] })),
      fisher: () => 1,
    });

    expect(result.outcome).toBe("undistinguished");
    expect(result.statement).toMatch(/did not distinguish/);
  });
});

describe("what the experiment says about M", () => {
  /**
   * **Nothing, and it says so.** 2c's closing line read `M = 51` off the control's hit indices as
   * *eligible*; the owner has since ruled it not transferred, with 61 the candidate for this exact
   * suite. 2d's control is 60 runs, so a first-61 rule could not even be evaluated inside it. The
   * indices are still recorded and still printed — they are what any later ruling is read from.
   */
  it("prints the hit indices and makes no statement about M", () => {
    const result = verdict({
      runsPerArm: RUNS_PER_ARM,
      arms: arms(
        arm({ completed: RUNS_PER_ARM, signature: 2, hitRuns: [13, 60] }),
        arm({ completed: RUNS_PER_ARM }),
      ),
      fisher: () => 0.01,
    });
    const text = report(result).join("\n");

    expect(text).toMatch(/hits at arm run\(s\) {2}13, 60/);
    expect(text).toMatch(/No statement about M follows from this experiment/);
    expect(text).not.toMatch(/M = 51|ELIGIBLE|transfer/);
    expect(result).not.toHaveProperty("eligibleForM");
  });
});

describe("the report, in three tiers", () => {
  const intactPair = () =>
    verdict({
      runsPerArm: 4,
      arms: arms(arm({ signature: 2, hitRuns: [1, 3] }), arm({ signature: 0 })),
      fisher: () => 0.4,
    });

  it("gives raw counts for every arm, whatever happened", () => {
    const text = report(
      verdict({
        runsPerArm: 4,
        arms: arms(arm({ signature: 1, hitRuns: [1], other: 1 }), arm({})),
      }),
    ).join("\n");

    expect(text).toMatch(/runs completed {6}4 of 4/);
    expect(text).toMatch(/exact signature {5}1/);
    expect(text).toMatch(/other failures {6}1/);
    expect(text).toMatch(/instrument failures 0/);
  });

  /**
   * **Falsifier: a contaminated arm still given a rate.** Raw counts are observations; a rate is an
   * inference, and a contaminated arm has no denominator to draw it from — an instrument failure can
   * truncate output, so an apparent non-hit there may be an unobserved hit. Suppressing the
   * comparison does not make the arm's own rate sound.
   */
  it("reports no rate or interval for a contaminated arm, and says why", () => {
    const text = report(
      verdict({
        runsPerArm: 4,
        arms: arms(arm({ signature: 1, hitRuns: [1], instrument: 1 }), arm({})),
      }),
    ).join("\n");

    expect(text).toMatch(/rate {16}not reported/);
    expect(text).toMatch(/no denominator a rate can be read from/);
    expect(text).not.toMatch(/exact 95% CI 2[0-9.]+%–/);
  });

  it("reports a rate and an exact interval for an intact arm, even inside a spoiled experiment", () => {
    // The variant arm is intact; the control is not. The intact arm is still entitled to its rate.
    const text = report(
      verdict({
        runsPerArm: 4,
        arms: arms(arm({ other: 1 }), arm({ signature: 1, hitRuns: [2] })),
      }),
    ).join("\n");

    expect(text).toMatch(/rate {16}25\.000% \(exact 95% CI/);
    expect(text).toMatch(/rate {16}not reported/);
  });

  it("reports the p-value and the predeclared design power only past both gates", () => {
    const text = report(intactPair()).join("\n");
    expect(text).toMatch(/Fisher exact, two-sided: p = 0\.40000/);
    expect(text).not.toMatch(/achieved power/i);

    // **The curve, not one figure.** A single number would have to be quoted at one assumed
    // control rate, and that assumption is the one the record has already contradicted.
    expect(text).toMatch(/rejects at ≥ 6 hits in 150/);
    expect(text).toMatch(/if default runs at 13\.000% {3}99\.995%/);
    expect(text).toMatch(/if default runs at {2}5\.000% {3}76\.556%/);
    expect(text).toMatch(/if default runs at {2}3\.000% {3}29\.574%/);
  });

  it("says no p-value was computed, rather than withholding one, when a gate stopped it", () => {
    const text = report(
      verdict({ runsPerArm: 4, arms: arms(arm({ signature: 0 }), arm({ signature: 0 })) }),
    ).join("\n");

    expect(text).toMatch(/No Fisher test was computed/);
    expect(text).toMatch(/there is no number being withheld/);
    expect(text).not.toMatch(/p = /);
  });

  /**
   * **A null control now carries its own bound** (increment 2e). Asserted on a real `verdict`, so
   * the denominator is the arm's own completed count rather than a constant — at four runs the
   * bound is 52.713%, which is what a four-run null is actually worth and is visibly useless. The
   * point is that the number is printed and derived, not that it is small.
   */
  it("gives a null control the one-sided bound it is entitled to, and scopes it to the job", () => {
    const text = report(
      verdict({ runsPerArm: 4, arms: arms(arm({ signature: 0 }), arm({ signature: 0 })) }),
    ).join("\n");

    expect(text).toMatch(
      /one-sided 95% upper bound on this job's control rate is 52\.713% \(0 in 4\)/,
    );
    // The caveat travels with the number, so the bound cannot be read as a claim about the
    // runner in general — which is precisely what increment 2d disproved.
    expect(text).toMatch(/not a probability about the true rate/);
    expect(text).toMatch(/not a\n?.*claim that the rate holds between jobs/);
  });

  /**
   * **Falsifier: an answerless job turning green.** Increment 2e gives a null control a finding of
   * its own — the bound above — and a reader who saw one might think the job had produced what it
   * asks for. It has not: the question is whether the rate differs between runtime modes, and a
   * bound on the control is an observation about the day. Asserted on every outcome, so that
   * "green" cannot be widened one case at a time.
   */
  it("exits non-zero for every outcome that did not answer the question", () => {
    const answered = verdict({
      runsPerArm: 4,
      arms: arms(arm({ signature: 2 }), arm({ signature: 0 })),
      fisher: () => 0.01,
    });
    expect(exitCode(answered)).toBe(0);

    const nullControl = verdict({
      runsPerArm: 4,
      arms: arms(arm({ signature: 0 }), arm({ signature: 0 })),
    });
    const contaminated = verdict({
      runsPerArm: 4,
      arms: arms(arm({ signature: 2, other: 1 }), arm({ signature: 0 })),
    });
    expect(nullControl.outcome).toBe("control-null");
    expect(contaminated.outcome).toBe("contaminated");
    expect(exitCode(nullControl)).toBe(1);
    expect(exitCode(contaminated)).toBe(1);
  });

  /** A contaminated arm has no denominator, so it gets no bound — the gate order decides this. */
  it("gives a contaminated experiment no bound at all", () => {
    const text = report(
      verdict({
        runsPerArm: 4,
        arms: arms(arm({ signature: 0, other: 1 }), arm({ signature: 0 })),
      }),
    ).join("\n");

    expect(text).toMatch(/contaminated/);
    expect(text).not.toMatch(/upper bound/);
  });

  /** The permitted wording, and the limit that travels with it. */
  it("bounds what a significant result is allowed to mean", () => {
    const text = report(
      verdict({
        runsPerArm: 4,
        arms: arms(arm({ signature: 3, hitRuns: [1, 2, 3] }), arm({})),
        fisher: () => 0.01,
      }),
    ).join("\n");

    expect(text).toMatch(/DIFFERS: the failure rate differs between default and --no-opt/);
    // The narrower reading 2d is entitled to, and its limit, travelling with the claim.
    expect(text).toMatch(/TurboFan-enabled against TurboFan-disabled execution, and no more/);
    expect(text).toMatch(
      /It does not say\s+optimisation caused the failure, or that TurboFan has a defect/,
    );
    expect(text).toMatch(/It narrows a variable\. It does not name a mechanism\./);
    expect(text).not.toMatch(/jitless/);
  });
});
