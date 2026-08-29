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

/** The consumer's markup lives here, hidden from assistive tech and refreshed in place. */
const CONTENT_CLASS = "mapatlas-marker__content";

/**
 * Which classes this module put on the element last time.
 *
 * The renderer adds its own after construction, so a refresh cannot simply reassign
 * `className` — it has to remove exactly what it added and leave everything else alone.
 */
const OWNED_CLASSES_ATTRIBUTE = "data-mapatlas-classes";

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

  wrapper.setAttribute("role", interactive ? "button" : "img");
  // -1 keeps a non-interactive mark out of the tab order while leaving it focusable
  // programmatically, so a consumer can still move focus to one it has just added.
  wrapper.tabIndex = interactive ? 0 : -1;

  // The consumer's markup goes *inside*, never in place of, the wrapper — and is marked, so
  // a later refresh can find it. Without the class `applyMarkerStyle` looks for a node that
  // is not there and quietly refreshes nothing.
  const content = documentLike.createElement("span");
  content.className = CONTENT_CLASS;
  content.setAttribute("aria-hidden", "true");
  wrapper.append(content);

  // One code path for styling, used at creation and at every refresh. Two would drift, and
  // the half that drifted would be the one only a re-render exercises.
  applyMarkerStyle(wrapper, style);

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

/**
 * Bring a wrapper up to date with a style, at creation and on every re-render.
 *
 * A mark that survives a re-render keeps its element, so a keyboard user does not lose focus
 * mid-update — but keeping the element must not mean keeping what it *says*. A lap renamed
 * between renders would otherwise announce its old name indefinitely, which is worse than
 * rebuilding: the mark looks maintained and is lying.
 *
 * Classes are **added and removed, never assigned**. The renderer puts its own classes on
 * this element after construction — `maplibregl-marker`, the anchor class, terrain
 * visibility state — and assigning `className` deletes them. Losing `maplibregl-marker`
 * costs the mark its absolute positioning, so it lands wherever normal flow puts it, which
 * is generally outside the map. Only the classes this function itself last applied are
 * removed, recorded on the element so the next call knows what it owns.
 *
 * `anchor` is not applied here: the renderer fixes it when the marker is constructed and it
 * cannot be changed after.
 */
export function applyMarkerStyle(wrapper: HTMLElement, style: MarkerStyle): void {
  const owned = [MARK_WRAPPER_CLASS, ...(style.className?.split(/\s+/).filter(Boolean) ?? [])];
  const previous = wrapper.getAttribute(OWNED_CLASSES_ATTRIBUTE)?.split(" ").filter(Boolean) ?? [];

  for (const className of previous) {
    if (!owned.includes(className)) wrapper.classList.remove(className);
  }
  for (const className of owned) wrapper.classList.add(className);
  wrapper.setAttribute(OWNED_CLASSES_ATTRIBUTE, owned.join(" "));

  wrapper.setAttribute("aria-label", style.ariaLabel);

  if (style.sizePx === undefined) {
    wrapper.style.removeProperty("width");
    wrapper.style.removeProperty("height");
  } else {
    const [width, height] = style.sizePx;
    wrapper.style.width = `${String(width)}px`;
    wrapper.style.height = `${String(height)}px`;
  }
  if (style.color === undefined) wrapper.style.removeProperty("color");
  else wrapper.style.color = style.color;

  const content = wrapper.querySelector(`.${CONTENT_CLASS}`);
  if (content !== null) content.innerHTML = markerContent(style);
}

/**
 * What goes inside the wrapper.
 *
 * `html` wins when both are given: it is the general escape hatch, and a style supplying it
 * has already said exactly what to draw. `iconUrl` is the convenience for the common case,
 * and the engine bundles no icons, so it is always a consumer's own asset.
 *
 * The image carries an empty `alt` deliberately. The wrapper already holds the accessible
 * name; a second one here would have the mark announced twice, and an `img` with no `alt` at
 * all would have assistive technology read out the file name.
 */
function markerContent(style: MarkerStyle): string {
  if (style.html !== undefined) return style.html;
  if (style.iconUrl === undefined) return "";

  // Nothing constrains an image otherwise: a consumer's asset keeps its intrinsic size and
  // overflows a wrapper that measures correctly and reports no error.
  //
  // Percentages rather than repeated `sizePx` values, and applied **unconditionally**. The
  // span between wrapper and image is inline, so it establishes no containing block and these
  // resolve against the wrapper itself — which is what lets them follow a wrapper sized
  // through `className` as well as one sized through `sizePx`. Gating them on `sizePx` would
  // contradict that reason and leave the documented styling path unconstrained.
  //
  // Safe when nothing sized the wrapper at all: it shrink-wraps its content, so the
  // percentage resolves against the image's own intrinsic size and changes nothing. A
  // consumer who said nothing about size gets the size the asset came with.
  //
  // `contain` letterboxes rather than cropping or distorting, because the engine has no idea
  // what the icon depicts.
  const box = "display:block;width:100%;height:100%;object-fit:contain";

  return `<img src="${escapeAttribute(style.iconUrl)}" alt="" style="${box}" />`;
}

/**
 * Escape a value going into an attribute.
 *
 * `html` is inserted verbatim and is consumer-trusted by contract, but `iconUrl` is a *value*
 * the engine puts into markup it composes itself — so a url containing a quote must not be
 * able to close the attribute and add its own.
 */
function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
