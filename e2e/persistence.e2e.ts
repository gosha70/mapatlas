// SPDX-License-Identifier: Apache-2.0
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

import { consoleFor, watchConsole } from "./fixtures/browser.js";

/**
 * The persistence control, wired to a real browser (T6.2).
 *
 * **What the unit lane cannot see, and this can.** That the control is on the page a consumer
 * lands on, that it is a real button a keyboard can operate, and that activating it reaches
 * `navigator.storage` at all. The unit lane drives an injected seam and can invoke a handler no
 * real click could ever reach.
 *
 * **What neither lane may assert: that the browser grants persistence.** Chromium decides on
 * engagement heuristics, silently, so a test expecting `true` would pass or fail for reasons
 * that have nothing to do with this code — and would read, when it passed, as evidence that
 * persistence works. What is asserted is *when* the native call happens and *how many times*,
 * plus that the UI lands on one of the two answers the browser is allowed to give.
 */

const DEMO = "http://127.0.0.1:5175";

/**
 * Count the native call by **wrapping and forwarding** it.
 *
 * The original is called and its result returned, so Chromium still decides and nothing is
 * faked. Merely reading back whatever the UI displayed would pass just as well against a control
 * that hard-coded an outcome and never touched `navigator.storage` — that is the hole this
 * closes, and it is why the counter lives at the platform call rather than in the page's own
 * state.
 *
 * Installed with `addInitScript` so it is in place before any of the demo's own code runs; a
 * wrapper applied after load could miss a call made during bootstrap, which is precisely the
 * call this test exists to prove does not happen.
 */
const COUNT_PERSIST = `
  window.__persistCalls = 0;
  if (navigator.storage && typeof navigator.storage.persist === "function") {
    const original = navigator.storage.persist.bind(navigator.storage);
    navigator.storage.persist = function () {
      window.__persistCalls += 1;
      return original();
    };
  }
`;

const persistCalls = (page: Page): Promise<number> =>
  page.evaluate(() => (window as unknown as { __persistCalls: number }).__persistCalls);

test.beforeEach(async ({ page }) => {
  watchConsole(page);
  await page.addInitScript(COUNT_PERSIST);
});

test.afterEach(({ page }) => {
  expect(consoleFor(page).problems()).toEqual([]);
});

test("the control is on the root route, and requests only when a person asks", async ({ page }) => {
  await page.goto(DEMO, { waitUntil: "load" });

  const control = page.locator("#persistence");
  const request = page.locator("#persistence-request");

  // **Waited past `checking`.** The control renders a non-requestable `checking` state until
  // `persisted()` answers, so a test that read the state immediately would be asserting against
  // the interval rather than the answer — and the button it then tried to activate would be the
  // one deliberately withheld.
  await expect(control).toHaveAttribute("data-state", /already-persistent|unpersisted/);

  // **Nothing has been requested.** The documented guidance — never on load, because Firefox
  // prompts — asserted against the platform call rather than against the rendered text.
  expect(await persistCalls(page), "a request was made before any gesture").toBe(0);

  const state = await control.getAttribute("data-state");
  if (state === "already-persistent") {
    // This profile already has persistent storage, so there is nothing to request and the
    // control correctly offers nothing. Skipped rather than forced: driving a request the
    // control is right to withhold would be testing a state that cannot occur.
    await expect(request).toBeHidden();
    test.skip(true, "the browser profile is already persistent; nothing to request");
    return;
  }

  // A real button: reachable by keyboard, and focusable without a tabindex of its own.
  await request.focus();
  await expect(request).toBeFocused();

  // **A real user gesture**, dispatched by the browser rather than by script. `page.keyboard`
  // activates the focused button the way a person would; `element.click()` in the unit lane
  // cannot distinguish a button from a div with a listener.
  await page.keyboard.press("Enter");

  // Exactly one native call. Not "at least one" — Firefox prompts, so a control that fired
  // twice on one activation would prompt twice.
  await expect
    .poll(() => persistCalls(page), { message: "the activation did not reach navigator.storage" })
    .toBe(1);

  // One of the two answers the browser is allowed to give. **Which one is not asserted** — that
  // is Chromium's heuristic, and it is not this code's to determine.
  await expect(control).toHaveAttribute("data-state", /granted|denied/);

  // Recorded, not asserted, so a later run has something to compare against.
  console.log(`persistence outcome on this profile: ${await control.getAttribute("data-state")}`);
});

test("the fixture route is untouched by the control", async ({ page }) => {
  // T6.1's evidence runs through `/lab`, and the control has nothing to do with it. The full
  // scenarios still guard that; this is the cheap direct check that the control did not leak
  // onto the route, which is the way a shared `#app` mount would have gone wrong.
  await page.goto(`${DEMO}/lab`, { waitUntil: "load" });
  await page.waitForSelector('#status[data-assembled="true"], #status[data-failed="true"]', {
    timeout: 120_000,
  });

  await expect(page.locator("#persistence")).toHaveCount(0);
  expect(await persistCalls(page), "/lab requested persistence").toBe(0);
});
