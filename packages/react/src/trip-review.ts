// SPDX-License-Identifier: Apache-2.0

import { createElement } from "react";
import type { ReactElement } from "react";

import type {
  Id,
  JSONValue,
  MapEvent,
  StorageAdapter,
  TerrainOptions,
  TileSource,
  Track,
} from "@mapatlas/core";
import type { EventPresentation, MapController, MapControllerOptions } from "@mapatlas/maplibre";

import type { MapCanvasProps } from "./map-canvas.js";
import { MapCanvas, MapCanvasInternal } from "./map-canvas.js";

/** Published by `api.md` §9 as an inline shape; named here only so the two entry points below
 *  can share it, and deliberately **not** exported from the barrel — as with `MapCanvasProps`,
 *  exporting it would add public API the contract does not publish. */
interface TripReviewProps {
  track: Track;
  events: MapEvent[];
  /** Resolves `MediaRef.blobKey` for display (ADR-0028). Unread until increment 3 — required
   *  from the start because adding it later would be a breaking change to every consumer. */
  store: StorageAdapter;
  sources: TileSource[];
  style?: string | JSONValue;
  terrain?: TerrainOptions | null;
  presentation?: EventPresentation;
  channels?: string[];
  onEventClick?(id: Id): void;
}

/**
 * Review a finalized trip: the track on a basemap with its start and finish marks, its events,
 * and — from later increments — photos, stats and per-channel charts (`api.md` §9, T5.4).
 *
 * **Composition, not a second renderer.** The map half is `MapCanvas`, unchanged. Start and
 * finish marks need no route of their own: `EventPresentation` already declares `startMarker`
 * and `finishMarker` with neutral built-in defaults, and the controller renders them from the
 * track as *track* marks — a channel distinct from event marks, so they are not clickable and
 * `onEventClick` reports only real events. Driving the controller directly would have meant
 * re-solving SSR safety, mount ordering and StrictMode remounts that `MapCanvas` already
 * settled.
 *
 * **A finalized track, not a live one.** `livePoint` and `draft` belong to `MapCanvas`; this
 * component takes a `Track` that is already complete.
 */
export function TripReview(props: TripReviewProps): ReactElement {
  return createElement(
    "section",
    { className: "mapatlas-trip-review" },
    createElement(MapCanvas, mapProps(props)),
  );
}

/**
 * Exported for tests only — not re-exported from the package barrel.
 *
 * The `create` seam exists for the same reason `MapCanvasInternal`'s does: every prop this
 * component forwards has a default that renders *something*, so a test observing only the DOM
 * would pass while a pass-through was missing. Observing what reaches the controller is what
 * makes each forward falsifiable — `presentation` most of all, since dropping it still draws
 * start and finish marks from the built-in defaults.
 *
 * Two entry points rather than one with an optional `create`, deliberately: a single one needed
 * a cast to satisfy `MapCanvasInternal`'s required seam, and that cast silenced type checking on
 * every forwarded prop — which is the thing this component is almost entirely made of.
 */
export function TripReviewInternal(
  props: TripReviewProps & { create: (options: MapControllerOptions) => MapController },
): ReactElement {
  return createElement(
    "section",
    { className: "mapatlas-trip-review" },
    createElement(MapCanvasInternal, { ...mapProps(props), create: props.create }),
  );
}

/**
 * The forwarded half of the props, in one place so both entry points cannot drift.
 *
 * Conditional spreads throughout: `exactOptionalPropertyTypes` distinguishes an absent optional
 * prop from one explicitly `undefined`, and the two are different requests. `MapCanvas`
 * normalises them identically today, so the distinction is currently unobservable at runtime and
 * is held by the type instead — a mutation replacing a spread with `presentation:
 * props.presentation` is rejected by `tsc`, not by a test.
 */
function mapProps(props: TripReviewProps): MapCanvasProps {
  return {
    sources: props.sources,
    track: props.track,
    events: props.events,
    ...(props.style === undefined ? {} : { style: props.style }),
    ...(props.terrain === undefined ? {} : { terrain: props.terrain }),
    ...(props.presentation === undefined ? {} : { presentation: props.presentation }),
    ...(props.onEventClick === undefined ? {} : { onEventClick: props.onEventClick }),
  };
}
