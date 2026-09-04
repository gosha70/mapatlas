// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { consoleFor, fixturePng, serveMapFixtures, watchConsole } from "./fixtures/browser.js";

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
/**
 * The live marker's position **relative to a static track mark**.
 *
 * Absolute screen coordinates are the wrong oracle here: MapLibre renders continuously and the
 * viewport is still settling, so a stationary marker's box moves — an earlier version of the
 * pause test measured 132 px of "travel" for a marker that had not moved at all. `settleRender`
 * does not help either; the map never stops changing, so it times out. The start mark is a DOM
 * marker at a fixed coordinate, so any viewport motion moves both equally and the *difference*
 * cancels it out.
 */
async function liveOffset(page: Page): Promise<{ x: number; y: number }> {
  const live = await page.locator(".mapatlas-mark--live").boundingBox();
  const anchor = await page.locator(".mapatlas-mark--start").boundingBox();
  if (live === null) throw new Error("no live marker on the map");
  if (anchor === null) throw new Error("no start mark to measure against");
  return { x: live.x - anchor.x, y: live.y - anchor.y };
}

/** `liveOffset` once the projection has stopped moving under it. */
async function settledOffset(page: Page): Promise<{ x: number; y: number }> {
  let previous = await liveOffset(page);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await page.waitForTimeout(100);
    const current = await liveOffset(page);
    if (current.x === previous.x && current.y === previous.y) return current;
    previous = current;
  }
  throw new Error("the map projection never settled");
}

const PHOTO = {
  name: "field-shot.jpg",
  mimeType: "image/jpeg",
  // A real, decodable PNG — the same one the tile fixtures serve. The first version of this
  // was a PNG signature followed by four arbitrary bytes, which round-trips through storage
  // perfectly and renders as a zero-sized broken image, so `toBeVisible` failed on a fixture
  // defect rather than on the component.
  buffer: fixturePng(),
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

/**
 * T5.3 increment 3 — the egress gate, asserted against the network rather than a fake.
 *
 * The harness analyzer really issues a request when it runs, and the scenario watches the
 * page's requests. "Opening the disclosure sends nothing" is therefore a claim about traffic
 * that left the page, which is the only form of that claim worth making for an egress
 * boundary (ADR-0005).
 */
test("a remote analyzer sends nothing until the disclosure is accepted", async ({ page }) => {
  const requested: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/__analyzer__/")) requested.push(request.url());
  });

  await page.evaluate(() =>
    window.composer.setup({ analyzer: { id: "cloud-vision", runsRemotely: true } }),
  );
  await captureThroughChooser(page);

  // Activating the control opens the disclosure and sends nothing. The egress assertions come
  // first, and after a settle: a negative about asynchronous behaviour asserted immediately
  // would pass because nothing has had time to happen yet, which is indistinguishable from
  // nothing ever happening. This ordering is also what makes a removed gate fail *here*,
  // reporting the photo as sent, rather than further down on a missing panel.
  await page.locator(".mapatlas-composer-analyze").click();
  await page.waitForTimeout(250);
  expect(
    await page.evaluate(() => window.composer.egress),
    "the analyzer ran before the user agreed",
  ).toEqual([]);
  expect(requested, "the photo left the page before the user agreed").toEqual([]);
  await expect(page.locator(".mapatlas-composer-disclosure")).toBeVisible();
  await expect(page.locator(".mapatlas-composer-disclosure")).toContainText("cloud-vision");

  // Declining sends nothing either.
  await page.locator(".mapatlas-composer-disclosure-decline").click();
  await expect(page.locator(".mapatlas-composer-disclosure")).toHaveCount(0);
  await page.waitForTimeout(250);
  expect(requested, "declining still sent the photo").toEqual([]);

  // Only the explicit accept does.
  await page.locator(".mapatlas-composer-analyze").click();
  await page.locator(".mapatlas-composer-disclosure-accept").click();
  await expect(page.locator(".mapatlas-composer-suggestions")).toBeVisible();
  expect(requested).toHaveLength(1);
  expect(requested[0]).toContain("/__analyzer__/cloud-vision");
});

test("a local analyzer runs without a disclosure", async ({ page }) => {
  await page.evaluate(() =>
    window.composer.setup({ analyzer: { id: "on-device", runsRemotely: false } }),
  );
  await captureThroughChooser(page);
  await page.locator(".mapatlas-composer-analyze").click();

  await expect(page.locator(".mapatlas-composer-suggestions")).toBeVisible();
  expect(await page.evaluate(() => window.composer.egress)).toEqual(["/__analyzer__/on-device"]);
  await expect(page.locator(".mapatlas-composer-disclosure")).toHaveCount(0);
});

/**
 * T5.4 increment 3 — the loop closed against one adapter.
 *
 * The composer writes a photo through a real IndexedDB adapter and the consumer persists the
 * event; `TripReview` then mounts over **the same adapter instance** and resolves the same
 * `blobKey` for display. Two adapters would prove only that two stores can hold bytes; the
 * claim under test is that what the composer wrote, the review can show — which is the reason
 * ADR-0028 put a required `store` on `TripReview` in the first place.
 */
test("a photo written by the composer is displayed by the review", async ({ page }) => {
  // The review mounts a real map, so its tiles must be served — see the fixture's note on why
  // ignoring the errors instead is the wrong trade.
  await serveMapFixtures(page);
  await page.evaluate(() => window.composer.setup({ persist: true, occurredAt: 9 }));
  await captureThroughChooser(page);
  await page.locator(".mapatlas-composer-save").click();
  await expect.poll(() => page.evaluate(() => window.composer.persistedId)).toBe("evt-1");

  await page.evaluate(() => window.composer.review("evt-1"));

  const photo = page.locator(".mapatlas-trip-photo-image");
  await expect(photo).toBeVisible();
  // A blob: URL, not the hosted-url path — this went through the store.
  await expect(photo).toHaveAttribute("src", /^blob:/);
  await expect(
    page.locator(".mapatlas-trip-photo-missing"),
    "the review could not resolve what the composer wrote",
  ).toHaveCount(0);

  // And the bytes behind that src are the bytes that were selected.
  const bytes = await page.evaluate(async () => {
    const src = document.querySelector<HTMLImageElement>(".mapatlas-trip-photo-image")?.src ?? "";
    const blob = await (await fetch(src)).blob();
    return [...new Uint8Array(await blob.arrayBuffer())];
  });
  expect(bytes, "the displayed photo is not the photo that was captured").toEqual([
    ...PHOTO.buffer,
  ]);
});

/**
 * T5.5 increment 3 — the marker moves on a real map.
 *
 * The unit lane asserts what was handed to the controller; it cannot say whether MapLibre drew
 * anything. Here the oracle is the marker element's own position on screen, read before and
 * after a scrub — which is only meaningful because MapLibre places live markers as DOM nodes
 * transformed into position rather than as painted pixels.
 */
test("the replay marker moves on the map when the cursor is scrubbed", async ({ page }) => {
  await serveMapFixtures(page);
  await page.evaluate(() => {
    window.composer.replay();
  });

  const scrub = page.locator(".mapatlas-trip-replay-scrub");
  await expect(scrub).toBeVisible();
  // Mounted paused at the first point (ADR-0030), so the cursor starts at the range minimum.
  await expect(scrub).toHaveValue("0");

  const before = await settledOffset(page);

  await scrub.fill("1000");
  await expect(scrub).toHaveValue("1000");
  const after = await settledOffset(page);

  expect(
    Math.abs(after.y - before.y),
    "the marker did not move on screen — the unit lane cannot see this",
  ).toBeGreaterThan(1);
});

test("the replay marker holds still while the cursor crosses a pause", async ({ page }) => {
  // The rule the whole increment exists for, observed where it is actually drawn: between the
  // segments the track has no observation, so the marker must not slide across the gap even
  // though the cursor keeps advancing.
  await serveMapFixtures(page);
  await page.evaluate(() => {
    window.composer.replay();
  });
  const scrub = page.locator(".mapatlas-trip-replay-scrub");
  await expect(scrub).toBeVisible();

  await scrub.fill("2000");
  const inPause = await settledOffset(page);
  await scrub.fill("8000");
  const laterInPause = await settledOffset(page);
  expect(
    { dx: Math.abs(laterInPause.x - inPause.x), dy: Math.abs(laterInPause.y - inPause.y) },
    "the marker travelled through a pause the map draws as empty",
  ).toEqual({ dx: 0, dy: 0 });

  await scrub.fill("9500");
  const afterPause = await settledOffset(page);
  expect(
    Math.abs(afterPause.y - inPause.y),
    "the marker must resume once the next segment begins",
  ).toBeGreaterThan(1);
});
