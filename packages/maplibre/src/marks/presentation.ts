// SPDX-License-Identifier: Apache-2.0

import type { MapEvent, Track, TrackLap } from "@mapatlas/core";

import type { MarkerStyle } from "./marker-style.js";

/**
 * How a consumer decides what the engine draws.
 *
 * The presentation seam exists because the engine is domain-blind: it knows an event has a
 * `category` and nothing about what any category *means*, so "show a different sign for this
 * kind of feature" is unbuildable inside the engine and trivial outside it. (ADR-0012)
 *
 * Every callback is **evaluated at the call that installs or supplies data**, never retained
 * and run later. A presentation is not a hook the renderer invokes during a draw; it is a
 * function the engine applies once, to produce prepared state. That is what makes a throwing
 * callback a rejected operation rather than a half-drawn map.
 */

/** How one segment of a track's line is drawn. */
export interface TrackLineStyle {
  color?: string;
  widthPx?: number;
  dashed?: boolean;
  opacity?: number;
}

export interface EventPresentation {
  /** Called per event; keyed off `category`/`tags`/`fields` by the consumer. */
  marker(event: MapEvent): MarkerStyle;
  /** `null` suppresses the mark entirely — a track that should show no start, for instance. */
  startMarker?(track: Track): MarkerStyle | null;
  finishMarker?(track: Track): MarkerStyle | null;
  lapMarker?(lap: TrackLap, track: Track): MarkerStyle | null;
  /** Called per segment, so pauses and laps can be styled differently. */
  trackLine?(track: Track, segmentIndex: number): TrackLineStyle;
}

/**
 * Class names the renderer owns.
 *
 * A consumer supplying one of these would be recorded as owning it, and dropping it on a
 * later refresh would remove a class MapLibre still needs — DOM class tokens carry no
 * ownership count, so `maplibregl-marker` removed once is removed for good, taking the
 * mark's absolute positioning with it. Rejected rather than filtered, so a consumer learns
 * at the call instead of wondering why a class it asked for never appears.
 */
const RENDERER_CLASS_PREFIX = "maplibregl-";

export class MarkerStyleError extends Error {
  constructor(detail: string) {
    super(`marker style: ${detail}`);
    this.name = "MarkerStyleError";
  }
}

/**
 * A deep copy of a marker style.
 *
 * The same rule the rest of the controller follows: prepared state is a snapshot, not a view.
 * A consumer returning a `sizePx` array it holds elsewhere — or reusing one style object
 * across every event — would otherwise be able to change what the map shows after the call
 * that decided it, and a mark's size would drift from the one its presentation returned.
 */
export function snapshotMarkerStyle(style: MarkerStyle): MarkerStyle {
  const reserved = (style.className ?? "")
    .split(/\s+/)
    .filter((token) => token.startsWith(RENDERER_CLASS_PREFIX));
  if (reserved.length > 0) {
    throw new MarkerStyleError(
      `"${reserved.join('", "')}" ${reserved.length === 1 ? "is" : "are"} reserved for the ` +
        `renderer; a mark that gave one up on a later render would lose the positioning ` +
        `MapLibre puts on it`,
    );
  }
  return {
    ...style,
    ...(style.sizePx === undefined ? {} : { sizePx: [style.sizePx[0], style.sizePx[1]] }),
  };
}

/** A deep copy of a line style, for the same reason. */
export function snapshotLineStyle(style: TrackLineStyle): TrackLineStyle {
  return { ...style };
}
