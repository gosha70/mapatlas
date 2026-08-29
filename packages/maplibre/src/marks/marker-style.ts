// SPDX-License-Identifier: Apache-2.0

/**
 * How one mark is drawn.
 *
 * `html` is inserted **verbatim**, so it is consumer-trusted markup and must never be built
 * from untrusted input (`SECURITY.md`). `ariaLabel` is required rather than optional: only
 * the consumer knows what a mark means, so only the consumer can name it for assistive
 * technology, and a mark nobody can name is a mark nobody can use.
 */
export interface MarkerStyle {
  /**
   * Marker content, inserted verbatim inside the engine's accessible wrapper.
   *
   * Takes precedence over {@link MarkerStyle.iconUrl}: `html` is the general escape hatch,
   * `iconUrl` the convenience, and a style supplying both means the consumer has already
   * said exactly what it wants drawn.
   */
  html?: string;
  className?: string;
  /**
   * An image to draw, when `html` is absent. Consumer-supplied: the engine bundles no icons.
   *
   * Rendered inside the wrapper as an `img` with an empty `alt`, because the wrapper already
   * carries the accessible name — a second name here would have the mark announced twice.
   */
  iconUrl?: string;
  color?: string;
  sizePx?: [w: number, h: number];
  anchor?: "center" | "bottom";
  ariaLabel: string;
}

/** What a built-in mark stands for, and what the engine calls it when nobody else does. */
export type BuiltInMark = "start" | "finish" | "lap" | "event" | "live";

/**
 * Neutral marks, used until a consumer supplies an `EventPresentation` in T4.4.
 *
 * Deliberately plain: the engine is domain-blind and bundles no iconography, so these say
 * *where* something is and nothing about *what* it is. The labels are generic for the same
 * reason — "Event" is the honest name for something the engine knows nothing else about.
 */
const BUILT_IN_LABEL: Readonly<Record<BuiltInMark, string>> = Object.freeze({
  start: "Track start",
  finish: "Track finish",
  lap: "Lap",
  event: "Event",
  live: "Current position",
});

const BUILT_IN_COLOR: Readonly<Record<BuiltInMark, string>> = Object.freeze({
  start: "#1a7f37",
  finish: "#8250df",
  lap: "#57606a",
  event: "#0969da",
  live: "#cf222e",
});

/**
 * Built-in marks carry real geometry, not just a colour.
 *
 * A wrapper with no size and no content lays out at zero by zero: the mark is positioned
 * correctly, is in the accessibility tree, and is invisible. Nothing reports it, because
 * nothing is wrong — there is simply nothing to draw. A default that cannot be seen is not a
 * default.
 */
const PIN_SIZE_PX: readonly [number, number] = [18, 24];
const DOT_SIZE_PX: readonly [number, number] = [14, 14];

/** A teardrop whose tip is the point, which is why these marks anchor at the bottom. */
const PIN_SVG =
  '<svg viewBox="0 0 18 24" width="100%" height="100%" focusable="false">' +
  '<path d="M9 24C9 24 17 14.5 17 9A8 8 0 1 0 1 9c0 5.5 8 15 8 15z" ' +
  'fill="currentColor" stroke="#ffffff" stroke-width="1.5"/>' +
  '<circle cx="9" cy="9" r="3" fill="#ffffff"/></svg>';

/** A dot centred on the point, for a position rather than a place. */
const DOT_SVG =
  '<svg viewBox="0 0 14 14" width="100%" height="100%" focusable="false">' +
  '<circle cx="7" cy="7" r="5" fill="currentColor" stroke="#ffffff" stroke-width="2"/></svg>';

/** The engine's own mark for `kind`, optionally carrying a consumer-supplied label. */
export function builtInMark(kind: BuiltInMark, label?: string): MarkerStyle {
  const centred = kind === "live";
  return {
    ariaLabel: label === undefined ? BUILT_IN_LABEL[kind] : `${BUILT_IN_LABEL[kind]}: ${label}`,
    color: BUILT_IN_COLOR[kind],
    className: `mapatlas-mark mapatlas-mark--${kind}`,
    anchor: centred ? "center" : "bottom",
    sizePx: centred ? [...DOT_SIZE_PX] : [...PIN_SIZE_PX],
    html: centred ? DOT_SVG : PIN_SVG,
  };
}
