// SPDX-License-Identifier: Apache-2.0
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  OUTPUT_DIR,
  REPORT_FILE,
  REQUIRED_OUTPUTS,
  TRANSCRIPT_FILE,
  appendStepSummary,
  missingOutputs,
  openTranscript,
  writeReport,
} from "./probe-output.mjs";

/**
 * The probe's durable output (T8.1, after increment 2e).
 *
 * **What these tests are for.** 2e's dispatch completed with both arms intact and a control that
 * reproduced, and its report could not be read afterwards: it existed only in a job log that
 * GitHub truncated at 114,903 bytes, mid-word, after run 1 of 300. Nothing here changes a
 * measurement — every assertion below is about whether the result still exists to be read.
 */

let root;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "probe-output-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("the transcript", () => {
  /**
   * **Falsifier: buffering.** The transcript is on disk as the loop runs, so a probe **process**
   * that crashes or exits non-zero leaves everything it reached for the `if: always()` upload to
   * preserve. A buffered writer flushed at the end would lose all of it in exactly those cases,
   * and would have lost nothing *visible* in a passing test — which is why this reads the file
   * back mid-stream rather than at the end.
   *
   * It does **not** survive a job timeout: that kills the job, no upload step runs, and the
   * runner is ephemeral. Nothing here claims otherwise.
   */
  it("is on disk after each append, not at the end", () => {
    const transcript = openTranscript(root);

    transcript.append("run 1/300 [default 1/150]: signature (17.4s)");
    expect(readFileSync(transcript.path, "utf8")).toMatch(/run 1\/300 .* signature/);

    transcript.append("run 2/300 [no-opt 1/150]: passed (11.9s)");
    const afterTwo = readFileSync(transcript.path, "utf8");
    expect(afterTwo).toMatch(/run 1\/300/);
    expect(afterTwo).toMatch(/run 2\/300/);
  });

  it("writes where the workflow uploads from", () => {
    const transcript = openTranscript(root);
    expect(transcript.path).toBe(join(root, OUTPUT_DIR, TRANSCRIPT_FILE));
  });

  /** A hit's full output is multi-line; a line-oriented appender must not mangle or drop it. */
  it("keeps a hit's whole output, newlines and all", () => {
    const transcript = openTranscript(root);
    const output = "===== run 1 =====\nBuildError: ...\n  at cropFor\n===== end =====";

    transcript.append(output);

    expect(readFileSync(transcript.path, "utf8")).toBe(`${output}\n`);
  });

  it("does not append to a previous job's transcript", () => {
    const first = openTranscript(root);
    first.append("a previous run");

    const second = openTranscript(root);
    second.append("this run");

    expect(readFileSync(second.path, "utf8")).toBe("this run\n");
  });
});

describe("the report", () => {
  it("writes the verdict where the workflow uploads from", () => {
    const path = writeReport(root, ["--- T8.1 runtime-mode result ---", "DIFFERS: ..."]);

    expect(path).toBe(join(root, OUTPUT_DIR, REPORT_FILE));
    expect(readFileSync(path, "utf8")).toBe("--- T8.1 runtime-mode result ---\nDIFFERS: ...\n");
  });

  /** It must not need the transcript to have been opened: the two are independent copies. */
  it("creates its directory itself", () => {
    expect(existsSync(join(root, OUTPUT_DIR))).toBe(false);
    writeReport(root, ["x"]);
    expect(existsSync(join(root, OUTPUT_DIR, REPORT_FILE))).toBe(true);
  });
});

describe("the completeness check", () => {
  /**
   * **Falsifier: half the pair passing as a whole one.** The upload step's
   * `if-no-files-found: error` fires on an *empty* directory only, so a probe that wrote its
   * transcript and died before its report uploads an artifact that looks complete and is missing
   * the file a reader opens first. That is this repair's own failure mode arriving one level
   * down, and it is why the check is a step of its own rather than an upload option.
   */
  it("names each missing file, and passes only when both are there", () => {
    expect(missingOutputs(root)).toEqual([TRANSCRIPT_FILE, REPORT_FILE]);

    openTranscript(root);
    expect(missingOutputs(root), "a transcript alone must not read as complete").toEqual([
      REPORT_FILE,
    ]);

    writeReport(root, ["DIFFERS: ..."]);
    expect(missingOutputs(root)).toEqual([]);
  });

  /** The other half, so the check is not accidentally testing only one order of arrival. */
  it("catches a report without a transcript too", () => {
    writeReport(root, ["DIFFERS: ..."]);
    expect(missingOutputs(root)).toEqual([TRANSCRIPT_FILE]);
  });

  it("requires exactly the two files the runner writes", () => {
    expect(REQUIRED_OUTPUTS).toEqual([TRANSCRIPT_FILE, REPORT_FILE]);
  });
});

describe("the job summary", () => {
  it("appends the report to the summary file GitHub names", () => {
    const summary = join(root, "summary.md");
    writeFileSync(summary, "# existing\n");

    const result = appendStepSummary(["DIFFERS: ..."], { GITHUB_STEP_SUMMARY: summary });

    expect(result.written).toBe(true);
    const text = readFileSync(summary, "utf8");
    expect(text).toMatch(/# existing/);
    expect(text).toMatch(/DIFFERS/);
  });

  /**
   * **Best effort, and it must stay that way.** The summary is a convenience; the artifact is the
   * durable copy. A throw here would take down a job that has already spent 90 minutes and
   * written both its files — trading the whole result for a cosmetic channel.
   */
  it("reports rather than throws when there is no summary to write to", () => {
    expect(appendStepSummary(["x"], {})).toMatchObject({ written: false });
    expect(appendStepSummary(["x"], { GITHUB_STEP_SUMMARY: "" })).toMatchObject({ written: false });

    const unwritable = join(root, "no", "such", "dir", "summary.md");
    const result = appendStepSummary(["x"], { GITHUB_STEP_SUMMARY: unwritable });
    expect(result.written).toBe(false);
    expect(result.reason).toBeTruthy();
  });
});

describe("the runner actually uses both durable paths", () => {
  const runner = readFileSync(new URL("./run-flake-probe.mjs", import.meta.url), "utf8");

  /**
   * **Read from the source, and the limits of that are stated rather than glossed.** The runner
   * is a top-level script that spawns 300 real Vitest runs; nothing can import it without
   * starting one. So these assertions read the file, the same bargain `workflow-triggers.mjs`
   * makes with YAML — structure, not behaviour.
   *
   * What they prove: both durable paths are wired in, and in the order that makes them durable.
   * What they cannot prove: that the writes succeed. `probe-output.test.mjs`'s other describes
   * cover that, against a real temporary directory. The pair is the coverage; neither half is.
   *
   * **This is the check that would have caught increment 2e's loss** — not by noticing a bad
   * value, but by noticing there was nowhere for the value to go.
   */
  it("opens the transcript before the loop and writes the report before it exits", () => {
    const openedAt = runner.indexOf("openTranscript(");
    const loopAt = runner.indexOf("runExperiment(");
    const reportAt = runner.indexOf("writeReport(");
    const summaryAt = runner.indexOf("appendStepSummary(");
    const exitAt = runner.lastIndexOf("process.exit(");

    expect(openedAt, "the runner never opens a transcript").toBeGreaterThanOrEqual(0);
    expect(reportAt, "the runner never writes the report to a file").toBeGreaterThanOrEqual(0);
    expect(summaryAt, "the runner never appends to the job summary").toBeGreaterThanOrEqual(0);

    // Before the loop: a transcript opened afterwards would hold nothing when the process dies
    // part-way, which is the case the `always()` upload exists to catch.
    expect(openedAt, "the transcript is opened after the loop it is meant to record").toBeLessThan(
      loopAt,
    );

    // Before the exit: there is no after.
    expect(reportAt, "the report is written after the process exits").toBeLessThan(exitAt);
    expect(summaryAt, "the summary is appended after the process exits").toBeLessThan(exitAt);
  });

  /**
   * **Falsifier: the loop printing only to the console again.** Every line the loop emits goes
   * through the tee. A `console.log` reintroduced inside `runSuite` or `onRun` would be invisible
   * in the artifact and present in the log — which is the asymmetry that lost 2e.
   */
  it("routes the loop's own output through the tee, not the console", () => {
    const loop = runner.slice(runner.indexOf("runExperiment("), runner.lastIndexOf("const result"));

    expect(loop).not.toMatch(/console\.log/);
    expect(loop).toMatch(/say\(/);
  });
});
