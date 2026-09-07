// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import type { MapEvent } from "@mapatlas/core";

import { DEMO_CATEGORIES, OBSERVATION, WAYPOINT, demoPresentation } from "./presentation.js";

const event = (over: Partial<MapEvent> = {}): MapEvent => ({
  id: "e1",
  position: { lat: 1, lng: 2 },
  occurredAt: 0,
  media: [],
  tags: [],
  ...over,
});

describe("the demo's presentation keys off category", () => {
  it("draws the two categories differently", () => {
    // **Not "a style was returned".** A presentation that returned one style for everything
    // satisfies "the seam is installed" and tells a reviewer looking at the map nothing, so the
    // assertion is that the two marks actually differ.
    const observation = demoPresentation.marker(event({ category: OBSERVATION }));
    const waypoint = demoPresentation.marker(event({ category: WAYPOINT }));

    expect(observation).not.toStrictEqual(waypoint);
    expect(observation.ariaLabel).toBe("Observation");
    expect(waypoint.ariaLabel).toBe("Waypoint");
  });

  it("gives every mark an accessible name", () => {
    // `ariaLabel` is required by `MarkerStyle`, and a mark without one is a control a screen
    // reader announces as nothing at all.
    for (const category of [OBSERVATION, WAYPOINT, "retired-category", undefined]) {
      const style = demoPresentation.marker(event(category === undefined ? {} : { category }));
      expect(style.ariaLabel.length, `empty name for ${String(category)}`).toBeGreaterThan(0);
    }
  });

  it("still draws an event whose category this build does not know", () => {
    // Categories are consumer data and outlive a build. An event stored under a category since
    // renamed must not vanish from the map while remaining in the database — that reads as data
    // loss and is not.
    const unknown = demoPresentation.marker(event({ category: "category-from-an-older-build" }));

    expect(unknown.ariaLabel).toBe("Event");
  });

  it("offers exactly the categories it can draw", () => {
    // **The drift this prevents.** The composer's options and `marker()` are two halves of one
    // decision; if a value were added to one and not the other, the composer would keep offering
    // a category the map had stopped distinguishing, and both halves would still pass their own
    // tests.
    const offered = DEMO_CATEGORIES.map((c) => c.value);

    expect(offered).toStrictEqual([OBSERVATION, WAYPOINT]);
    for (const value of offered) {
      expect(
        demoPresentation.marker(event({ category: value })).ariaLabel,
        `${value} is offered but draws as uncategorised`,
      ).not.toBe("Event");
    }
  });
});
