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
  /** Marker content, inserted verbatim inside the engine's accessible wrapper. */
  html?: string;
  className?: string;
  /** Consumer-supplied asset; the engine bundles no icons. */
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

/** The engine's own mark for `kind`, optionally carrying a consumer-supplied label. */
export function builtInMark(kind: BuiltInMark, label?: string): MarkerStyle {
  return {
    ariaLabel: label === undefined ? BUILT_IN_LABEL[kind] : `${BUILT_IN_LABEL[kind]}: ${label}`,
    color: BUILT_IN_COLOR[kind],
    className: `mapatlas-mark mapatlas-mark--${kind}`,
    anchor: kind === "live" ? "center" : "bottom",
  };
}
