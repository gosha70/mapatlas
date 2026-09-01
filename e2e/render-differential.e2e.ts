// SPDX-License-Identifier: Apache-2.0
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

import { consoleFor, watchConsole } from "./fixtures/browser.js";
import type { Box, Raster } from "./fixtures/pixels.js";
import {
  TRACK_BLUE_EXCESS,
  boundsOf,
  changedMask,
  countIn,
  countMask,
  decodePng,
  difference,
  intersection,
  trackMask,
  union,
} from "./fixtures/pixels.js";
import { mapOf, settleRender } from "./fixtures/rendered.js";

/**
 * What the map draws, as set relations between renders (T4.6).
 *
 * Two claims live here, and they are separate because one cannot carry the other.
 *
 * 1. *The pause is a gap.* The pixels the two-segment render draws are exactly the union of
 *    what each segment draws alone, and a line drawn across the pause — rendered deliberately,
 *    as a control — puts ink where the real render has none.
 * 2. *The hillshade layer draws.* Rendered-state evidence could only show that supplying the
 *    DEM archive changes the image, which the **terrain** it also enables accounts for on its
 *    own. Holding the source and the terrain fixed and removing only the layer is what
 *    separates them.
 */

test.use({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });

const DEMO = "http://127.0.0.1:5175";
const ARCHIVES = "http://127.0.0.1:5176";

/**
 * The pause views: no archives, no marks, camera on the gap.
 *
 * **No basemap, and that is a finding rather than a simplification.** With terrain enabled the
 * camera at z17 sits about 900 m above the map plane while the ground here is over 3,000 m, so
 * it ends up *inside* the mountain and the canvas comes back blank — measured, in white. The
 * pause claim is about the track line, so the stack that makes the gap unreachable is left out
 * and the comparison gets one less variable.
 *
 * **And no marks.** `renderTrack` anchors start and finish pins to the ends of whatever it is
 * given, so rendering one segment puts a finish pin exactly where the pause is. That is the
 * renderer behaving correctly, and it is 176 pixels of purple sitting on the subject.
 */
const pauseView = (segments: string): string =>
  `${DEMO}/lab?marks=off&focus=pause&segments=${segments}`;

/** The full stack, framed on the whole track — where terrain works and hillshade has relief. */
const STACK =
  `${DEMO}/lab?terrain=${encodeURIComponent(`${ARCHIVES}/terrain.pmtiles`)}` +
  `&contours=${encodeURIComponent(`${ARCHIVES}/contours.pmtiles`)}&marks=off`;

async function capture(page: Page, url: string): Promise<Raster> {
  await page.goto(url, { waitUntil: "load" });
  await page.waitForSelector('#status[data-assembled="true"]', { timeout: 120_000 });
  await page.waitForFunction(() => document.querySelectorAll("#map canvas").length > 0, undefined, {
    timeout: 30_000,
  });
  return decodePng((await settleRender(mapOf(page))).image);
}

/** A one-row raster of the given colours, for testing the predicate against known ink. */
function rowOf(colours: readonly (readonly [number, number, number])[]): Raster {
  const data = new Uint8Array(colours.length * 4);
  colours.forEach(([r, g, b], i) => {
    data.set([r, g, b, 255], i * 4);
  });
  return { width: colours.length, height: 1, data };
}

/** `over` blended onto `under` at `alpha`, which is what antialiasing produces. */
function blend(
  over: readonly [number, number, number],
  under: readonly [number, number, number],
  alpha: number,
): [number, number, number] {
  return [0, 1, 2].map((i) => Math.round(over[i]! * alpha + under[i]! * (1 - alpha))) as [
    number,
    number,
    number,
  ];
}

const TRACK_BLUE = [0x09, 0x69, 0xda] as const;
const STYLE_BACKGROUND = [0xec, 0xef, 0xf1] as const;
const CONTOUR_BROWN = [0x79, 0x55, 0x48] as const;

test.beforeEach(({ page }) => {
  watchConsole(page);
});

test.afterEach(({ page }) => {
  expect(consoleFor(page).problems()).toEqual([]);
});

test("track ink is recognised by its hue, across the whole antialiased edge", async () => {
  // **The predicate decides every count in this file, so it is pinned on known colours rather
  // than inferred from a render.** An exact-value rule would drop the antialiased edge, which
  // is most of a 3-pixel line, and would then differ between platforms whose coverage differs
  // by a fraction — correct geometry, red suite, nothing learned. A rule that is merely "not
  // the background" would count the contour line and the hillshade instead.
  //
  // Blue-minus-red is what separates them here: the track is `#0969da`, the background is
  // near-neutral, the contour is warm, and hillshade only darkens what it covers.
  const mask = trackMask(
    rowOf([
      TRACK_BLUE, // the line itself
      blend(TRACK_BLUE, STYLE_BACKGROUND, 0.5), // half-covered edge
      blend(TRACK_BLUE, STYLE_BACKGROUND, 0.2), // the faint outer edge, still ink
      blend(TRACK_BLUE, STYLE_BACKGROUND, 0.08), // fainter than the rule admits
      STYLE_BACKGROUND,
      CONTOUR_BROWN,
      [0x80, 0x80, 0x80], // neutral, as hillshade is
      [0x00, 0x00, 0x00], // black: dark, and not blue
    ]),
  );

  expect([...mask]).toEqual([1, 1, 1, 0, 0, 0, 0, 0]);
  // The rule's own margin, stated: the faint edge it accepts is well inside it, and the one it
  // rejects is well outside. A threshold sitting on top of either would be a coin toss.
  expect(TRACK_BLUE_EXCESS).toBeLessThan(45);
  expect(TRACK_BLUE_EXCESS).toBeGreaterThan(22);
});

test("the two-segment render is the union of its segments, and the pause holds no line", async ({
  page,
}) => {
  const both = trackMask(await capture(page, pauseView("both")));
  const one = trackMask(await capture(page, pauseView("one")));
  const two = trackMask(await capture(page, pauseView("two")));
  // A track the renderer **must** draw across: the two points either side of the pause as one
  // two-point segment. Its strictly-new ink is the corridor, measured rather than computed
  // from a projection no consumer can reach — and a corridor in the wrong place would make
  // every negative assertion below a statement about empty space.
  const bridged = trackMask(await capture(page, pauseView("bridge")));

  const width = 1280;
  const legs = union(one, two);
  const corridor = difference(bridged, legs);
  const box = boundsOf(corridor, width);

  // Positive signal first. Each leg must have drawn something, or every set relation below
  // holds trivially over empty sets.
  expect(countMask(one), "segment one drew nothing").toBeGreaterThan(100);
  expect(countMask(two), "segment two drew nothing").toBeGreaterThan(100);
  expect(countMask(corridor), "the bridged control drew no ink of its own").toBeGreaterThan(100);
  expect(box, "the corridor has no extent").not.toBeNull();

  // **The control region that must change, and the two legs that must reach it.** Without
  // these, "no bridge" is satisfied by a corridor sitting somewhere nothing is drawn.
  const near: Box = {
    x: box!.x - CORRIDOR_MARGIN_PX,
    y: box!.y - CORRIDOR_MARGIN_PX,
    width: box!.width + 2 * CORRIDOR_MARGIN_PX,
    height: box!.height + 2 * CORRIDOR_MARGIN_PX,
  };
  expect(countIn(one, width, near), "segment one does not reach the pause").toBeGreaterThan(0);
  expect(countIn(two, width, near), "segment two does not reach the pause").toBeGreaterThan(0);

  // The set relation. `both` adds nothing the legs do not draw — which is what "no connecting
  // line" means without naming a region — and drops nothing they do, so it cannot pass by
  // rendering less.
  const added = countMask(difference(both, legs));
  const lost = countMask(difference(legs, both));
  const tolerance = Math.max(MIN_TOLERANCE_PX, Math.round(countMask(legs) * TOLERANCE_FRACTION));
  expect(added, `${String(added)} pixels drawn that neither segment draws`).toBeLessThanOrEqual(
    tolerance,
  );
  expect(lost, `${String(lost)} pixels of the segments are missing`).toBeLessThanOrEqual(tolerance);

  // The same claim, localised: nothing of the bridge's own ink appears in the real render.
  // Implied by the line above and stated anyway, because it is the sentence a reader wants —
  // and because it names the corridor, so a failure says *where*.
  expect(
    countMask(intersection(both, corridor)),
    "the real render put a line through the pause corridor",
  ).toBe(0);

  console.log(
    `pause: legs ${String(countMask(legs))} px (one ${String(countMask(one))}, two ` +
      `${String(countMask(two))}), both ${String(countMask(both))}, corridor ` +
      `${String(countMask(corridor))} px in ${String(box?.width)}×${String(box?.height)}, ` +
      `added ${String(added)}, lost ${String(lost)}, tolerance ${String(tolerance)}`,
  );
});

test("the hillshade layer puts pixels on the map, with its DEM source held fixed", async ({
  page,
}) => {
  // **The obligation the rendered-state controls could not discharge.** Comparing the stack
  // against a page with no DEM archive proves nothing about hillshade: the same archive drives
  // terrain, and terrain alone changes the scene. Removing the DEM's `tileSize: 256` — so the
  // layer asks for a zoom the archive does not contain and shades from nothing — left every one
  // of those assertions green.
  //
  // Here the source, the terrain, the contours, the track and the camera are identical, and the
  // hillshade **layer** is the only difference between the two renders.
  const withLayer = await capture(page, STACK);
  const withoutLayer = await capture(page, `${STACK}&hillshade=off`);

  const changed = changedMask(withLayer, withoutLayer);
  const total = withLayer.width * withLayer.height;
  const fraction = countMask(changed) / total;

  expect(fraction, "the hillshade layer changed nothing").toBeGreaterThan(MIN_HILLSHADE_FRACTION);

  // Spread, not just a total: a difference confined to one corner would be some other artefact.
  // Hillshade covers the viewport, so every one of these must move.
  for (const [cx, cy] of HILLSHADE_PROBES) {
    const roi: Box = { x: cx - 60, y: cy - 60, width: 120, height: 120 };
    expect(
      countIn(changed, withLayer.width, roi),
      `nothing changed around ${String(cx)},${String(cy)}`,
    ).toBeGreaterThan(MIN_ROI_CHANGED_PX);
  }

  console.log(
    `hillshade: ${String(countMask(changed))} of ${String(total)} px changed ` +
      `(${(fraction * 100).toFixed(1)}%)`,
  );
});

/** How far outside the corridor each leg is allowed to be and still count as reaching it. */
const CORRIDOR_MARGIN_PX = 8;
/**
 * Slack in the union relation.
 *
 * Measured at **zero** on macOS: the two renders agree pixel for pixel. The allowance exists
 * for coverage that differs by a fraction between platforms, and is two orders of magnitude
 * below the 827-pixel corridor a bridge draws, so it cannot absorb one.
 */
const TOLERANCE_FRACTION = 0.01;
const MIN_TOLERANCE_PX = 16;
/** Measured at 95.9%; asserted well below that, since the claim is "it drew", not "how much". */
const MIN_HILLSHADE_FRACTION = 0.2;
/** Of a 120×120 region — measured between 7,036 and 14,400. */
const MIN_ROI_CHANGED_PX = 720;
/** Spread across the viewport, and one in the middle. */
const HILLSHADE_PROBES: readonly (readonly [number, number])[] = [
  [320, 180],
  [960, 180],
  [320, 540],
  [960, 540],
  [640, 360],
];
