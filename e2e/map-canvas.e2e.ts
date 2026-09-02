// SPDX-License-Identifier: Apache-2.0
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

import { consoleFor, serveMapFixtures, watchConsole } from "./fixtures/browser.js";
import { countMask, decodePng, trackMask } from "./fixtures/pixels.js";
import { settleRender } from "./fixtures/rendered.js";

/**
 * T5.2's acceptance criteria against a real map: the public-shaped `<MapCanvas>` with the
 * production controller inside, mounted through real React on the harness page.
 *
 * **Held to the AC and no more.** The track is proven in pixels and the event as a DOM marker —
 * two independent observables, because one pixel oracle certifying both would let either vanish
 * behind the other. Draw-mode toggling is proven as vertex-DOM presence across prop transitions
 * on one persistent root; the keyboard, focus and drag semantics inside a session belong to the
 * controller suite (T4.5/T4.7) and are deliberately not restated here.
 */

const PAGE = "/react.html";

interface CanvasProps {
  sources: unknown[];
  track?: unknown;
  events?: unknown[];
  draft?: unknown[];
  drawMode?: boolean;
  onDraw?: boolean;
}

/** Re-render the persistent root. `onDraw: true` is materialised into handlers on the page. */
async function setProps(page: Page, props: CanvasProps): Promise<void> {
  await page.evaluate((raw) => {
    const next = raw as Record<string, unknown>;
    const withHandlers = { ...next };
    delete withHandlers["onDraw"];
    if (next["onDraw"] === true) {
      withHandlers["onDraw"] = {
        onVertexAdd: () => undefined,
        onVertexMove: () => undefined,
      };
    }
    window.reactCanvas.setProps(withHandlers as never);
  }, props as unknown);
}

const SOURCES = [
  {
    id: "base",
    kind: "raster",
    transport: "template",
    url: "https://tiles.invalid/{z}/{x}/{y}.png",
    attribution: "test tiles",
  },
];

/** A small two-point track near the fixture's raster tiles. */
const TRACK = {
  id: "rc-track",
  startedAt: 1_000,
  status: "finalized",
  origin: "recorded",
  points: [
    { lat: 59.33, lng: 18.06, t: 1_000 },
    { lat: 59.335, lng: 18.07, t: 2_000 },
  ],
  segments: [{ id: "rc-s1", startIndex: 0, endIndex: 1, startedAt: 1_000 }],
};

const EVENT = {
  id: "rc-event-1",
  trackId: "rc-track",
  position: { lat: 59.332, lng: 18.065 },
  occurredAt: 1_500,
  media: [],
  tags: [],
};

const DRAFT = [
  { lat: 59.33, lng: 18.06 },
  { lat: 59.332, lng: 18.064 },
  { lat: 59.334, lng: 18.068 },
];

test.use({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 1 });

test.beforeEach(async ({ page }) => {
  watchConsole(page);
  await serveMapFixtures(page);
  await page.goto(PAGE, { waitUntil: "load" });
});

test.afterEach(({ page }) => {
  expect(consoleFor(page).problems()).toEqual([]);
});

test("renders the track in pixels and the event as a real marker", async ({ page }) => {
  await setProps(page, { sources: SOURCES });
  await page.waitForSelector("#root canvas", { timeout: 30_000 });
  const before = await settleRender(page.locator("#root"));

  await setProps(page, { sources: SOURCES, track: TRACK, events: [EVENT] });
  const after = await settleRender(page.locator("#root"));

  // **The track, in pixels — its own observable.** The blue-excess predicate recognises the
  // engine's line colour across its antialiased edge; the empty-map capture is the control that
  // stops "some pixels are blue-ish" from passing on the basemap alone.
  const beforeInk = countMask(trackMask(decodePng(before.image)));
  const afterInk = countMask(trackMask(decodePng(after.image)));
  expect(beforeInk, "the empty map already carried track-coloured ink").toBe(0);
  expect(afterInk, "the track drew no pixels").toBeGreaterThan(100);

  // **The event, in the DOM — independently.** Marks are accessible DOM elements by design
  // (T4.3/T4.7), so the marker's presence is asserted where a user's tab key would find it,
  // not inferred from the same pixels that just certified the track. The *event* class
  // specifically: `renderTrack` also places start and finish pins, and counting the generic
  // mark class would let the event marker vanish behind them.
  await expect(page.locator("#root .mapatlas-mark--event")).toHaveCount(1);
  await expect(page.locator("#root .mapatlas-mark")).toHaveCount(3); // start + finish + event
});

test("toggling drawMode enters and exits cleanly on one persistent root", async ({ page }) => {
  await setProps(page, { sources: SOURCES, draft: DRAFT });
  await page.waitForSelector("#root canvas", { timeout: 30_000 });
  const rendersAtStart = await page.evaluate(() => window.reactCanvas.renders);

  // The draft is constant throughout: what changes is only the React prop, so what this
  // observes is the component driving enterDrawMode/exit — not a remount, and not the draft.
  await expect(page.locator("#root .mapatlas-draft-vertex")).toHaveCount(0);

  await setProps(page, { sources: SOURCES, draft: DRAFT, drawMode: true, onDraw: true });
  await expect(page.locator("#root .mapatlas-draft-vertex")).toHaveCount(3);

  await setProps(page, { sources: SOURCES, draft: DRAFT, drawMode: false, onDraw: true });
  await expect(page.locator("#root .mapatlas-draft-vertex")).toHaveCount(0);

  // The same root took every render: this was prop reconciliation, not remounting. Two
  // renders after the baseline — the enter and the exit — and still exactly one canvas.
  const rendersAtEnd = await page.evaluate(() => window.reactCanvas.renders);
  expect(rendersAtEnd - rendersAtStart).toBe(2);
  await expect(page.locator("#root canvas")).toHaveCount(1);
});
