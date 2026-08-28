// SPDX-License-Identifier: Apache-2.0

import type { MarkerStyle } from "./marker-style.js";

/**
 * The engine-owned element a marker is built around.
 *
 * A marker is **not accessible for carrying an `aria-label`**. Assistive technology needs a
 * name, a role that says what the thing is, and — when it does something — a way to reach and
 * activate it without a pointer. MapLibre's `Marker` supplies none of that; it positions an
 * element. So the engine wraps every mark in an element it controls and puts the whole
 * contract there, then inserts the consumer's markup inside.
 *
 * The wrapper is engine-owned for a second reason: `MarkerStyle.html` is inserted verbatim
 * and is consumer-trusted markup (`SECURITY.md`). Putting the accessibility attributes on a
 * wrapper rather than on that markup means a consumer cannot accidentally — or deliberately —
 * ship a mark with no accessible name.
 */

/** Just enough of `Document` to build a marker, so the seam stays narrow. */
export interface DocumentLike {
  createElement(tagName: string): HTMLElement;
}

/** Keys that activate a focused control, per WAI-ARIA. */
const ACTIVATION_KEYS: ReadonlySet<string> = new Set([" ", "Enter", "Spacebar"]);

export const MARK_WRAPPER_CLASS = "mapatlas-marker";

/**
 * Build the wrapper for one mark.
 *
 * A mark with an `onActivate` is a control: it gets `role="button"`, joins the tab order, and
 * responds to Enter and Space. One without is content: it gets `role="img"` and stays out of
 * the tab order, because a stop that does nothing is noise to anyone tabbing through a map.
 */
export function createMarkerElement(
  documentLike: DocumentLike,
  style: MarkerStyle,
  onActivate?: () => void,
): HTMLElement {
  const wrapper = documentLike.createElement("div");
  const interactive = onActivate !== undefined;

  wrapper.className =
    style.className === undefined ? MARK_WRAPPER_CLASS : `${MARK_WRAPPER_CLASS} ${style.className}`;
  wrapper.setAttribute("role", interactive ? "button" : "img");
  wrapper.setAttribute("aria-label", style.ariaLabel);
  // -1 keeps a non-interactive mark out of the tab order while leaving it focusable
  // programmatically, so a consumer can still move focus to one it has just added.
  wrapper.tabIndex = interactive ? 0 : -1;

  if (style.sizePx !== undefined) {
    const [width, height] = style.sizePx;
    wrapper.style.width = `${String(width)}px`;
    wrapper.style.height = `${String(height)}px`;
  }
  if (style.color !== undefined) wrapper.style.color = style.color;

  // The consumer's markup goes *inside*, never in place of, the wrapper.
  const content = documentLike.createElement("span");
  content.setAttribute("aria-hidden", "true");
  if (style.html !== undefined) content.innerHTML = style.html;
  wrapper.append(content);

  if (interactive) {
    wrapper.addEventListener("click", () => {
      onActivate();
    });
    wrapper.addEventListener("keydown", (event: Event) => {
      const key = (event as KeyboardEvent).key;
      if (!ACTIVATION_KEYS.has(key)) return;
      // Space scrolls the page otherwise, which moves the map out from under the mark the
      // user just activated.
      event.preventDefault();
      onActivate();
    });
  }

  return wrapper;
}
