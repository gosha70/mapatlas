// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";

import { consoleFor, watchConsole } from "./fixtures/browser.js";

/**
 * The draft-vertex accessibility contract, against the **shipped composition** (T4.7, clause 10).
 *
 * `specs/tasks.md` deferred this deliberately: *"The a11y check runs against the browser harness
 * page, not the demo shell. The demo shell is T4.6's `/lab` route, and T4.6 waits on the region
 * input… T4.6 re-runs the same check against `/lab` when it exists."* It exists, so here it is.
 *
 * **This does not replace the harness check, and the two are not redundant.** The harness page
 * proves the engine behaves against a controller built for the test, in isolation, with nothing
 * else on the map. This proves a consumer app — assembled from package entry points, with a real
 * source stack, a recorder-produced track and marks already on it — did not break that behaviour
 * when it composed everything together. A regression that only appears in the composition would
 * pass the first and fail this one, which is the entire reason for keeping both.
 *
 * **The same check, and no more.** No accessibility engine is introduced here: adding one would
 * quietly convert a named contract into a standards scan, with a rule-set version and an
 * exceptions policy nobody has scoped. What is asserted is what the harness asserts.
 *
 * And deliberately **not** the engine's keyboard mechanics — the nudge distances, the grab
 * lifecycle, the release paths. Those are the harness page's and the unit lane's, and restating
 * them here would mean two suites going red for one cause.
 */

const DEMO = "http://127.0.0.1:5175";
/** Marks off: they are DOM overlays, and this check is about the draft's own tab stops. */
const DRAW_URL = `${DEMO}/lab?draw=on&marks=off`;

test.beforeEach(({ page }) => {
  watchConsole(page);
});

test.afterEach(({ page }) => {
  expect(consoleFor(page).problems()).toEqual([]);
});

test("the shipped /lab keeps draft vertices reachable, named and visibly focused", async ({
  page,
}) => {
  await page.goto(DRAW_URL, { waitUntil: "load" });
  await page.waitForSelector('#status[data-assembled="true"]', { timeout: 120_000 });

  const vertices = page.locator(".mapatlas-draft-vertex");
  await expect(vertices).toHaveCount(3);

  // **One tab stop for the whole set, not three.** A roving index is what keeps a draft from
  // costing a keyboard user one Tab per vertex, and it is a property of the composition as much
  // as of the engine — a consumer that re-rendered the draft could lose it.
  await expect(page.locator('.mapatlas-draft-vertex[tabindex="0"]')).toHaveCount(1);

  // An accessible name that says *which* vertex. "Draft vertex" alone would leave a screen
  // reader user with three identical stops and no way to tell where they are.
  for (const [index, name] of ["1 of 3", "2 of 3", "3 of 3"].entries()) {
    await expect(vertices.nth(index)).toHaveAttribute("aria-label", `Draft vertex ${name}`);
  }

  // **Reached through the browser's real tab order**, from the canvas, rather than by calling
  // `.focus()` — which would prove the element is focusable and say nothing about whether a
  // keyboard user can get to it.
  await page.locator("canvas.maplibregl-canvas").focus();
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
