// @vitest-environment happy-dom
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { Id, MapEvent, StorageAdapter, TileSource, Track } from "@mapatlas/core";
import type { EventPresentation, MapController, MapControllerOptions } from "@mapatlas/maplibre";

import { renderComponent } from "./testing/render-hook.js";
import { TripReviewInternal } from "./trip-review.js";

/**
 * **Every prop here has a default that renders something**, which is what makes DOM assertions
 * the wrong oracle for composition. Drop the `presentation` forward and start and finish marks
 * still appear, drawn from the built-in defaults; drop `terrain` and the map still renders.
 * A test that looked at the map would pass in both cases.
 *
 * So the oracle is what reaches the controller: the options it was constructed with, and the
 * calls made against it. Each forward is then falsifiable on its own — pass a value that
 * differs from the default and assert *that* value arrived.
 */
interface Recorded {
  options: MapControllerOptions;
  presentations: (EventPresentation | null)[];
  tracks: (Track | null)[];
  events: MapEvent[][];
  terrains: unknown[];
  clickListeners: ((id: Id) => void)[];
}

function recordingController(): {
  create: (options: MapControllerOptions) => MapController;
  seen: Recorded[];
} {
  const seen: Recorded[] = [];
  const create = (options: MapControllerOptions): MapController => {
    const record: Recorded = {
      options,
      presentations: [],
      tracks: [],
      events: [],
      terrains: [],
      clickListeners: [],
    };
    seen.push(record);
    const controller = {
      setSources: () => undefined,
      setTerrain: (t: unknown) => {
        record.terrains.push(t);
      },
      setPresentation: (p: EventPresentation | null) => {
        record.presentations.push(p);
      },
      renderTrack: (t: Track | null) => {
        record.tracks.push(t);
      },
      renderEvents: (e: MapEvent[]) => {
        record.events.push(e);
      },
      showLivePosition: () => undefined,
      renderDraft: () => undefined,
      onMapTap: () => () => undefined,
      onEventClick: (cb: (id: Id) => void) => {
        record.clickListeners.push(cb);
        return () => undefined;
      },
      enterDrawMode: () => () => undefined,
      destroy: () => undefined,
    };
    return controller as unknown as MapController;
  };
  return { create, seen };
}

const SOURCES: TileSource[] = [
  {
    id: "base",
    kind: "raster",
    tiles: ["https://example.invalid/{z}/{x}/{y}.png"],
    attribution: "x",
  },
] as never;

const TRACK: Track = {
  id: "t1",
  startedAt: 1_000,
  points: [
    { lat: 59.3, lng: 18.0, t: 1_000 },
    { lat: 59.4, lng: 18.1, t: 2_000 },
  ],
} as never;

const EVENTS: MapEvent[] = [
  { id: "e1", position: { lat: 59.35, lng: 18.05 }, occurredAt: 1_500, media: [], tags: [] },
] as never;

const STORE = {} as StorageAdapter;

async function mount(overrides: Record<string, unknown> = {}): Promise<{
  seen: Recorded[];
  create: (options: MapControllerOptions) => MapController;
  container: HTMLElement;
  rerender: (props: never) => Promise<void>;
  unmount: () => Promise<void>;
}> {
  const { create, seen } = recordingController();
  const harness = await renderComponent(TripReviewInternal, {
    track: TRACK,
    events: EVENTS,
    store: STORE,
    sources: SOURCES,
    create,
    ...overrides,
  } as never);
  return {
    seen,
    create,
    container: harness.container,
    rerender: harness.rerender as (props: never) => Promise<void>,
    unmount: harness.unmount,
  };
}

describe("TripReview — composition and pass-through (T5.4 increment 1)", () => {
  it("mounts one map with the track and its events", async () => {
    const { seen } = await mount();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.tracks.at(-1), "the finalized track must reach the map").toBe(TRACK);
    expect(seen[0]?.events.at(-1)).toBe(EVENTS);
  });

  it("forwards a presentation that suppresses the finish mark", async () => {
    // The discriminating case. Dropping this forward leaves the built-in defaults in place and
    // start/finish marks still render, so only the *identity* of what reached the controller
    // separates "forwarded" from "defaulted".
    const presentation: EventPresentation = {
      marker: () => ({ kind: "dot", color: "#111" }) as never,
      startMarker: () => ({ kind: "dot", color: "#0f0" }) as never,
      finishMarker: () => null,
    };
    const { seen } = await mount({ presentation });

    // On mount these arrive through the *construction options*, not the setter: `MapCanvas`
    // seeds its applied-state from what it constructed with, so `setPresentation` fires only on
    // a later change. Asserting the setter here would have failed for the right reason and
    // taught the wrong lesson about where the value travels.
    const delivered = seen[0]?.options.presentation;
    expect(delivered, "presentation was not forwarded").toBe(presentation);
    expect(delivered?.finishMarker?.(TRACK), "the suppressing rule must survive the forward").toBe(
      null,
    );
  });

  it("omits presentation entirely when the consumer gave none", async () => {
    // Absent, not `undefined`: `exactOptionalPropertyTypes` makes those different, and a
    // component that spreads an explicit `undefined` sends "the value undefined" where the
    // consumer said nothing.
    const { seen } = await mount();
    expect(seen[0]?.options).not.toHaveProperty("presentation");
  });

  it("forwards style and terrain as given, and distinguishes absent from null", async () => {
    const style = { version: 8, layers: [] };
    const given = await mount({ style, terrain: null });
    expect(given.seen[0]?.options.style, "style did not reach the controller").toBe(style);
    expect(given.seen[0]?.options.terrain, "terrain: null is a request, not an absence").toBeNull();

    const absent = await mount();
    expect(absent.seen[0]?.options).not.toHaveProperty("style");
    expect(absent.seen[0]?.options).not.toHaveProperty("terrain");
  });

  it("reports event clicks to the consumer's callback with the id", async () => {
    const clicked: Id[] = [];
    const { seen } = await mount({
      onEventClick: (id: Id) => {
        clicked.push(id);
      },
    });
    const listener = seen[0]?.clickListeners.at(-1);
    expect(listener, "no click listener was wired").toBeDefined();
    listener?.("e1");
    expect(clicked, "the click did not reach the consumer").toEqual(["e1"]);
  });

  it("forwards the sources, without which there is no map", async () => {
    // The one prop whose absence leaves nothing to render, and the one this suite originally
    // had no mutation for — it survived `sources: []` because every other assertion looked
    // past it.
    const { seen } = await mount();
    expect(seen[0]?.options.sources, "sources did not reach the controller").toBe(SOURCES);
  });

  it("keeps forwarding after mount, not only at it", async () => {
    // Everything above observes the *construction* options, so a component that captured its
    // props once — `useMemo(() => mapProps(props), [])`, or a ref read on first render — would
    // satisfy every one of them. What separates "forwards" from "forwarded at mount" is a
    // change arriving after the controller exists, where the setters are the only route.
    const first: EventPresentation = {
      marker: () => ({ kind: "dot", color: "#111" }) as never,
      finishMarker: () => null,
    };
    const second: EventPresentation = {
      marker: () => ({ kind: "dot", color: "#222" }) as never,
      finishMarker: () => ({ kind: "dot", color: "#333" }) as never,
    };
    const mounted = await mount({ presentation: first });
    expect(mounted.seen[0]?.options.presentation).toBe(first);

    await mounted.rerender({
      track: TRACK,
      events: EVENTS,
      store: STORE,
      sources: SOURCES,
      presentation: second,
      // The *same* seam: `create`'s identity is part of MapCanvas's recreation boundary, so a
      // fresh function here would tear the controller down and rebuild it, and the assertion
      // below would pass for that reason instead of the one under test.
      create: mounted.create,
    } as never);

    expect(mounted.seen, "the controller was rebuilt rather than updated").toHaveLength(1);
    expect(
      mounted.seen[0]?.presentations.at(-1),
      "a presentation changed after mount never reached the controller",
    ).toBe(second);
  });

  it("renders its own region around the map", async () => {
    const { container } = await mount();
    expect(container.querySelector(".mapatlas-trip-review")).not.toBeNull();
  });
});
