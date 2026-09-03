// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

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

/**
 * T5.3 increment 2 — the photo path, in a real browser.
 *
 * The file is supplied through an armed `filechooser` opened by **activating the visible
 * capture affordance**, never through `setInputFiles` on the element. That distinction is the
 * point: `setInputFiles` writes the input's files directly, so a capture button wired to
 * nothing at all would still pass. Here, removing the activation wiring fails before
 * persistence is ever reached.
 *
 * No physical-camera claim is made or possible: `capture` requests a preferred facing mode
 * (W3C html-media-capture) and Chromium under test has no camera.
 */
const PHOTO = {
  name: "field-shot.jpg",
  mimeType: "image/jpeg",
  buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]),
};

/** Open the picker by activating the affordance, and answer it with the fixture. */
async function captureThroughChooser(page: Page): Promise<void> {
  const chooser = page.waitForEvent("filechooser");
  await page.locator(".mapatlas-composer-photo").click();
  await (await chooser).setFiles(PHOTO);
}

test("a photo chosen through the picker survives into storage as the same bytes", async ({
  page,
}) => {
  await page.evaluate(() => window.composer.setup({ persist: true, occurredAt: 9 }));
  await captureThroughChooser(page);

  // The preview proves the selection reached the component, not merely the input element.
  await expect(page.locator(".mapatlas-composer-preview")).toBeVisible();
  await page.locator(".mapatlas-composer-save").click();

  await expect.poll(() => page.evaluate(() => window.composer.persistedId)).toBe("evt-1");
  const stored = await page.evaluate(async () => {
    const id = window.composer.persistedId;
    if (id === undefined) return null;
    const event = await window.composer.readEvent(id);
    const key = event?.media?.[0]?.blobKey;
    if (key === undefined) return null;
    return { mime: event?.media?.[0]?.mime, bytes: await window.composer.readBlob(key) };
  });

  expect(stored?.mime).toBe("image/jpeg");
  expect(
    stored?.bytes,
    "the bytes read back from IndexedDB are not the bytes that were selected",
  ).toEqual([...PHOTO.buffer]);
});

test("photo mode makes capture the initially active control; comment mode does not", async ({
  page,
}) => {
  await page.evaluate(() => window.composer.setup({ mode: "photo" }));
  await expect
    .poll(() => page.evaluate(() => window.composer.activeClass()))
    .toContain("mapatlas-composer-photo");
  expect(
    await page.locator(".mapatlas-composer-photo").getAttribute("capture"),
    "photo mode should request a facing mode",
  ).toBe("environment");

  await page.evaluate(() => window.composer.setup({ mode: "comment" }));
  await expect
    .poll(() => page.evaluate(() => window.composer.activeClass()))
    .toContain("mapatlas-composer-comment");
  // `mode` moved the focus and nothing else: the camera preference is still requested, so a
  // comment-first composition that later adds a photo is not quietly downgraded.
  expect(
    await page.locator(".mapatlas-composer-photo").getAttribute("capture"),
    "comment mode dropped the facing-mode request",
  ).toBe("environment");
});

test("removing the photo returns the composition to the photo-free path", async ({ page }) => {
  await page.evaluate(() => window.composer.setup({ persist: true, occurredAt: 9 }));
  await captureThroughChooser(page);
  await expect(page.locator(".mapatlas-composer-preview")).toBeVisible();

  await page.locator(".mapatlas-composer-photo-remove").click();
  await expect(page.locator(".mapatlas-composer-preview")).toHaveCount(0);

  await page.locator(".mapatlas-composer-save").click();
  await expect.poll(() => page.evaluate(() => window.composer.saves.length)).toBe(1);
  const media = await page.evaluate(() => window.composer.saves[0]?.media);
  expect(media, "a removed photo still reached the handoff").toEqual([]);
});
