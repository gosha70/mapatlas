// SPDX-License-Identifier: Apache-2.0
// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";

import type { MarkerStyle } from "./marker-style.js";
import { MARK_WRAPPER_CLASS, applyMarkerStyle, createMarkerElement } from "./marker-element.js";

const BASE: MarkerStyle = { ariaLabel: "A place", html: "<b>one</b>", sizePx: [10, 12] };

function build(style: MarkerStyle, onActivate?: () => void): HTMLElement {
  return createMarkerElement(globalThis.document, style, onActivate);
}

describe("the wrapper carries the whole accessibility contract", () => {
  it("names a non-interactive mark and keeps it out of the tab order", () => {
    // A stop that does nothing is noise to anyone tabbing through a map, but it stays
    // focusable programmatically so a consumer can move focus to a mark it just added.
    const element = build(BASE);

    expect(element.getAttribute("role")).toBe("img");
    expect(element.getAttribute("aria-label")).toBe("A place");
    expect(element.tabIndex).toBe(-1);
  });

  it("makes an interactive mark a real control", () => {
    const element = build(BASE, () => undefined);

    expect(element.getAttribute("role")).toBe("button");
    expect(element.tabIndex).toBe(0);
  });

  it("activates on click, Enter and Space, and on nothing else", () => {
    const onActivate = vi.fn();
    const element = build(BASE, onActivate);

    element.dispatchEvent(new globalThis.MouseEvent("click"));
    for (const key of ["Enter", " ", "Escape", "a"]) {
      element.dispatchEvent(new globalThis.KeyboardEvent("keydown", { key, cancelable: true }));
    }

    expect(onActivate).toHaveBeenCalledTimes(3);
  });

  it("stops Space from scrolling the map out from under the mark", () => {
    const element = build(BASE, () => undefined);
    const event = new globalThis.KeyboardEvent("keydown", { key: " ", cancelable: true });

    element.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });

  it("hides the consumer's markup, so a mark is announced once", () => {
    const element = build(BASE);
    const content = element.querySelector("[aria-hidden='true']");

    expect(content).not.toBeNull();
    expect(content?.innerHTML).toBe("<b>one</b>");
  });
});

describe("refreshing a mark in place", () => {
  it("replaces the consumer's markup, not only its name", () => {
    // The defect this pins: without a class on the content node the refresh queries for
    // something that is not there, silently updates nothing, and every other field appears
    // to work — so the mark shows old contents under a new name.
    const element = build(BASE);

    applyMarkerStyle(element, { ...BASE, ariaLabel: "Somewhere else", html: "<i>two</i>" });

    expect(element.getAttribute("aria-label")).toBe("Somewhere else");
    expect(element.querySelector("[aria-hidden='true']")?.innerHTML).toBe("<i>two</i>");
  });

  it("clears the markup when a style stops supplying any", () => {
    const element = build(BASE);
    const style = { ...BASE };
    delete style.html;

    applyMarkerStyle(element, style);

    expect(element.querySelector("[aria-hidden='true']")?.innerHTML).toBe("");
  });

  it("keeps classes the renderer added after construction", () => {
    // MapLibre puts `maplibregl-marker`, an anchor class and terrain visibility state on this
    // element after it is handed over. Assigning `className` deletes them — and losing
    // `maplibregl-marker` costs the mark its absolute positioning, so it drops into normal
    // flow and lands outside the map.
    const element = build({ ...BASE, className: "first" });
    element.classList.add("maplibregl-marker", "maplibregl-marker-anchor-bottom");

    applyMarkerStyle(element, { ...BASE, className: "second" });

    expect(element.classList.contains("maplibregl-marker")).toBe(true);
    expect(element.classList.contains("maplibregl-marker-anchor-bottom")).toBe(true);
    expect(element.classList.contains(MARK_WRAPPER_CLASS)).toBe(true);
    expect(element.classList.contains("second")).toBe(true);
    // And drops the one it previously owned, so a stale consumer class does not accumulate.
    expect(element.classList.contains("first")).toBe(false);
  });

  it("drops its own classes when a style stops supplying them", () => {
    const element = build({ ...BASE, className: "only-once" });

    applyMarkerStyle(element, BASE);

    expect(element.classList.contains("only-once")).toBe(false);
    expect(element.classList.contains(MARK_WRAPPER_CLASS)).toBe(true);
  });

  it("removes size and colour a style no longer asks for", () => {
    const element = build({ ...BASE, color: "#123456" });
    const bare = { ...BASE };
    delete bare.sizePx;

    applyMarkerStyle(element, bare);

    expect(element.style.width).toBe("");
    expect(element.style.height).toBe("");
    expect(element.style.color).toBe("");
  });
});
