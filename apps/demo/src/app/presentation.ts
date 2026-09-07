// SPDX-License-Identifier: Apache-2.0

/**
 * The demo's own `EventPresentation` — T7.1 increment 2.
 *
 * **This is the seam, and the demo is the consumer side of it.** The engine knows nothing about
 * categories: `MapEvent.category` is an opaque string it stores and hands back, and every
 * decision about what a category *looks like* is made here. That is the property the whole
 * package boundary exists to protect, so the demo has to exercise it rather than accept the
 * neutral built-ins.
 *
 * **Two categories, deliberately domain-free.** A field logger for no particular field: an
 * `observation` is something seen, a `waypoint` is somewhere worth returning to. Neither implies
 * fish, plants, mushrooms, products or users — the engine must not learn a domain from its own
 * demo, and a demo that shipped "species" would teach the next reader that categories are for
 * taxonomy.
 */

import type { MapEvent } from "@mapatlas/core";
import type { EventPresentation, MarkerStyle, TrackLineStyle } from "@mapatlas/maplibre";

/**
 * The category values, defined once.
 *
 * **Shared across a module boundary on purpose.** `EventComposer` renders these as its options
 * and writes the chosen `value` into `MapEvent.category`; `marker()` below switches on the same
 * strings when the event comes back. Two copies would be two chances for one to be edited into a
 * value the other does not recognise — the composer would keep offering a category the map had
 * stopped drawing, and every test would still pass, because each half is self-consistent.
 */
export const OBSERVATION = "observation";
export const WAYPOINT = "waypoint";

/** What the composer offers. The engine assigns no meaning to either the value or the label. */
export const DEMO_CATEGORIES: readonly { value: string; label: string }[] = [
  { value: OBSERVATION, label: "Observation" },
  { value: WAYPOINT, label: "Waypoint" },
];

/**
 * Distinct marks, because "the presentation was installed" is satisfied by one that returns the
 * same style for everything.
 *
 * A reviewer looking at the map has to be able to tell the two categories apart, and a test has
 * to be able to assert that the difference tracks `category` rather than, say, insertion order.
 */
const OBSERVATION_MARK: MarkerStyle = {
  color: "#1b7f5a",
  sizePx: [14, 14],
  anchor: "center",
  ariaLabel: "Observation",
};

const WAYPOINT_MARK: MarkerStyle = {
  color: "#8a4b12",
  sizePx: [14, 14],
  anchor: "bottom",
  ariaLabel: "Waypoint",
};

/**
 * An event whose category is absent or unrecognised still gets a mark.
 *
 * **Not a defensive nicety.** Categories are consumer data and outlive any one build of this
 * app: an event stored under a category this version has since renamed would otherwise vanish
 * from the map while remaining in the database, which reads as data loss and is not. Drawing it
 * neutrally keeps it visible and findable.
 */
const UNCATEGORISED_MARK: MarkerStyle = {
  color: "#4a4a4a",
  sizePx: [12, 12],
  anchor: "center",
  ariaLabel: "Event",
};

const TRACK_LINE: TrackLineStyle = { color: "#1f4f82", widthPx: 4, opacity: 0.9 };

export const demoPresentation: EventPresentation = {
  marker(event: MapEvent): MarkerStyle {
    if (event.category === OBSERVATION) return OBSERVATION_MARK;
    if (event.category === WAYPOINT) return WAYPOINT_MARK;
    return UNCATEGORISED_MARK;
  },
  /**
   * One line style for every segment.
   *
   * The seam passes the track and the segment index so a consumer *can* draw a paused span
   * differently; this demo has no reason to, and taking the parameters only to ignore them would
   * suggest a decision was made here that was not.
   */
  trackLine(): TrackLineStyle {
    return TRACK_LINE;
  },
};
