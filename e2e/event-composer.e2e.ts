// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";

import { consoleFor, watchConsole } from "./fixtures/browser.js";

/**
 * T5.3's numeric boundary under the real number-input contract
 * (https://html.spec.whatwg.org/multipage/input.html#number-state-(type=number)).
 *
 * These legs are here rather than in happy-dom because happy-dom's number validity is a
 * regex, not the contract's finite-double parse: it rejects finite `"1e2"` and admits
 * spellings whose parse is non-finite, so it can prove neither the grammar's positive cases
 * nor the `badInput` gate the composer's number handling relies on. Chromium implements the
 * contract — `badInput` for exactly the strings whose parse is not a finite double — which is
 * what keeps `fields` inside `JSONValue` with no composer-side finiteness guard.
 */

const PAGE = "/composer.html";
const NUMBER_FIELD = [{ key: "count", label: "Count", type: "number" as const }];

test.beforeEach(async ({ page }) => {
  watchConsole(page);
  await page.goto(PAGE, { waitUntil: "load" });
});

test.afterEach(({ page }) => {
  expect(consoleFor(page).problems()).toEqual([]);
});

test("a decimal survives Save as the number it is", async ({ page }) => {
  await page.evaluate((fields) => window.composer.setup({ fields, occurredAt: 9 }), NUMBER_FIELD);
  await page.locator('[name="count"]').fill("1.5");
  await page.locator(".mapatlas-composer-save").click();

  const counts = await page.evaluate(() => window.composer.saves.map((s) => s.fields?.["count"]));
  expect(counts, "the decimal must reach onSave as 1.5").toEqual([1.5]);
  expect(await page.evaluate(() => window.composer.storeCalls)).toEqual([]);
});

test("exponent notation is finite and saves as its value — the positive control", async ({
  page,
}) => {
  // happy-dom's regex validity rejects "1e2" outright; the HTML grammar admits it and its
  // parse is 100. A DOM that cannot pass this leg cannot host the overflow leg either — this
  // is the control that proves the lane, not just the test.
  await page.evaluate((fields) => window.composer.setup({ fields, occurredAt: 9 }), NUMBER_FIELD);
  await page.locator('[name="count"]').fill("1e2");
  await page.locator(".mapatlas-composer-save").click();

  const counts = await page.evaluate(() => window.composer.saves.map((s) => s.fields?.["count"]));
  expect(counts, "a grammar-valid exponent must save as its parsed value").toEqual([100]);
});

test("typed overflow cannot hand over a non-finite value; correction permits Save", async ({
  page,
}) => {
  await page.evaluate((fields) => window.composer.setup({ fields, occurredAt: 9 }), NUMBER_FIELD);
  const input = page.locator('[name="count"]');
  await input.click();
  await input.pressSequentially("1e400");
  // Chromium keeps the typed overflow as user-visible editing state while sanitising the
  // DOM-API `.value` to "" — the parse is not a finite double, and `badInput` is the
  // contract-level report that unparseable input is present. Asserting it is the precondition
  // that separates this leg from "typed nothing".
  expect(await input.evaluate((el: HTMLInputElement) => el.validity.badInput)).toBe(true);

  // The gate is the contract's, not the composer's: constraint validation blocks the
  // submission, so Save never runs and nothing — non-finite or otherwise — is handed over.
  await page.locator(".mapatlas-composer-save").click();
  expect(
    await page.evaluate(() => window.composer.saves),
    "the blocked submission handed something over",
  ).toEqual([]);

  await input.fill("2");
  await page.locator(".mapatlas-composer-save").click();
  const counts = await page.evaluate(() => window.composer.saves.map((s) => s.fields?.["count"]));
  expect(counts, "a corrected value must go through on the same instance").toEqual([2]);
});
