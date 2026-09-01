// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";

import { RenderNeverSettledError, pngSize, settleRender } from "./fixtures/rendered.js";

/**
 * The settled-render oracle, tested against something that actually changes.
 *
 * **Why not against the map.** On this machine, with archives served from localhost, `/lab` is
 * already fully painted by the time the first capture is taken: the wait returns at its minimum
 * and never observes a change. Setting `stableCaptures` to 1 leaves every map test green — so
 * the map cannot show that this loop works, and a loop nothing exercises is decoration.
 *
 * Its job there is to keep the *next* increment's pixel differential deterministic on a slower
 * machine or in CI, where paint does lag the canvas. That job is real, so it is verified here,
 * against a page whose settling time is known because this file decides it.
 */

/** No server needed: these pages are their own fixture. */
const CHANGING_PAGE = `
  <style>body { margin: 0 } #box { width: 200px; height: 120px; background: #000 }</style>
  <div id="box"></div>
  <script>
    const box = document.getElementById("box");
    let n = 0;
    const timer = setInterval(() => {
      n += 1;
      box.style.background = "rgb(" + (n * 37) % 256 + ", 40, 90)";
      if (n >= STOP_AFTER) clearInterval(timer);
    }, 100);
  </script>
`;

/** Milliseconds the box keeps changing, given a tick every 100 ms. */
const CHANGE_FOR_MS = 2_000;

test("waits while the element is still changing, and returns what it settled on", async ({
  page,
}) => {
  // The window is chosen so the loop cannot reach three identical captures early: at a capture
  // every 150 ms against a repaint every 100 ms, roughly a dozen captures pass before the box
  // stops. If the loop returned on its first pair — the shape the map tests cannot distinguish —
  // `captures` would be 2 and the image would be a colour from the middle of the sequence.
  await page.setContent(CHANGING_PAGE.replace("STOP_AFTER", String(CHANGE_FOR_MS / 100)));

  const box = page.locator("#box");
  const settled = await settleRender(box, { intervalMs: 150 });

  expect(settled.captures, "returned before the box stopped changing").toBeGreaterThan(5);
  expect(settled.elapsedMs).toBeGreaterThanOrEqual(CHANGE_FOR_MS);
  // What it returned is the *final* state, not merely a stable-looking one: the box has stopped,
  // so a capture taken now must equal the one the wait ended on.
  expect(settled.image.equals(await box.screenshot())).toBe(true);
  expect(pngSize(settled.image)).toEqual({ width: 200, height: 120 });
});

test("stops at exactly the run it was asked for, on a page that never changes", async ({
  page,
}) => {
  // Pins the counter's meaning: `stableCaptures` is the length of the identical run *including*
  // the capture that started it. Nothing else observes this — the map tests would pass with an
  // off-by-one, taking one extra capture and asserting nothing about how many.
  await page.setContent(`<style>body{margin:0}#box{width:80px;height:40px;background:#123}</style>
    <div id="box"></div>`);

  const settled = await settleRender(page.locator("#box"), { stableCaptures: 4, intervalMs: 20 });

  expect(settled.captures).toBe(4);
});

test("uses a run of three by default, which is what the map tests get", async ({ page }) => {
  // The default was unobserved: every test above passes `stableCaptures` explicitly, and the map
  // tests that rely on the default assert nothing about how many captures it took. Lowering the
  // default therefore changed nothing anywhere — a constant no test could see.
  await page.setContent(`<style>body{margin:0}#box{width:80px;height:40px;background:#456}</style>
    <div id="box"></div>`);

  const settled = await settleRender(page.locator("#box"), { intervalMs: 20 });

  expect(settled.captures).toBe(3);
});

test("counts only consecutive identical captures, not identical ones in total", async ({
  page,
}) => {
  // **A run, not a tally.** Without the reset, matches accumulate across changes: two identical
  // captures here, two there, and the wait ends in the middle of a sequence that is still
  // moving. Each colour below lasts long enough to be captured several times but not long
  // enough to be a legitimate run of eight, so a tally reaches eight within the first couple of
  // colours while a run cannot be completed until the page stops.
  const HOLD_MS = 200;
  const CHANGES_FOR_MS = 2_000;
  await page.setContent(`
    <style>body{margin:0}#box{width:120px;height:60px;background:#000}</style>
    <div id="box"></div>
    <script>
      const box = document.getElementById("box");
      let n = 0;
      const timer = setInterval(() => {
        n += 1;
        box.style.background = "rgb(" + ((n * 61) % 256) + ", 20, 200)";
        if (n * ${String(HOLD_MS)} >= ${String(CHANGES_FOR_MS)}) clearInterval(timer);
      }, ${String(HOLD_MS)});
    </script>
  `);

  const box = page.locator("#box");
  const settled = await settleRender(box, { stableCaptures: 8, intervalMs: 20 });

  expect(settled.elapsedMs, "ended while the page was still changing").toBeGreaterThanOrEqual(
    CHANGES_FOR_MS,
  );
  expect(settled.image.equals(await box.screenshot()), "settled on an intermediate state").toBe(
    true,
  );
});

test("refuses to hand back a capture from a page that never settles", async ({ page }) => {
  // **Throwing, not returning the last capture.** A "settled" render that never settled makes
  // every assertion downstream meaningless while looking exactly like evidence, and nothing in
  // the return value would let a caller tell the two apart.
  await page.setContent(CHANGING_PAGE.replace("STOP_AFTER", String(Number.MAX_SAFE_INTEGER)));

  await expect(
    settleRender(page.locator("#box"), { intervalMs: 100, timeoutMs: 1_500 }),
  ).rejects.toThrow(RenderNeverSettledError);
});

test("reads a capture's dimensions, and refuses bytes that are not an image", async () => {
  // `pngSize` exists so a comparison can say two captures differ in *content*. Handed something
  // that is not a PNG it must fail rather than return a plausible-looking size from whatever
  // happens to sit at bytes 16 and 20.
  expect(() => pngSize(Buffer.from("not a png at all, but long enough"))).toThrow(/not a PNG/);
});
