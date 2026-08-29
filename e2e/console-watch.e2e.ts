// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";

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

test("reports an error nobody declared", async ({ page }) => {
  await page.goto("/");
  const watch = watchConsole(page);

  await page.evaluate(() => {
    console.error("a defect nobody declared");
  });

  expect(watch.problems()).toEqual(["unexpected console error: a defect nobody declared"]);
});

test("reports a declared error that never arrives", async ({ page }) => {
  // The case that separates an expectation from a suppression. A declaration that merely
  // permitted its error would let a test claiming "this error proves the code ran" pass in
  // exactly the case it exists to rule out — the code never running, so no error at all.
  await page.goto("/");
  const watch = watchConsole(page);

  watch.expect(/never happens/, "something that will not occur");

  expect(watch.satisfied()).toBe(false);
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

  await page.evaluate(() => {
    console.error("expected trouble happened");
  });

  expect(watch.satisfied()).toBe(true);
  expect(watch.problems()).toEqual([]);

  await page.evaluate(() => {
    console.error("something else entirely");
  });

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

test("a counted expectation is satisfied only at its count", async ({ page }) => {
  // The distinction a polling test depends on. Treating the first match as enough would let
  // it stop in the middle of the chain it is waiting on, and whether the rest arrived before
  // teardown would decide the result — passing or failing on timing rather than behaviour.
  await page.goto("/");
  const watch = watchConsole(page);
  watch.expect(/tile/, "two tiles fail", 2);

  expect(watch.satisfied()).toBe(false);

  await page.evaluate(() => {
    console.error("tile 1 failed");
  });
  expect(watch.satisfied()).toBe(false);

  await page.evaluate(() => {
    console.error("tile 2 failed");
  });
  expect(watch.satisfied()).toBe(true);
  expect(watch.problems()).toEqual([]);

  // And past it, unsatisfied again: "exactly two" is not "two or more".
  await page.evaluate(() => {
    console.error("tile 3 failed");
  });
  expect(watch.satisfied()).toBe(false);
});

test("does not let a late declaration excuse an error already seen", async ({ page }) => {
  // Otherwise a test could discover an error and retroactively declare it away, which is
  // suppression wearing an expectation's clothes.
  await page.goto("/");
  const watch = watchConsole(page);

  await page.evaluate(() => {
    console.error("happened first");
  });
  watch.expect(/happened first/, "declared too late to count");

  expect(watch.problems()).toContain("unexpected console error: happened first");
});
