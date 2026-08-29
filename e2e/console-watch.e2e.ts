// SPDX-License-Identifier: Apache-2.0
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

import type { ConsoleWatch } from "./fixtures/browser.js";
import { watchConsole } from "./fixtures/browser.js";

/**
 * The console watch's own tests.
 *
 * Every map test's honesty rests on this: a watch that quietly permitted anything would turn
 * each declared error from a claim into a silence, and the tests built on it would keep
 * passing while proving less. So the guard is checked independently of the code it guards —
 * the same reason the fake map has its own tests.
 *
 * Deliberately in its own file: these construct their own watches, and the map lane's
 * `afterEach` would assert against them.
 */

/**
 * Emit errors and wait for the watch to have recorded them.
 *
 * Console messages arrive over a different channel from an `evaluate` response, so their
 * ordering relative to it is conventional rather than guaranteed. Reading the watch straight
 * after emitting would make these tests depend on delivery timing — which is precisely what
 * they exist to establish must not happen elsewhere.
 */
async function emit(page: Page, watch: ConsoleWatch, lines: readonly string[]): Promise<void> {
  const before = watch.seen();
  await page.evaluate((toEmit) => {
    for (const line of toEmit) console.error(line);
  }, lines);
  await expect.poll(() => watch.seen()).toBe(before + lines.length);
}

test("reports an error nobody declared", async ({ page }) => {
  await page.goto("/");
  const watch = watchConsole(page);

  await emit(page, watch, ["a defect nobody declared"]);

  expect(watch.problems()).toEqual(["unexpected console error: a defect nobody declared"]);
});

test("reports a declared error that never arrives", async ({ page }) => {
  // The case that separates an expectation from a suppression. A declaration that merely
  // permitted its error would let a test claiming "this error proves the code ran" pass in
  // exactly the case it exists to rule out — the code never running, so no error at all.
  await page.goto("/");
  const watch = watchConsole(page);

  watch.expect(/never happens/, "something that will not occur");

  expect(watch.settled()).toBe(false);
  expect(watch.problems()).toHaveLength(1);
  expect(watch.problems()[0]).toContain("none arrived");
  // The reason travels with the report, since an unexplained pattern is indistinguishable
  // from a silenced defect to whoever reads the failure.
  expect(watch.problems()[0]).toContain("something that will not occur");
});

test("accepts a declared error, and only the declared one", async ({ page }) => {
  await page.goto("/");
  const watch = watchConsole(page);
  watch.expect(/expected trouble/, "the case under test provokes it");

  await emit(page, watch, ["expected trouble happened"]);

  expect(watch.settled()).toBe(true);
  expect(watch.problems()).toEqual([]);

  await emit(page, watch, ["something else entirely"]);

  expect(watch.problems()).toEqual(["unexpected console error: something else entirely"]);
});

test("holds a declaration to an exact count when one is given", async ({ page }) => {
  await page.goto("/");
  const watch = watchConsole(page);
  watch.expect(/tile/, "one tile fails, and only one", 1);

  await page.evaluate(() => {
    console.error("tile 1 failed");
    console.error("tile 2 failed");
  });

  expect(watch.problems()).toHaveLength(1);
  expect(watch.problems()[0]).toContain("saw 2");
});

test("a counted expectation settles at its count, and not before", async ({ page }) => {
  // The distinction a polling test depends on. Treating the first match as enough would let
  // it stop in the middle of the chain it is waiting on, and whether the rest arrived before
  // teardown would decide the result — passing or failing on timing rather than behaviour.
  await page.goto("/");
  const watch = watchConsole(page);
  watch.expect(/tile/, "two tiles fail", 2);

  expect(watch.settled()).toBe(false);

  await emit(page, watch, ["tile 1 failed"]);
  expect(watch.settled()).toBe(false);

  await emit(page, watch, ["tile 2 failed"]);
  expect(watch.settled()).toBe(true);
  expect(watch.problems()).toEqual([]);
});

test("overshoot settles the wait and is reported, rather than waiting for a timeout", async ({
  page,
}) => {
  // Settling and judging are different questions, and this is where they diverge. Equality
  // would look stricter and be worse: past the count it never holds again, so the poll would
  // run to a timeout saying "still waiting" about something that already overshot — a wrong
  // pass traded for an uninformative failure. Settling ends the wait; `problems()` says what
  // actually happened.
  await page.goto("/");
  const watch = watchConsole(page);
  watch.expect(/tile/, "two tiles fail", 2);

  await emit(page, watch, ["tile 1 failed", "tile 2 failed", "tile 3 failed"]);

  expect(watch.settled()).toBe(true);
  expect(watch.problems()).toHaveLength(1);
  expect(watch.problems()[0]).toContain("saw 3");
});

test("settling and judging agree wherever they can, and diverge only on overshoot", async ({
  page,
}) => {
  // Structural rather than remembered: the two predicates are checked against one another
  // over every shape a declaration can be in, so a later change to one that contradicts the
  // other fails here instead of somewhere it would look like a flake.
  await page.goto("/");

  const cases = [
    { errors: 0, count: 2, settled: false, problems: 1, why: "nothing arrived" },
    { errors: 1, count: 2, settled: false, problems: 1, why: "half a chain" },
    { errors: 2, count: 2, settled: true, problems: 0, why: "exactly what was asked for" },
    { errors: 3, count: 2, settled: true, problems: 1, why: "overshoot: settled, and wrong" },
    { errors: 0, count: null, settled: false, problems: 1, why: "uncounted, nothing arrived" },
    { errors: 1, count: null, settled: true, problems: 0, why: "uncounted, one is enough" },
    { errors: 5, count: null, settled: true, problems: 0, why: "uncounted, any number will do" },
  ];

  for (const { errors, count, settled, problems, why } of cases) {
    const watch = watchConsole(page);
    if (count === null) watch.expect(/tile/, why);
    else watch.expect(/tile/, why, count);

    await emit(
      page,
      watch,
      Array.from({ length: errors }, (_, i) => `tile ${String(i)} failed`),
    );

    expect(watch.settled(), why).toBe(settled);
    expect(watch.problems(), why).toHaveLength(problems);
  }
});

test("does not let a late declaration excuse an error already seen", async ({ page }) => {
  // Otherwise a test could discover an error and retroactively declare it away, which is
  // suppression wearing an expectation's clothes.
  await page.goto("/");
  const watch = watchConsole(page);

  await emit(page, watch, ["happened first"]);
  watch.expect(/happened first/, "declared too late to count");

  expect(watch.problems()).toContain("unexpected console error: happened first");
});

test("refuses a pattern whose matching depends on how often it has been used", async ({ page }) => {
  // `test()` on a global or sticky pattern advances `lastIndex`, so the same pattern matches,
  // then misses, then matches. A counted declaration would settle on whichever way the stride
  // fell. Nothing here uses one today, which is exactly why one would be added later without
  // anyone thinking about it — so it is refused rather than coped with.
  await page.goto("/");
  const watch = watchConsole(page);

  expect(() => {
    watch.expect(/tile/g, "a global pattern");
  }).toThrow(/global or sticky/);
  expect(() => {
    watch.expect(/tile/y, "a sticky pattern");
  }).toThrow(/global or sticky/);
  expect(() => {
    watch.expect(/tile/i, "a case-insensitive pattern is fine");
  }).not.toThrow();
});

test("refuses a count that declares an error must not happen", async ({ page }) => {
  // Half-supporting it is worse than not supporting it: zero matches would take the
  // "none arrived, so whatever was supposed to produce it did not run" branch, which is the
  // diagnosis exactly inverted, since that is the success case. And an undeclared error is
  // already a failure, so nothing needs declaring in order to be forbidden.
  await page.goto("/");
  const watch = watchConsole(page);

  expect(() => {
    watch.expect(/tile/, "expect none", 0);
  }).toThrow(/must not happen/);
  expect(() => {
    watch.expect(/tile/, "negative is no better", -1);
  }).toThrow(/must not happen/);
});

test("blames the declaration that absorbed the line, not the code that ran", async ({ page }) => {
  // Declarations are first-match-wins, so a broad one declared first takes the lines a
  // narrower one was waiting for. Reporting that as "none arrived, so whatever was supposed
  // to produce it did not run" accuses code that ran perfectly — the misdiagnosis this whole
  // file exists to prevent, reachable with two declarations in one test.
  await page.goto("/");
  const watch = watchConsole(page);
  watch.expect(/tile/, "the broad one, declared first");
  watch.expect(/tile 2 failed/, "the narrow one, which will absorb nothing");

  await emit(page, watch, ["tile 1 failed", "tile 2 failed"]);

  const problems = watch.problems();
  expect(problems).toHaveLength(1);
  expect(problems[0]).toContain("was declared first and absorbed");
  expect(problems[0]).not.toContain("did not run");
  // And it names both sides, so the fix is obvious from the failure alone.
  expect(problems[0]).toContain("tile 2 failed");
});
