// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { BuildError } from "./fixture/build.mjs";
import { SurfaceError, stitchSurface } from "./fixture/surface.mjs";
import {
  RECORDED_FIRST_LINES,
  SIGNATURE,
  classifyRun,
  interpretSpawn,
  isRecordedFailure,
  readableResults,
  unrelatedFailures,
} from "./flake-probe.mjs";

/**
 * The recorded failure, **raised by the production code** rather than typed out: a 46x113 crop
 * with a 35x113 crop laid over its first 35 columns is a union of 46x113 with no gap and
 * 35 x 113 = 3955 samples written twice — the recorded numbers exactly. So what is judged below
 * is the message `stitchSurface` really builds, diagnostics and all, and then the message
 * `BuildError` really builds around it at the stage where a build calls it.
 */
function realSurfaceError() {
  const crop = (width, height) => ({
    width,
    height,
    west: 7,
    north: 45.9,
    pixelScaleDeg: 1 / 3600,
    rgb: new Uint8Array(width * height * 3),
  });
  try {
    stitchSurface([crop(46, 113), crop(35, 113)]);
  } catch (error) {
    return error;
  }
  throw new Error("stitchSurface did not refuse the overlapping crops");
}

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
});

describe("unrelatedFailures", () => {
  /** A failure in the shape `probe-results-reporter.mjs` writes. */
  const failure = (where, ...messages) => ({ kind: "test", where, messages });
  const theHit = failure("build-fixture > builds", `${SIGNATURE}\n  placement: …`);

  it("finds nothing unrelated in a run whose only failure is the recorded one", () => {
    expect(unrelatedFailures({ exitCode: 1, results: { failures: [theHit] } })).toStrictEqual([]);
  });

  /**
   * **The masking this exists to close.** `classifyRun` calls this run a `signature`, correctly,
   * and being one of three kinds it can say nothing more; what failed beside the hit has to be
   * asked separately or it is never asked.
   */
  it("names what failed beside a hit, and not the hit", () => {
    const results = {
      failures: [
        theHit,
        failure("some.test > a test", "expected 1 to be 2"),
        failure("a hook", "x"),
      ],
    };

    expect(unrelatedFailures({ exitCode: 1, results })).toStrictEqual([
      "some.test > a test",
      "a hook",
    ]);
  });

  /** On the same terms as `classifyRun`: the line has to end where the recorded one ends. */
  it("does not take a longer line for the recorded failure", () => {
    const results = { failures: [failure("wider", `${SIGNATURE}0`)] };
    expect(unrelatedFailures({ exitCode: 1, results })).toStrictEqual(["wider"]);
  });

  /**
   * **The same masking, one level down.** Vitest attaches a teardown's error to the test it ran
   * after, so the recorded failure and an unrelated `afterEach` error are one entry with two
   * messages. Shown in review with a real subprocess: clearing the entry on *some* message
   * carrying the signature gave `signature=1, other=0`, and Fisher was called.
   */
  it("names an unrelated error on the same test as the recorded failure", () => {
    const sameTest = failure(
      "build-fixture > builds",
      `${SIGNATURE}\n  placement: …`,
      "teardown failed",
    );
    const either = failure("build-fixture > builds", "teardown failed", SIGNATURE);

    expect(unrelatedFailures({ exitCode: 1, results: { failures: [sameTest] } })).toStrictEqual([
      "build-fixture > builds — another error beside the recorded failure",
    ]);
    // Whichever order they arrive in.
    expect(unrelatedFailures({ exitCode: 1, results: { failures: [either] } })).toHaveLength(1);
    // And two errors that are both the recorded failure are still only the recorded failure.
    const twice = failure("build-fixture > builds", SIGNATURE, `${SIGNATURE}\n  placement: …`);
    expect(unrelatedFailures({ exitCode: 1, results: { failures: [twice] } })).toStrictEqual([]);
  });

  it("counts a failed test that carries no message at all", () => {
    const results = { failures: [theHit, { kind: "test", where: "silent", messages: [] }] };
    expect(unrelatedFailures({ exitCode: 1, results })).toStrictEqual(["silent"]);
  });

  /** A coverage threshold, say: the command failed and no test did. Not the recorded failure. */
  it("treats a failing exit with nothing recorded as unrelated", () => {
    expect(unrelatedFailures({ exitCode: 1, results: { failures: [] } })).toStrictEqual([
      expect.stringMatching(/exit 1 with no failed test/),
    ]);
    expect(unrelatedFailures({ exitCode: 0, results: { failures: [] } })).toStrictEqual([]);
  });
});

describe("readableResults", () => {
  it("accepts what the reporter writes and refuses anything else", () => {
    expect(readableResults({ reason: "passed", failures: [] })).toBe(true);
    expect(readableResults({ failures: [{ where: "a", messages: ["b"] }] })).toBe(true);
    expect(readableResults(undefined)).toBe(false);
    expect(readableResults({})).toBe(false);
    expect(readableResults({ failures: [{ where: "a" }] })).toBe(false);
    // Vitest's own JSON reporter, which is not the instrument: see the reporter for why.
    expect(readableResults({ testResults: [], success: true })).toBe(false);
  });
});

describe("isRecordedFailure, on the recorded failure as production raises it", () => {
  const surfaceError = realSurfaceError();
  const buildError = new BuildError("tiles", surfaceError);

  it("is looking at the real thing: a SurfaceError, with its placement report appended", () => {
    expect(surfaceError).toBeInstanceOf(SurfaceError);
    expect(surfaceError.message.split("\n").length).toBeGreaterThan(1);
    expect(buildError.message.split("\n").length).toBeGreaterThan(1);
  });

  /**
   * **One identity, two representations, both derived from production.** If `stitchSurface`
   * rewords its first line or `BuildError` relabels a stage, this fails — which is what keeps the
   * two accepted forms from becoming a second, independently maintained signature.
   */
  it("accepts exactly the two first lines production produces, and they are built on SIGNATURE", () => {
    expect(RECORDED_FIRST_LINES).toStrictEqual([
      surfaceError.message.split("\n")[0],
      buildError.message.split("\n")[0],
    ]);
    expect(RECORDED_FIRST_LINES[0]).toBe(SIGNATURE);
    expect(RECORDED_FIRST_LINES[1].endsWith(SIGNATURE)).toBe(true);
  });

  it("recognises both, with the diagnostics that follow the first line", () => {
    expect(isRecordedFailure(surfaceError.message)).toBe(true);
    expect(isRecordedFailure(buildError.message)).toBe(true);
    // A real hit, as a real build reports it, contaminates nothing.
    const results = {
      failures: [{ kind: "test", where: "build", messages: [buildError.message] }],
    };
    expect(unrelatedFailures({ exitCode: 1, results })).toStrictEqual([]);
  });

  /**
   * **Every one of these ends a line the way the recorded line ends**, so the log classifier —
   * rightly, and unchanged — calls the run a hit. None of them *is* the recorded failure, and an
   * end-anchored match exempted all of them from contaminating it (shown in review: `rebuild
   * failed: <signature>` was a clean hit and reached Fisher).
   */
  it.each([
    ["an arbitrary prefix", `rebuild failed: ${SIGNATURE}`, "signature"],
    [
      "the same failure relabelled at another stage",
      new BuildError("contours", surfaceError).message,
      "signature",
    ],
    ["the production prefix twice over", new BuildError("tiles", buildError).message, "signature"],
    ["the signature on a later line", `cleanup failed after:\n${SIGNATURE}`, "signature"],
    [
      "the production form on a later line",
      `cleanup failed after:\n${buildError.message}`,
      "signature",
    ],
    ["leading whitespace", ` ${SIGNATURE}`, "signature"],
    // Not even a logged hit: the line no longer ends where the recorded one ends.
    ["trailing text", `${SIGNATURE} (again)`, "other"],
  ])("refuses %s as the recorded failure", (_, message, logged) => {
    expect(isRecordedFailure(message)).toBe(false);
    // The log classifier is unchanged, and for most of these it says hit — which is the point:
    // the hit is kept, and the error still contaminates the run it is in.
    expect(classifyRun({ exitCode: 1, output: `Error: ${message}\n` })).toBe(logged);

    const results = { failures: [{ kind: "test", where: "somewhere", messages: [message] }] };
    expect(unrelatedFailures({ exitCode: 1, results })).toHaveLength(1);
  });

  it("says why, when an error only carries the line", () => {
    const results = {
      failures: [{ kind: "test", where: "somewhere", messages: [`rebuild failed: ${SIGNATURE}`] }],
    };
    expect(unrelatedFailures({ exitCode: 1, results })).toStrictEqual([
      "somewhere — carries the signature line, but is not the recorded failure",
    ]);
  });
});
