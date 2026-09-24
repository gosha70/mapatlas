// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";

import { consoleFor, watchConsole } from "./fixtures/browser.js";
import { drawThreeVertices, openDemo } from "./fixtures/demo-flow.js";

/**
 * The draft-vertex accessibility contract, against the **shipped composition** (T4.7, clause 10).
 *
 * T4.7 kept two checks of this contract on purpose: the harness proves the engine behaves against
 * a controller built for the test, in isolation, with nothing else on the map; the shipped
 * composition proves a consumer app — assembled from package entry points, with a real source
 * stack and a real draft — did not break that behaviour when it composed everything together. A
 * regression that only appears in the composition would pass the first and fail this one, which
 * is the entire reason for keeping both. `/lab` was the shipped composition when the check was
 * written (`lab-a11y.e2e.ts`); the root app is now (T8.3, row 13), and the draft here is the one
 * a person authors with three clicks, not one the fixture placed.
 *
 * **The same check, and no more.** No accessibility engine is introduced here: adding one would
 * quietly convert a named contract into a standards scan, with a rule-set version and an
 * exceptions policy nobody has scoped. What is asserted is what the harness asserts.
 *
 * And deliberately **not** the engine's keyboard mechanics — the nudge distances, the grab
 * lifecycle, the release paths. Those are the harness page's and the unit lane's, and restating
 * them here would mean two suites going red for one cause.
 */

test.beforeEach(({ page }) => {
  watchConsole(page);
});

test.afterEach(({ page }) => {
  expect(consoleFor(page).problems()).toEqual([]);
});

test("the shipped app keeps draft vertices reachable, named and visibly focused", async ({
  page,
}) => {
  await openDemo(page);
  await page.locator("#author-start").click();
  await expect(page.locator("#authoring-status")).toHaveAttribute("data-points", "0");
  await drawThreeVertices(page);

  const vertices = page.locator("#authoring-map .mapatlas-draft-vertex");
  await expect(vertices).toHaveCount(3);

  // **One tab stop for the whole set, not three.** A roving index is what keeps a draft from
  // costing a keyboard user one Tab per vertex, and it is a property of the composition as much
  // as of the engine — a consumer that re-rendered the draft could lose it.
  await expect(page.locator('#authoring-map .mapatlas-draft-vertex[tabindex="0"]')).toHaveCount(1);

  // An accessible name that says *which* vertex. "Draft vertex" alone would leave a screen
  // reader user with three identical stops and no way to tell where they are.
  for (const [index, name] of ["1 of 3", "2 of 3", "3 of 3"].entries()) {
    await expect(vertices.nth(index)).toHaveAttribute("aria-label", `Draft vertex ${name}`);
  }

  // **Reached through the browser's real tab order**, from the canvas, rather than by calling
  // `.focus()` — which would prove the element is focusable and say nothing about whether a
  // keyboard user can get to it.
  await page.locator("#authoring-map canvas.maplibregl-canvas").focus();
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await page.keyboard.press("Tab");
    if (await vertices.nth(0).evaluate((element) => element === document.activeElement)) break;
  }
  expect(
    await vertices.nth(0).evaluate((element) => element === document.activeElement),
    "no amount of tabbing from the canvas reached the first draft vertex",
  ).toBe(true);

  // A computed focus ring, read from the cascade as it actually resolved. Asserting a class name
  // would pass against a stylesheet the app overrode.
  expect(
    await vertices.nth(0).evaluate((element) => {
      const style = getComputedStyle(element);
      return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth };
    }),
    "the focused vertex has no visible ring in the shipped composition",
  ).toEqual({ outlineStyle: "solid", outlineWidth: "3px" });
});
