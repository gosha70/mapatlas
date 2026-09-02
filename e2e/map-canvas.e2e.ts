// SPDX-License-Identifier: Apache-2.0
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

import { consoleFor, serveMapFixtures, watchConsole } from "./fixtures/browser.js";
import { countMask, decodePng, difference, trackMask } from "./fixtures/pixels.js";
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
  style?: unknown;
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

/**
 * The camera comes from the style, because §9 gives `MapCanvas` no camera props.
 *
 * Without it MapLibre sits at zoom 0, where this track is sub-pixel — and the pixel oracle's
 * first honest run proved exactly that: with marks hidden, the "track" contributed **zero**
 * pixels, because the 295 counted before were the event dot and the finish pin, DOM elements
 * visible at any zoom. The line only exists on screen when the camera can resolve it.
 */
const STYLE = {
  version: 8,
  center: [18.065, 59.3325],
  zoom: 13,
  sources: {},
  layers: [{ id: "bg", type: "background", paint: { "background-color": "#eceff1" } }],
};

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

test("renders the track in pixels and the event as a real marker", async ({ page }, testInfo) => {
  await setProps(page, { sources: SOURCES, style: STYLE });
  await page.waitForSelector("#root canvas", { timeout: 30_000 });
  // **Marks are hidden for the pixel captures, and only there.** The event mark is the track's
  // exact blue and the finish pin's purple also clears the blue-excess threshold, so marker ink
  // can satisfy the differential with the stroke invisible — measured: suppressing only the
  // line's opacity left `added > 100` green on marker pixels alone. `visibility: hidden` keeps
  // the elements in the DOM, so the marker assertions below still verify them independently —
  // the two observables stay two.
  const hideMarks = await page.addStyleTag({ content: ".mapatlas-mark { visibility: hidden; }" });
  const before = await settleRender(page.locator("#root"));
  // **Attached immediately, before anything else can fail.** This test's empty-map control
  // failed on Linux CI with 103 blue-excess pixels macOS never showed — and the capture whose
  // mask produced that number was not retained anywhere: Playwright's failure screenshot is a
  // later viewport composite, and the trace holds only JPEG frames. Element screenshots
  // composite DOM overlays over the canvas, so cropping to the canvas isolates nothing;
  // retaining the exact PNGs is what turns the next platform failure from a guess into a look.
  await testInfo.attach("empty-map", { body: before.image, contentType: "image/png" });

  let after;
  try {
    await setProps(page, { sources: SOURCES, style: STYLE, track: TRACK, events: [EVENT] });
    after = await settleRender(page.locator("#root"));
    await testInfo.attach("with-track", { body: after.image, contentType: "image/png" });
  } finally {
    // **Restored before the marker assertions, or "hidden during pixel captures only" is a
    // lie.** With the stylesheet left in place, both count assertions pass against invisible
    // markers and the event-rendering claim is never verified — the first version did exactly
    // that. The visibility assertion below is what fails if this removal is ever dropped.
    await hideMarks.evaluate((tag) => (tag as HTMLStyleElement).remove());
  }

  // **The track, in pixels — differentially.** The empty-map capture is the control, and the
  // comparison is the *difference* of the two masks rather than an absolute count on either:
  // the Linux run proved the attribution overlay's subpixel text antialiasing carries
  // blue-excess fringes (103 px on CI, 0 on macOS), and those fringes are identical in both
  // captures, so subtraction cancels them exactly — same glyphs, same positions — while a
  // basemap that was already blue still cannot satisfy "the track added ink".
  const beforeImg = decodePng(before.image);
  const afterImg = decodePng(after.image);
  // Same box, or the subtraction compares different framings and means nothing.
  expect({ w: afterImg.width, h: afterImg.height }).toEqual({
    w: beforeImg.width,
    h: beforeImg.height,
  });
  const added = countMask(difference(trackMask(afterImg), trackMask(beforeImg)));
  expect(added, "the track added no pixels the empty map lacked").toBeGreaterThan(100);

  // **The event, in the DOM — independently.** Marks are accessible DOM elements by design
  // (T4.3/T4.7), so the marker's presence is asserted where a user's tab key would find it,
  // not inferred from the same pixels that just certified the track. The *event* class
  // specifically: `renderTrack` also places start and finish pins, and counting the generic
  // mark class would let the event marker vanish behind them.
  await expect(page.locator("#root .mapatlas-mark--event")).toHaveCount(1);
  await expect(
    page.locator("#root .mapatlas-mark--event"),
    "the event mark is not visible",
  ).toBeVisible();
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
