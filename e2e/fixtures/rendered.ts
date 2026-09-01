// SPDX-License-Identifier: Apache-2.0

import type { Locator, Page } from "@playwright/test";

/**
 * When a map has finished drawing, established from the pixels rather than from an event.
 *
 * **Why not `map.once("idle")`.** `MapController` publishes no map handle, and `/lab` is
 * assembled from package entry points only, so MapLibre's own settled-render event is not
 * reachable from a scenario. Adding a getter for it would be engine surface that exists only for
 * a test — a trade this plan has already refused once.
 *
 * So the stopping condition is taken directly: `idle` means "nothing left to draw", and *k*
 * consecutive byte-identical captures are the observable form of that. It is a weaker signal in
 * one specific way, recorded here rather than glossed: a map redrawing the *same* pixels — an
 * animation at a fixed point, a re-render that changes nothing — settles under this rule and not
 * under MapLibre's. Nothing in this fixture animates, and a scenario that added something which
 * did would have to revisit this.
 *
 * **Settling is not evidence on its own.** A canvas that never painted settles on its first two
 * captures, faster than one that worked. Every caller must pair this with something that says
 * what was painted; the module offers no "the map is ready" helper, because that is the claim
 * a settled render cannot make.
 */

/**
 * How the wait is tuned.
 *
 * Parameters rather than constants because the oracle's own spec drives them: a page that
 * changes for a known interval, and one that never stops, are the only way to see this loop
 * do its job. On a fast machine with local archives the map is already painted by the first
 * capture, so the map tests settle at the minimum and would look identical if the loop were
 * removed — which is exactly why it is verified against something else.
 */
export interface SettleOptions {
  /** Consecutive identical captures that end the wait. */
  stableCaptures?: number;
  /** Gap between captures. Long enough that a slow frame is not mistaken for a settled one. */
  intervalMs?: number;
  /** How long to keep trying before giving up. */
  timeoutMs?: number;
}

const DEFAULTS = Object.freeze({ stableCaptures: 3, intervalMs: 250, timeoutMs: 30_000 });

export interface SettledRender {
  /** The settled capture — PNG bytes of the element, at the page's device scale. */
  readonly image: Buffer;
  /** Captures taken in total, including the identical ones that ended the wait. */
  readonly captures: number;
  /** Milliseconds from the first capture to the last. */
  readonly elapsedMs: number;
}

export class RenderNeverSettledError extends Error {
  constructor(captures: number, elapsedMs: number, stableCaptures: number) {
    super(
      `the map never settled: ${String(captures)} captures over ${String(elapsedMs)} ms and no ` +
        `${String(stableCaptures)} consecutive ones matched. Either it is still drawing, or ` +
        `something on the page animates and this oracle cannot be used on it.`,
    );
    this.name = "RenderNeverSettledError";
  }
}

/**
 * Capture an element until it stops changing.
 *
 * Throws rather than returning the last capture on timeout. A "settled" render that never
 * settled is the kind of value that makes every assertion downstream meaningless while looking
 * like evidence, and the caller has no way to tell the two apart from the return value.
 */
export async function settleRender(
  target: Locator,
  options: SettleOptions = {},
): Promise<SettledRender> {
  const { stableCaptures, intervalMs, timeoutMs } = { ...DEFAULTS, ...options };
  const startedAt = Date.now();
  let previous: Buffer | null = null;
  let identical = 1;
  let captures = 0;

  while (Date.now() - startedAt < timeoutMs) {
    const image = await target.screenshot();
    captures += 1;
    if (previous !== null && previous.equals(image)) {
      identical += 1;
      if (identical >= stableCaptures) {
        return { image, captures, elapsedMs: Date.now() - startedAt };
      }
    } else {
      // Reset to one, not zero: this capture is itself the first of a possible new run.
      identical = 1;
    }
    previous = image;
    await target.page().waitForTimeout(intervalMs);
  }
  throw new RenderNeverSettledError(captures, Date.now() - startedAt, stableCaptures);
}

/** The element `/lab` draws into. Named once so every capture in every spec frames the same box. */
export function mapOf(page: Page): Locator {
  return page.locator("#map");
}

/**
 * A capture's pixel dimensions, read from the PNG header.
 *
 * So a comparison between two captures can say whether they differ in *content*. Two images of
 * different sizes differ for free, and a viewport or device-scale change would produce exactly
 * that — a difference read as geometry when it is a difference in the camera.
 */
export function pngSize(image: Buffer): { width: number; height: number } {
  const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (image.length < 24 || !image.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error("not a PNG: a capture that is not an image cannot be compared as one");
  }
  return { width: image.readUInt32BE(16), height: image.readUInt32BE(20) };
}
