// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import {
  PLANNED_RUNS,
  SIGNATURE,
  classifyRun,
  interpretSpawn,
  refusedArguments,
  runProbe,
  verdict,
  zeroHitUpperBound,
} from "./flake-probe.mjs";

const text = (v) => verdict(v).lines.join("\n");

describe("classifyRun", () => {
  it("counts a failing run carrying the exact signature", () => {
    // As vitest actually prints it: the sentence ends its line. An earlier fixture wrapped it in
    // "... ... ..." and passed only because the match was an unanchored `includes`.
    const output = `FAIL scripts/fixture/build.test.mjs\nSurfaceError: ${SIGNATURE}\n`;
    expect(classifyRun({ exitCode: 1, output })).toBe("signature");
  });

  it("counts a failing run without it separately", () => {
    expect(classifyRun({ exitCode: 1, output: "some other test failed" })).toBe("other");
  });

  /**
   * **The worst error this probe could make.** `surface.test.mjs` asserts on messages of exactly
   * this shape, so a classifier keying purely on the text would count a green run as a
   * reproduction — and a fix would then be "falsified" against a failure that never happened.
   */
  it("never counts a passing run as a reproduction, whatever its output contains", () => {
    expect(classifyRun({ exitCode: 0, output: `a test asserted on "${SIGNATURE}"` })).toBe(
      "passed",
    );
  });

  /**
   * A different overlap, a gap or a different union is a second defect, not this one — and the
   * gap count is the half an earlier version left out, so a hole in the union was counted as the
   * recorded failure.
   */
  it.each([
    ["a different overlap count", SIGNATURE.replace("3955", "3954")],
    ["a different gap count", SIGNATURE.replace("0 sample(s)", "17 sample(s)")],
    ["a different union", SIGNATURE.replace("46x113", "46x114")],
    ["a union that merely starts the same", `${SIGNATURE}0`],
    ["anything else trailing the line", `${SIGNATURE}x5`],
  ])("does not match %s", (_name, near) => {
    expect(classifyRun({ exitCode: 1, output: `SurfaceError: ${near}` })).toBe("other");
  });

  /** The diagnostics of PR #48 begin on the next line, so anchoring to a line end costs nothing. */
  it("matches when the recorded line is followed by its placement report", () => {
    const output = `SurfaceError: ${SIGNATURE}\n\ncrops as placed:\n  [0] 46x113 at col 0..45`;
    expect(classifyRun({ exitCode: 1, output })).toBe("signature");
  });

  it("matches through vitest's colour codes", () => {
    const esc = String.fromCharCode(27);
    const output = `${esc}[31mSurfaceError: ${SIGNATURE}${esc}[39m`;
    expect(classifyRun({ exitCode: 1, output })).toBe("signature");
  });
});

describe("the budget", () => {
  /**
   * Not an input, and asserted so: a run count chosen at dispatch time is a probabilistic bar
   * selected after the result is known, which the plan refuses at length.
   */
  it("is the predeclared 100 runs", () => {
    expect(PLANNED_RUNS).toBe(100);
  });
});

describe("verdict", () => {
  const full = { planned: 100, completed: 100, signature: 0, other: 0 };

  it("reports a bound, not an absence, on a clean full-budget null", () => {
    const result = verdict(full);
    expect(result.clean).toBe(true);
    expect(result.reproduced).toBe(false);
    expect(text(full)).toContain("NOT REPRODUCED");
    expect(text(full)).toContain("upper bound on the per-run rate: 2.951%");
    expect(text(full)).toContain("no fix follows");
  });

  it("reports an actionable reproduction with its observed rate", () => {
    const hit = { ...full, signature: 2 };
    expect(verdict(hit).reproduced).toBe(true);
    expect(verdict(hit).actionable).toBe(true);
    expect(text(hit)).toContain("REPRODUCED");
    expect(text(hit)).toContain("0.0200");
    expect(text(hit)).toContain("A fix may now be attempted");
  });

  /**
   * **A hit is an observation; it is not automatically a licence to fix.** A fix has to be
   * falsified against a *rate*, and a rate measured over a short or contaminated budget is not
   * one. The observation is preserved either way — it is real, and it belongs on issue #30 — but
   * `actionable` stays false and the runner goes red.
   */
  it.each([
    ["the budget was cut short", { ...full, completed: 40, signature: 1 }],
    ["an unrelated failure also occurred", { ...full, signature: 1, other: 3 }],
  ])("records a hit but refuses to authorise a fix when %s", (_name, counts) => {
    const result = verdict(counts);
    expect(result.reproduced).toBe(true);
    expect(result.actionable).toBe(false);
    expect(result.clean).toBe(false);
    expect(text(counts)).toContain("OBSERVED BUT INCONCLUSIVE");
    expect(text(counts)).toContain("no fix follows");
    expect(text(counts)).not.toContain("A fix may now be attempted");
  });

  /**
   * **A probe that stopped early has not shown the signature is absent** — it has shown it did not
   * finish asking. It is reached when `runProbe` gives up because the suite could not be launched;
   * a workflow timeout is *not* this case, since a killed job never reaches `verdict` at all. And
   * it is the outcome most likely to be read as "fine" by someone skimming.
   */
  it("refuses to claim a null when the budget was not spent", () => {
    const short = { ...full, completed: 60 };
    expect(verdict(short).clean).toBe(false);
    expect(text(short)).toContain("INCONCLUSIVE");
    expect(text(short)).not.toContain("upper bound");
  });

  /** An unrelated failure means some runs did not ask this probe's question at all. */
  it("refuses to claim a null when an unrelated failure occurred", () => {
    const dirty = { ...full, other: 1 };
    expect(verdict(dirty).clean).toBe(false);
    expect(text(dirty)).toContain("INCONCLUSIVE");
    expect(text(dirty)).not.toContain("upper bound");
  });

  /** A hit is still a hit when the budget was cut short or something else also broke. */
  it("names both reasons when a hit arrives on a short and contaminated budget", () => {
    const both = { planned: 100, completed: 70, signature: 1, other: 2 };
    expect(text(both)).toContain("OBSERVED BUT INCONCLUSIVE");
    expect(text(both)).toContain("only 70 of 100 runs completed");
    expect(text(both)).toContain("2 run(s) failed for an unrelated reason");
  });
});

describe("zeroHitUpperBound", () => {
  it("matches the bound 2a reported for its 200 runs", () => {
    expect(zeroHitUpperBound(200) * 100).toBeCloseTo(1.487, 3);
  });

  it("loosens as the budget shrinks, which is why the budget is fixed in advance", () => {
    expect(zeroHitUpperBound(100)).toBeGreaterThan(zeroHitUpperBound(200));
  });
});

describe("runProbe", () => {
  /** A runner whose script says what each call returns, so the loop's behaviour is observable. */
  const scripted = (kinds) => {
    const calls = [];
    const runSuite = (run) => {
      calls.push(run);
      const kind = kinds[run - 1] ?? "passed";
      if (kind === "unspawnable")
        return { spawned: false, reason: "npm is not on PATH", exitCode: 1, output: "" };
      if (kind === "signature") return { exitCode: 1, output: `SurfaceError: ${SIGNATURE}` };
      if (kind === "other") return { exitCode: 1, output: "a different test failed" };
      return { exitCode: 0, output: "ok" };
    };
    return { calls, runSuite };
  };

  /**
   * **The central requirement of step 2b, and the one a mutation could quietly remove.** The
   * deliverable is a rate, so the loop must keep going after a hit; a `break` on first success
   * would report one hit over an unknown number of runs and no test of the counts alone would
   * notice. The injected runner proves every planned invocation happened.
   */
  it("keeps running after a hit, for the whole budget", () => {
    const { calls, runSuite } = scripted(["signature"]);
    const counts = runProbe({ planned: 10, runSuite });
    expect(calls).toHaveLength(10);
    expect(calls.at(-1)).toBe(10);
    expect(counts).toMatchObject({ planned: 10, completed: 10, signature: 1, other: 0 });
    expect(verdict(counts).actionable).toBe(true);
  });

  it("counts hits and unrelated failures apart, across the whole budget", () => {
    const { runSuite } = scripted(["signature", "other", "passed", "signature"]);
    expect(runProbe({ planned: 6, runSuite })).toMatchObject({
      completed: 6,
      signature: 2,
      other: 1,
    });
  });

  /**
   * A suite that cannot be started is not a suite that failed: counting it as an unrelated failure
   * would let a machine that can run nothing report a hundred of them. Stopping here is **the**
   * path that makes a partial `completed` reachable — `runProbe` otherwise always spends its whole
   * budget, and a workflow timeout produces no counts at all, because a killed job never reaches
   * `verdict`.
   */
  it("stops when the suite cannot be started, and says how far it got", () => {
    const { calls, runSuite } = scripted(["passed", "unspawnable"]);
    const counts = runProbe({ planned: 10, runSuite });
    expect(calls).toHaveLength(2);
    expect(counts).toMatchObject({ completed: 1, other: 0, aborted: "npm is not on PATH" });
    expect(verdict(counts).clean).toBe(false);
    expect(verdict(counts).lines.join("\n")).toContain("only 1 of 10 runs completed");
  });

  it("reports each run to the caller, so a hit's output can be printed in full", () => {
    const seen = [];
    const { runSuite } = scripted(["signature"]);
    runProbe({ planned: 2, runSuite, onRun: (event) => seen.push(event) });
    expect(seen.map((one) => one.kind)).toStrictEqual(["signature", "passed"]);
    expect(seen[0].output).toContain(SIGNATURE);
  });
});

describe("refusedArguments", () => {
  it("proceeds when given none", () => {
    expect(refusedArguments([])).toBeUndefined();
  });

  /**
   * Found the hard way in review: `npm run probe:flake -- --help` printed no help and started the
   * full loop, because the runner ignored its arguments. An hour of runner time should not begin
   * because of a typo, and there is no argument that could ever be right — the budget is fixed in
   * source precisely so it cannot be chosen at the command line.
   */
  it.each([["--help"], ["--runs=5"], ["100"]])("refuses %s, and says why", (arg) => {
    const refusal = refusedArguments([arg]);
    expect(refusal).toContain("takes no arguments");
    expect(refusal).toContain(JSON.stringify(arg));
    expect(refusal).toContain("exactly 100 times");
  });
});

describe("interpretSpawn", () => {
  const ok = { status: 0, stdout: "all good", stderr: "", pid: 1234 };

  it("passes an ordinary run through with its output", () => {
    expect(interpretSpawn(ok)).toStrictEqual({ exitCode: 0, output: "all good" });
  });

  it("joins stdout and stderr, since the signature can arrive on either", () => {
    expect(interpretSpawn({ status: 1, stdout: "a", stderr: "b", pid: 9 }).output).toBe("ab");
  });

  /**
   * A child that never existed: `ENOENT` reports `pid` 0 and no output. Continuing would report a
   * hundred unrelated failures on a machine that can run nothing.
   */
  it("treats a launch failure as an abort", () => {
    const result = interpretSpawn({ error: { message: "spawn npm ENOENT" }, pid: 0, status: null });
    expect(result.spawned).toBe(false);
    expect(result.reason).toContain("ENOENT");
  });

  /**
   * **And a child that ran and was cut off is not that.** `spawnSync` also sets `error` after the
   * fact — `ENOBUFS` when output overflows the buffer — and that result carries a real pid, a null
   * status, and the output captured so far. Measured, not assumed. Discarding it would throw away
   * a hit that actually happened, so the output is kept and the run is marked instead.
   */
  it("keeps a truncated run and its output rather than calling it a launch failure", () => {
    const result = interpretSpawn({
      error: { message: "stdout maxBuffer length exceeded" },
      pid: 4321,
      status: null,
      stdout: `SurfaceError: ${SIGNATURE}`,
      stderr: "",
    });
    expect(result.spawned).not.toBe(false);
    expect(result.truncated).toBe(true);
    expect(result.output).toContain(SIGNATURE);
    expect(classifyRun(result)).toBe("signature");
  });
});

describe("interpretSpawn, on a child that did not exit on its own terms", () => {
  /**
   * **A signal sets no error.** `spawnSync` reports `status: null` and `signal: "SIGTERM"` with
   * `error` undefined — measured, not assumed — so an adapter that keyed on `error` would treat a
   * killed run as an ordinary one. A run that printed the signature and was then terminated would
   * have been counted as a clean hit and would have authorised a fix.
   */
  it("marks a signal-killed run as an instrument failure, keeping its output", () => {
    const result = interpretSpawn({
      pid: 4321,
      status: null,
      signal: "SIGTERM",
      stdout: `SurfaceError: ${SIGNATURE}`,
      stderr: "",
    });
    expect(result.spawned).not.toBe(false);
    expect(result.truncated).toBe(true);
    expect(result.reason).toContain("SIGTERM");
    expect(classifyRun(result)).toBe("signature");
  });

  it("says so even when the signal is not reported", () => {
    expect(interpretSpawn({ pid: 9, status: null, stdout: "", stderr: "" }).reason).toContain(
      "unknown signal",
    );
  });

  /** A run that exited normally, pass or fail, is an ordinary run and must stay one. */
  it.each([
    ["a pass", 0, "passed"],
    ["an ordinary failure", 1, "other"],
  ])("leaves %s alone", (_name, status, kind) => {
    const result = interpretSpawn({ pid: 7, status, signal: null, stdout: "x", stderr: "" });
    expect(result.truncated).toBeUndefined();
    expect(classifyRun(result)).toBe(kind);
  });

  /** The whole point: a hit inside a killed run cannot authorise a fix. */
  it("cannot authorise a fix, even carrying a hit", () => {
    const killed = () =>
      interpretSpawn({
        pid: 1,
        status: null,
        signal: "SIGKILL",
        stdout: `SurfaceError: ${SIGNATURE}`,
        stderr: "",
      });
    const counts = runProbe({ planned: 2, runSuite: killed });
    expect(counts).toMatchObject({ completed: 2, signature: 2, other: 0, instrument: 2 });
    const result = verdict(counts);
    expect(result.reproduced).toBe(true);
    expect(result.actionable).toBe(false);
    expect(result.lines.join("\n")).toContain("interrupted or had their output truncated");
  });
});

describe("a run the instrument interrupted", () => {
  const truncatedHit = () => ({
    truncated: true,
    reason: "stdout maxBuffer length exceeded",
    exitCode: 1,
    output: `SurfaceError: ${SIGNATURE}`,
  });

  /**
   * The hit happened and is recorded; what the truncation costs is the *rate*. A fix falsified
   * against a run measured partly through a broken instrument is not falsified against anything.
   */
  it("counts the hit, marks the instrument, and refuses to authorise a fix", () => {
    const counts = runProbe({
      planned: 3,
      runSuite: (run) => (run === 1 ? truncatedHit() : { exitCode: 0, output: "ok" }),
    });
    expect(counts).toMatchObject({ completed: 3, signature: 1, other: 0, instrument: 1 });
    const result = verdict(counts);
    expect(result.reproduced).toBe(true);
    expect(result.actionable).toBe(false);
    expect(result.lines.join("\n")).toContain("interrupted or had their output truncated");
  });

  /** A truncated run that carried no hit is an instrument failure and not an unrelated one. */
  it("does not also count it as an unrelated failure", () => {
    const counts = runProbe({
      planned: 2,
      runSuite: () => ({ truncated: true, exitCode: 1, output: "something else broke" }),
    });
    expect(counts).toMatchObject({ other: 0, instrument: 2 });
    expect(verdict(counts).clean).toBe(false);
  });
});
