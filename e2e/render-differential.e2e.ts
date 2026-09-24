// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";

import type { Raster } from "./fixtures/pixels.js";
import { TRACK_BLUE_EXCESS, trackMask } from "./fixtures/pixels.js";

/**
 * The track-ink predicate every pixel differential in this lane counts with, pinned on known
 * colours rather than inferred from a render.
 *
 * Pure: nothing here opens a browser. The set-relation proofs that used to sit beside it — the
 * pause as a gap, the hillshade layer's own ink — were `/lab`'s and now run on the harness in
 * `map-controller.e2e.ts` (T8.3); this is the predicate they count with, kept where it was.
 */

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
