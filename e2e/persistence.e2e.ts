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

test("the root control is laid out, not left to browser defaults", async ({ page }) => {
  // **Presentation, asserted at the two places it actually went wrong.** Not a screenshot
  // golden and not a design system: this checks that a stylesheet reached the control at all,
  // because before this commit nothing did and no test could have noticed. A golden would fail
  // on every deliberate change and tell nobody why.
  await page.goto(DEMO, { waitUntil: "load" });

  const control = page.locator("#persistence");
  await expect(control).toBeVisible();

  const box = await control.boundingBox();
  if (box === null) throw new Error("the control has no layout box");
  const viewport = page.viewportSize();
  if (viewport === null) throw new Error("no viewport to compare against");

  // Not flush-left and not full-bleed: the page has padding and the column has a bounded
  // measure, which is what an unstyled document lacks.
  expect(box.x, "the control is flush against the viewport edge").toBeGreaterThan(8);
  expect(box.width, "the control spans the whole viewport").toBeLessThan(viewport.width - 16);

  // Not the document's serif default. Asserted on `system-ui` rather than against a list of
  // serif names, since "sans-serif" contains "serif" and a negative match on it is a trap.
  const font = await control.evaluate((element) => getComputedStyle(element).fontFamily);
  expect(font, `the control inherited a default font: ${font}`).toMatch(/system-ui/);

  // **The page declares its own background.** This route fixes a near-black text colour, and a
  // foreground without a background is only half a declaration: under forced-dark or a user
  // stylesheet the agent paints its own canvas and the text lands on it — measured as
  // dark-on-dark, with every heading and step title effectively invisible. A transparent body
  // is precisely the state that lets that happen, so it is what this refuses.
  const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(background, "the page declares no background of its own").not.toMatch(
    /^(transparent|rgba\(0, 0, 0, 0\))$/,
  );

  // The button is a real target with visible focus — the background above removes the browser's
  // own outline, so a replacement is not decoration.
  //
  // **Not behind an `if`.** A conditional guard passes silently on any profile where the button
  // happens to be absent, and nothing in the report says whether it ran — the same shape as
  // inferring a precondition instead of asserting it. So the state is waited out first, the one
  // legitimate reason for no button is skipped *visibly*, and everything else asserts.
  await expect(control).not.toHaveAttribute("data-state", "checking");
  if ((await control.getAttribute("data-state")) === "already-persistent") {
    test.skip(
      true,
      "this profile is already persistent, so the control correctly offers no button",
    );
    return;
  }

  const request = page.locator("#persistence-request");
  await expect(request).toBeVisible();
  const outline = await request.evaluate((element) => {
    element.focus();
    const style = getComputedStyle(element);
    return `${style.outlineStyle} ${style.outlineWidth}`;
  });
  expect(outline, "the focused button has no visible outline").not.toMatch(/none|0px/);
});

test("the installation guidance is on the root route, and offers nothing to click", async ({
  page,
}) => {
  // Static text reaching a real page. The unit lane asserts what it claims; this asserts that a
  // reader actually gets it, and that it stayed static — a button here would mean somebody
  // reached for `beforeinstallprompt`, which is Chromium-only and absent on iOS.
  await page.goto(DEMO, { waitUntil: "load" });

  const guidance = page.locator("#install-guidance");
  await expect(guidance).toBeVisible();
  await expect(guidance.locator("ol > li")).toHaveCount(3);
  await expect(guidance.locator("button")).toHaveCount(0);

  // The order, at the page rather than in the data: install first, download last.
  const steps = await guidance.locator("ol > li").allInnerTexts();
  expect(steps[0]).toMatch(/install first/i);
  expect(steps[steps.length - 1]).toMatch(/installed app/i);
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
  await expect(page.locator("#install-guidance")).toHaveCount(0);
  expect(await persistCalls(page), "/lab requested persistence").toBe(0);

  // And the root route's stylesheet cannot reach here: every rule it adds is scoped under this
  // attribute, so its absence is the structural guarantee rather than a promise about selectors.
  await expect(page.locator("body")).not.toHaveAttribute("data-route", "root");
});
