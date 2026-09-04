// @vitest-environment happy-dom
// SPDX-License-Identifier: Apache-2.0

import { act } from "react";
import { describe, expect, it } from "vitest";

import type { Id, MapEvent, MediaRef, StorageAdapter, TileSource, Track } from "@mapatlas/core";
import type { EventPresentation, MapController, MapControllerOptions } from "@mapatlas/maplibre";

import { renderComponent } from "./testing/render-hook.js";
import type { ReplayClock } from "./trip-review.js";
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
  live: ({ lat: number; lng: number; t: number } | null)[];
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
      live: [],
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
      showLivePosition: (point: { lat: number; lng: number; t: number } | null) => {
        record.live.push(point);
      },
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

/**
 * **Fixtures the compiler owns.** These were written with `as never`, which is assignable to
 * everything and so disabled all checking — the track below was missing `segments`, `status`
 * and `origin`, compiled anyway, passed increment 1, and failed with a runtime
 * `TypeError: segments is not iterable` two increments later when `computeStats` first read
 * one. This source literal was worse: it carried a `tiles` array `TileSource` does not declare.
 * `satisfies` keeps the inferred literal type while making the compiler check the shape, so the
 * next missing or invented field is a compile error here rather than a failure downstream.
 */
const SOURCES = [
  {
    id: "base",
    kind: "raster",
    transport: "template",
    url: "https://example.invalid/{z}/{x}/{y}.png",
    attribution: "x",
  },
] satisfies TileSource[];

const TRACK = {
  id: "t1",
  startedAt: 1_000,
  endedAt: 2_000,
  status: "finalized",
  origin: "recorded",
  points: [
    { lat: 59.3, lng: 18.0, t: 1_000 },
    { lat: 59.4, lng: 18.1, t: 2_000 },
  ],
  segments: [{ id: "s1", startIndex: 0, endIndex: 1, startedAt: 1_000, endedAt: 2_000 }],
} satisfies Track;

const EVENTS = [
  { id: "e1", position: { lat: 59.35, lng: 18.05 }, occurredAt: 1_500, media: [], tags: [] },
] satisfies MapEvent[];

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

/**
 * A track whose samples are **unevenly spaced, with a pause**, because the two bars this
 * section exists for both collapse on an evenly-spaced fixture: a time plot and an index plot
 * coincide, and `movingTimeMs` equals `durationMs`.
 *
 * Two segments — 0..1s and 9..10s — with an 8s stop between them.
 */
const UNEVEN = {
  id: "t2",
  startedAt: 0,
  endedAt: 10_000,
  status: "finalized",
  origin: "recorded",
  points: [
    { lat: 59.3, lng: 18.0, t: 0, channels: { heartRateBpm: 60 } },
    { lat: 59.31, lng: 18.0, t: 1_000, channels: { heartRateBpm: 72.6 } },
    { lat: 59.32, lng: 18.0, t: 9_000, channels: { heartRateBpm: 90 } },
    { lat: 59.33, lng: 18.0, t: 10_000, channels: { heartRateBpm: 120 } },
  ],
  segments: [
    { id: "s1", startIndex: 0, endIndex: 1, startedAt: 0, endedAt: 1_000 },
    { id: "s2", startIndex: 2, endIndex: 3, startedAt: 9_000, endedAt: 10_000 },
  ],
  channels: [{ key: "heartRateBpm", label: "Heart rate", unit: "bpm" }],
} satisfies Track;

/** Let queued microtasks settle inside `act`, so a resolved blob's state update commits. */
async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** The one element matching `selector`, or a loud failure naming what is missing. */
function find<T extends Element>(container: ParentNode, selector: string): T {
  const element = container.querySelector<T>(selector);
  if (element === null) throw new Error(`no element matches ${selector}`);
  return element;
}

/**
 * Activate a node, refusing if it has already left the document.
 *
 * React 18 delegates events at the root, so a detached node's `click()` reaches no handler at
 * all — a silent no-op, not an error. The composer's suite learned this the hard way; the same
 * convention applies here.
 */
function clickLive(node: HTMLElement, what: string): void {
  if (!node.isConnected) {
    throw new Error(`${what} is detached: clicking it would reach no handler and prove nothing`);
  }
  node.click();
}

/**
 * Move a range input the way a user does, as far as React can tell.
 *
 * Assigning `.value` directly is not enough: React keeps a value tracker per input and treats
 * an event whose value matches the tracker as "no change", so the handler never fires — the
 * input visibly holds the new value while the component never hears about it. Going through
 * the prototype's setter updates the element without updating the tracker, which is what makes
 * the dispatched event look like a real edit.
 */
function setRange(input: HTMLInputElement, value: number): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (setter === undefined) throw new Error("no value setter on HTMLInputElement.prototype");
  setter.call(input, String(value));
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

const chartRegion = (c: ParentNode): Element | null => c.querySelector(".mapatlas-trip-charts");

/** Every plotted x, in document order, across however many polylines the chart is drawn as. */
const chartXs = (c: ParentNode): number[] =>
  [...c.querySelectorAll(".mapatlas-trip-chart-line")].flatMap((el) =>
    (el.getAttribute("points") ?? "").split(" ").map((pair) => Number(pair.split(",")[0])),
  );

describe("TripReview — stats and channel charts (T5.4 increment 2)", () => {
  it("renders stats from computeStats, excluding the pause from moving time", async () => {
    // The single-implementation bar, killed by a value rather than a spy: `movingTimeMs` sums
    // the segments and excludes the 8s stop, while any local walk of the points sums straight
    // through it. 0:00:10 total against 0:00:02 moving is the difference.
    const { container } = await mount({ track: UNEVEN });
    const text = container.querySelector(".mapatlas-trip-stats")?.textContent ?? "";
    expect(text, "duration must span the whole trip").toContain("0:00:10");
    expect(text, "moving time must exclude the pause").toContain("0:00:02");
  });

  it("charts a channel against time, not sample index", async () => {
    // The middle samples sit at 1s and 9s of a 10s span — 10% and 90% across. An index plot
    // would place them at 33% and 67%, which draws the stop as though the trip continued.
    const { container } = await mount({ track: UNEVEN });
    const xs = chartXs(container);
    expect(xs, "four samples across however many polylines").toHaveLength(4);
    expect(xs[1], "the 1s sample belongs at 10% of the width, not 33%").toBeCloseTo(30, 0);
    expect(xs[2], "the 9s sample belongs at 90% of the width, not 67%").toBeCloseTo(270, 0);
  });

  it("breaks the chart line at a pause, as the map breaks the track line", async () => {
    // The map holds no line across a pause and ADR-0030 carries that to the replay marker; a
    // chart drawn as one polyline would be the single surface asserting the trip continued
    // through the stop at some rate. One polyline per segment, sharing the time axis.
    const { container } = await mount({ track: UNEVEN });
    const polylines = [...container.querySelectorAll(".mapatlas-trip-chart-line")];
    expect(polylines, "one line per segment, not one across the pause").toHaveLength(2);

    const spans = polylines.map((el) => {
      const xs = (el.getAttribute("points") ?? "")
        .split(" ")
        .map((pair) => Number(pair.split(",")[0]));
      return [Math.min(...xs), Math.max(...xs)] as const;
    });
    // Neither line may span the gap between 1s (x=30) and 9s (x=270).
    for (const [from, to] of spans) {
      expect(to - from, "a line crossed the pause").toBeLessThan(60);
    }
  });

  /** Non-English label and unit on purpose: nothing here may be derived, only carried. */
  const LOCALISED = {
    ...UNEVEN,
    channels: [{ key: "heartRateBpm", label: "Puls", unit: "slag/min", precision: 0 }],
  } satisfies Track;

  const caption = (c: ParentNode): string =>
    c.querySelector(".mapatlas-trip-chart figcaption")?.textContent ?? "";

  it("gives the chart an accessible name from the descriptor", async () => {
    // `role="img"` without a name is an unnamed image to a screen reader, and the name has to
    // come from the descriptor like everything else the chart says.
    const { container } = await mount({ track: LOCALISED });
    const svg = container.querySelector(".mapatlas-trip-chart svg");
    expect(svg?.getAttribute("role")).toBe("img");
    const name = svg?.getAttribute("aria-label") ?? "";
    expect(name, "an image role needs an accessible name").not.toBe("");
    expect(name, "named from the descriptor, verbatim").toContain("Puls");
    expect(name).toContain("slag/min");
  });

  it("renders the descriptor's label and unit verbatim", async () => {
    const { container } = await mount({ track: LOCALISED });
    expect(caption(container), "the label is the consumer's, verbatim").toContain("Puls");
    expect(caption(container), "so is the unit").toContain("slag/min");
  });

  it("formats the channel average at the descriptor's precision", async () => {
    // Its own test so the falsification table can name one killer per row. `precision: 0`
    // against a fractional average is the discriminating fixture — default formatting shows a
    // decimal, so a component ignoring `precision` fails here and nowhere else.
    const { container } = await mount({ track: LOCALISED });
    expect(caption(container), "precision 0 must round away the fraction").toMatch(
      /\b86 slag\/min\b/,
    );
    expect(caption(container), "no fraction may leak past precision 0").not.toMatch(/\d\.\d/);
  });

  it("shows the chart region when a channel is chartable — the positive control", async () => {
    // Without this, the five absence assertions below could all pass on a selector typo.
    const { container } = await mount({ track: UNEVEN });
    expect(chartRegion(container), "a chartable channel must produce the region").not.toBeNull();
  });

  describe("the five readings of 'no channels' — the region is absent, not empty", () => {
    it("1. no descriptors on the track", async () => {
      // Built by *omitting* the key, not by setting it to `undefined`:
      // `exactOptionalPropertyTypes` rejects the second, which is the same distinction the
      // component's own conditional spreads rest on.
      const noDescriptors: Track = { ...UNEVEN };
      delete noDescriptors.channels;
      const { container } = await mount({ track: noDescriptors });
      expect(chartRegion(container)).toBeNull();
    });

    it("2. a descriptor with no samples", async () => {
      const track = {
        ...UNEVEN,
        channels: [{ key: "depthM", label: "Depth", unit: "m" }],
      } satisfies Track;
      expect(chartRegion((await mount({ track })).container)).toBeNull();
    });

    it("3. samples whose key has no descriptor", async () => {
      // Data alone is not chartable: no label, no unit, and inventing them would be the engine
      // learning what the number means (ADR-0009).
      const track = { ...UNEVEN, channels: [] } satisfies Track;
      expect(chartRegion((await mount({ track })).container)).toBeNull();
    });

    it("4. a channels prop naming nothing that matches", async () => {
      const { container } = await mount({ track: UNEVEN, channels: ["cadenceRpm"] });
      expect(chartRegion(container)).toBeNull();
    });

    it("5. channels given as an empty array", async () => {
      const { container } = await mount({ track: UNEVEN, channels: [] });
      expect(chartRegion(container)).toBeNull();
    });
  });

  it("charts only the requested subset when channels names one", async () => {
    const track = {
      ...UNEVEN,
      channels: [
        { key: "heartRateBpm", label: "Heart rate", unit: "bpm" },
        { key: "depthM", label: "Depth", unit: "m" },
      ],
      points: UNEVEN.points.map((p) => ({ ...p, channels: { ...p.channels, depthM: 3 } })),
    } satisfies Track;
    const { container } = await mount({ track, channels: ["depthM"] });
    const charts = [...container.querySelectorAll(".mapatlas-trip-chart")].map((el) =>
      el.getAttribute("data-channel"),
    );
    expect(charts).toEqual(["depthM"]);
  });
});

describe("TripReview — photos (T5.4 increment 3, ADR-0028)", () => {
  /** Records every store call, so "no lookup" is a fact about the adapter, not an inference. */
  function photoStore(blobs: Record<string, Blob>): {
    store: StorageAdapter;
    lookups: string[];
    revoked: string[];
    restore: () => void;
  } {
    const lookups: string[] = [];
    const revoked: string[] = [];
    const created = new Map<Blob, string>();
    let next = 0;
    const realCreate = URL.createObjectURL;
    const realRevoke = URL.revokeObjectURL;
    URL.createObjectURL = (blob: Blob): string => {
      next += 1;
      const url = `blob:fake/${String(next)}`;
      created.set(blob, url);
      return url;
    };
    URL.revokeObjectURL = (url: string): void => {
      revoked.push(url);
    };
    const store = {
      getBlob: (key: string): Promise<Blob | undefined> => {
        lookups.push(key);
        return Promise.resolve(blobs[key]);
      },
    } as unknown as StorageAdapter;
    return {
      store,
      lookups,
      revoked,
      restore: () => {
        URL.createObjectURL = realCreate;
        URL.revokeObjectURL = realRevoke;
      },
    };
  }

  const eventWith = (media: MediaRef[]): MapEvent =>
    ({
      id: `e-${media[0]?.id ?? "none"}`,
      position: { lat: 59.35, lng: 18.05 },
      occurredAt: 1_500,
      media,
      tags: [],
    }) satisfies MapEvent;

  const img = (c: ParentNode): HTMLImageElement | null =>
    c.querySelector(".mapatlas-trip-photo-image");

  it("renders a hosted url directly, without touching the store", async () => {
    const fake = photoStore({});
    try {
      const events = [
        eventWith([{ id: "m1", mime: "image/jpeg", url: "https://x.invalid/a.jpg" }]),
      ];
      const { container } = await mount({ events, store: fake.store });
      expect(img(container)?.getAttribute("src")).toBe("https://x.invalid/a.jpg");
      expect(fake.lookups, "a hosted url must need no lookup").toEqual([]);
    } finally {
      fake.restore();
    }
  });

  it("resolves a blobKey through the store and renders it", async () => {
    const fake = photoStore({ k1: new Blob([new Uint8Array([1, 2])], { type: "image/jpeg" }) });
    try {
      const events = [eventWith([{ id: "m1", mime: "image/jpeg", blobKey: "k1" }])];
      const { container } = await mount({ events, store: fake.store });
      await flushMicrotasks();
      expect(fake.lookups).toEqual(["k1"]);
      expect(img(container)?.getAttribute("src")).toMatch(/^blob:fake\//);
    } finally {
      fake.restore();
    }
  });

  it("says a blobKey the store does not hold is unavailable, rather than showing nothing", async () => {
    // The case the required store was argued for: the event records that a photo exists, so
    // rendering nothing would misreport it as having none.
    const fake = photoStore({});
    try {
      const events = [eventWith([{ id: "m1", mime: "image/jpeg", blobKey: "missing" }])];
      const { container } = await mount({ events, store: fake.store });
      await flushMicrotasks();
      expect(fake.lookups).toEqual(["missing"]);
      expect(img(container), "nothing may be rendered as an image").toBeNull();
      expect(
        container.querySelector(".mapatlas-trip-photo-missing")?.textContent,
        "the absence must be stated, not silent",
      ).toContain("unavailable");
    } finally {
      fake.restore();
    }
  });

  it("revokes object URLs when the media list changes under it", async () => {
    // The revocation a mount/unmount-only test never reaches: a review that swaps trips would
    // otherwise leak every previous trip's URLs for as long as the page lives.
    const fake = photoStore({
      k1: new Blob([new Uint8Array([1])], { type: "image/jpeg" }),
      k2: new Blob([new Uint8Array([2])], { type: "image/jpeg" }),
    });
    try {
      const first = [eventWith([{ id: "m1", mime: "image/jpeg", blobKey: "k1" }])];
      const mounted = await mount({ events: first, store: fake.store });
      await flushMicrotasks();
      const firstUrl = img(mounted.container)?.getAttribute("src");
      expect(firstUrl).toMatch(/^blob:fake\//);

      await mounted.rerender({
        track: TRACK,
        events: [eventWith([{ id: "m2", mime: "image/jpeg", blobKey: "k2" }])],
        store: fake.store,
        sources: SOURCES,
        create: mounted.create,
      } as never);
      await flushMicrotasks();

      expect(fake.revoked, "the departing photo's url was leaked").toContain(firstUrl);
    } finally {
      fake.restore();
    }
  });

  it("revokes object URLs on unmount", async () => {
    const fake = photoStore({ k1: new Blob([new Uint8Array([1])], { type: "image/jpeg" }) });
    try {
      const mounted = await mount({
        events: [eventWith([{ id: "m1", mime: "image/jpeg", blobKey: "k1" }])],
        store: fake.store,
      });
      await flushMicrotasks();
      const url = img(mounted.container)?.getAttribute("src");
      await mounted.unmount();
      expect(fake.revoked, "unmount leaked the object url").toContain(url);
    } finally {
      fake.restore();
    }
  });

  it("clears a resolved-absent key when the media list moves on", async () => {
    // The stale-`null` case. The URL map holds only keys that resolved to a URL, so pruning
    // from it leaves an absent key's `null` behind — and A → B → A then shows "unavailable"
    // before the re-fetch instead of "Loading", reporting the old answer even if the blob was
    // written in between.
    const blobs: Record<string, Blob> = {};
    const fake = photoStore(blobs);
    try {
      const withMissing = [eventWith([{ id: "m1", mime: "image/jpeg", blobKey: "later" }])];
      const other = [eventWith([{ id: "m2", mime: "image/jpeg", blobKey: "k2" }])];
      blobs["k2"] = new Blob([new Uint8Array([2])], { type: "image/jpeg" });

      const mounted = await mount({ events: withMissing, store: fake.store });
      await flushMicrotasks();
      expect(mounted.container.querySelector(".mapatlas-trip-photo-missing")).not.toBeNull();

      const back = (events: MapEvent[]): never =>
        ({
          track: TRACK,
          events,
          store: fake.store,
          sources: SOURCES,
          create: mounted.create,
        }) as never;
      await mounted.rerender(back(other));
      await flushMicrotasks();

      // The blob arrives while the other trip is on screen.
      blobs["later"] = new Blob([new Uint8Array([9])], { type: "image/jpeg" });
      await mounted.rerender(back(withMissing));

      // Before any re-fetch resolves, the key must read as *loading*, not as the stale answer.
      expect(
        mounted.container.querySelector(".mapatlas-trip-photo-missing"),
        "a stale resolved-absent verdict outlived its media list",
      ).toBeNull();
      await flushMicrotasks();
      expect(mounted.container.querySelector(".mapatlas-trip-photo-image")).not.toBeNull();
    } finally {
      fake.restore();
    }
  });

  it("describes the photo for a screen reader, from the event's own words", async () => {
    const fake = photoStore({});
    try {
      const events = [
        {
          ...eventWith([{ id: "m1", mime: "image/jpeg", url: "https://x.invalid/a.jpg" }]),
          comment: "the heron on the far bank",
        } satisfies MapEvent,
      ];
      const { container } = await mount({ events, store: fake.store });
      expect(
        img(container)?.getAttribute("alt"),
        "the only visual record of the event may not be marked decorative",
      ).toBe("Photo attached to event: the heron on the far bank");

      const silent = [
        eventWith([{ id: "m2", mime: "image/jpeg", url: "https://x.invalid/b.jpg" }]),
      ];
      const second = await mount({ events: silent, store: fake.store });
      const fallback = img(second.container)?.getAttribute("alt") ?? "";
      expect(fallback, "a photo with no comment still needs a description").not.toBe("");
    } finally {
      fake.restore();
    }
  });

  it("renders no photo region for a trip whose events carry none", async () => {
    const fake = photoStore({});
    try {
      const { container } = await mount({ store: fake.store });
      expect(container.querySelector(".mapatlas-trip-photos")).toBeNull();
    } finally {
      fake.restore();
    }
  });
});

describe("TripReview — resolution identity is (store, blobKey)", () => {
  /** Two stores, one URL patch, so a store swap under an unchanged key is expressible. */
  function twoStores(a: Record<string, Blob>, b: Record<string, Blob>) {
    const lookups: string[] = [];
    const revoked: string[] = [];
    let next = 0;
    const realCreate = URL.createObjectURL;
    const realRevoke = URL.revokeObjectURL;
    URL.createObjectURL = (): string => {
      next += 1;
      return `blob:fake/${String(next)}`;
    };
    URL.revokeObjectURL = (url: string): void => {
      revoked.push(url);
    };
    const make = (own: Record<string, Blob>, tag: string): StorageAdapter =>
      ({
        getBlob: (key: string): Promise<Blob | undefined> => {
          lookups.push(`${tag}:${key}`);
          return Promise.resolve(own[key]);
        },
      }) as unknown as StorageAdapter;
    return {
      A: make(a, "A"),
      B: make(b, "B"),
      lookups,
      revoked,
      restore: () => {
        URL.createObjectURL = realCreate;
        URL.revokeObjectURL = realRevoke;
      },
    };
  }

  const KEY = "photo";
  const oneEvent: MapEvent[] = [
    {
      id: "e1",
      position: { lat: 59.35, lng: 18.05 },
      occurredAt: 1_500,
      media: [{ id: "m1", mime: "image/jpeg", blobKey: KEY }],
      tags: [],
    } satisfies MapEvent,
  ];

  it("re-resolves the same key against a replacement store", async () => {
    // Both caches were keyed by blobKey alone, so a store swap under an unchanged key hit
    // `urls.current.has(key)` and short-circuited: B was never asked, and A's URL stayed on
    // screen indefinitely. Identity is the pair, not the key.
    const fake = twoStores(
      { [KEY]: new Blob([new Uint8Array([1])], { type: "image/jpeg" }) },
      { [KEY]: new Blob([new Uint8Array([2])], { type: "image/jpeg" }) },
    );
    try {
      const mounted = await mount({ events: oneEvent, store: fake.A });
      await flushMicrotasks();
      const fromA = mounted.container
        .querySelector(".mapatlas-trip-photo-image")
        ?.getAttribute("src");
      expect(fromA).toMatch(/^blob:fake\//);
      expect(fake.lookups).toEqual([`A:${KEY}`]);

      await mounted.rerender({
        track: TRACK,
        events: oneEvent,
        store: fake.B,
        sources: SOURCES,
        create: mounted.create,
      } as never);
      await flushMicrotasks();

      expect(fake.lookups, "the replacement store was never asked").toContain(`B:${KEY}`);
      expect(fake.revoked, "the previous store's url was leaked").toContain(fromA);
      const fromB = mounted.container
        .querySelector(".mapatlas-trip-photo-image")
        ?.getAttribute("src");
      expect(fromB, "A's resolution was treated as B's").not.toBe(fromA);
    } finally {
      fake.restore();
    }
  });

  it("drops the previous store's Unavailable verdict when the store changes", async () => {
    // The sharper leg: A said absent, B has it. The old `null` must not be shown as B's answer.
    // Named for what the oracle proves — the intervening frame is not separately observable
    // through `act`, so the title does not claim it.
    const fake = twoStores({}, { [KEY]: new Blob([new Uint8Array([2])], { type: "image/jpeg" }) });
    try {
      const mounted = await mount({ events: oneEvent, store: fake.A });
      await flushMicrotasks();
      expect(mounted.container.querySelector(".mapatlas-trip-photo-missing")).not.toBeNull();

      await mounted.rerender({
        track: TRACK,
        events: oneEvent,
        store: fake.B,
        sources: SOURCES,
        create: mounted.create,
      } as never);

      // The stale verdict must be gone. Whether the intervening frame reads "Loading" is not
      // separately observable here — `act` flushes the effect's reset and B's resolution in one
      // batch — so this asserts the checkable half: A's answer is never shown as B's.
      expect(
        mounted.container.querySelector(".mapatlas-trip-photo-missing"),
        "A's verdict was still on screen as though it were B's",
      ).toBeNull();

      await flushMicrotasks();
      expect(mounted.container.querySelector(".mapatlas-trip-photo-image")).not.toBeNull();
    } finally {
      fake.restore();
    }
  });
});

describe("TripReview — the replay cursor (T5.5 increment 2)", () => {
  /**
   * A clock the test drives. A real one makes "advanced by one second" a race, and
   * `requestAnimationFrame` in happy-dom would make it a race against a fake too.
   */
  function testClock(): {
    clock: ReplayClock;
    advance: (ms: number) => Promise<void>;
    scheduled: () => number;
  } {
    let now = 0;
    let scheduled = 0;
    let pending: (() => void) | undefined;
    const clock: ReplayClock = {
      now: () => now,
      schedule: (callback) => {
        scheduled += 1;
        pending = callback;
        return () => {
          pending = undefined;
        };
      },
    };
    return {
      clock,
      scheduled: () => scheduled,
      advance: async (ms) => {
        now += ms;
        await act(async () => {
          pending?.();
        });
      },
    };
  }

  const toggle = (c: ParentNode): HTMLButtonElement =>
    find<HTMLButtonElement>(c, ".mapatlas-trip-replay-toggle");
  const scrub = (c: ParentNode): HTMLInputElement =>
    find<HTMLInputElement>(c, ".mapatlas-trip-replay-scrub");
  /** The position handed to the map, which is the only thing the marker can be drawn from. */
  const marker = (seen: Recorded[]): { lat: number; lng: number; t: number } | undefined =>
    seen[0]?.live.at(-1) ?? undefined;

  it("mounts paused at the first point's timestamp", async () => {
    // ADR-0030: opening a review must not start a time-dependent action on its own.
    const { clock } = testClock();
    const { container, seen } = await mount({ track: UNEVEN, clock });
    expect(toggle(container).textContent, "must not be playing").toBe("Play");
    expect(scrub(container).value).toBe("0");
    expect(marker(seen), "the marker starts on the first point").toMatchObject({
      lat: 59.3,
      lng: 18.0,
      t: 0,
    });
  });

  it("does not advance without an explicit Play", async () => {
    const { clock, advance } = testClock();
    const { container, seen } = await mount({ track: UNEVEN, clock });
    await advance(5_000);
    expect(scrub(container).value, "time passed but the cursor moved").toBe("0");
    expect(marker(seen)?.t).toBe(0);
  });

  it("advances with the clock once played, and Pause freezes it where it stands", async () => {
    const { clock, advance } = testClock();
    const { container } = await mount({ track: UNEVEN, clock });
    await act(async () => {
      clickLive(toggle(container), "Play");
    });
    expect(toggle(container).textContent).toBe("Pause");

    await advance(500);
    expect(scrub(container).value).toBe("500");

    await act(async () => {
      clickLive(toggle(container), "Pause");
    });
    await advance(5_000);
    expect(scrub(container).value, "a paused cursor kept moving").toBe("500");
    expect(toggle(container).textContent).toBe("Play");
  });

  it("scrubs the same cursor the marker is drawn from", async () => {
    // One cursor. The map marker and (next increment) the chart cursor cannot disagree.
    const { clock } = testClock();
    const { container, seen } = await mount({ track: UNEVEN, clock });
    await act(async () => {
      setRange(scrub(container), 500);
    });
    expect(scrub(container).value).toBe("500");
    // Half of the first segment: halfway between (59.3,18.0) and (59.31,18.0).
    expect(marker(seen)?.lat).toBeCloseTo(59.305, 5);
  });

  it("holds the marker still across a pause", async () => {
    // The whole point of ADR-0032 reaching the marker: scrubbing into the stop must not slide.
    const { clock } = testClock();
    const { container, seen } = await mount({ track: UNEVEN, clock });
    const at = async (t: number): Promise<void> => {
      await act(async () => {
        setRange(scrub(container), t);
      });
    };
    await at(5_000);
    const mid = marker(seen);
    await at(8_999);
    expect(marker(seen)?.lat, "the marker moved during a pause").toBe(mid?.lat);
    await at(9_000);
    expect(marker(seen)?.lat, "the next segment must take over when it begins").toBe(59.32);
  });

  it("stops at the end rather than running past it", async () => {
    const { clock, advance } = testClock();
    const { container } = await mount({ track: UNEVEN, clock });
    await act(async () => {
      clickLive(toggle(container), "Play");
    });
    await advance(99_000);
    expect(scrub(container).value, "the cursor ran past the last point").toBe("10000");
    expect(toggle(container).textContent, "playback must stop at the end").toBe("Play");
  });

  it("resets the cursor into range when the track is replaced", async () => {
    // Internal replay state must not survive into a track that never covered that time —
    // `positionAt` would answer `undefined` forever.
    const { clock } = testClock();
    const mounted = await mount({ track: UNEVEN, clock });
    await act(async () => {
      setRange(scrub(mounted.container), 9_000);
    });
    expect(scrub(mounted.container).value).toBe("9000");

    await mounted.rerender({
      track: TRACK,
      events: EVENTS,
      store: STORE,
      sources: SOURCES,
      create: mounted.create,
      clock,
    } as never);

    // TRACK spans 1000..2000; 9000 is outside it entirely.
    expect(scrub(mounted.container).value, "a stale cursor outlived its track").toBe("1000");
  });

  it("bounds the scrub to the track's own endpoints", async () => {
    // The range attributes are what keep the cursor inside the trip: an out-of-range cursor
    // asks `positionAt` for a time the track never covered, which answers `undefined` and
    // leaves the marker nowhere. Asserted on the attributes *and* on the outcome, because the
    // browser clamps before the handler sees the value — a second clamp inside the component
    // would be unfalsifiable, and is not there.
    const { clock } = testClock();
    const { container, seen } = await mount({ track: UNEVEN, clock });
    expect(scrub(container).getAttribute("min"), "bounded by the first point").toBe("0");
    expect(scrub(container).getAttribute("max"), "bounded by the last point").toBe("10000");

    setRange(scrub(container), -5_000);
    await act(async () => undefined);
    expect(scrub(container).value, "a cursor before the trip began").toBe("0");
    expect(marker(seen)?.lat, "the marker must stay on the track").toBe(59.3);

    setRange(scrub(container), 99_000);
    await act(async () => undefined);
    expect(scrub(container).value, "a cursor after the trip ended").toBe("10000");
    expect(marker(seen)?.lat).toBe(59.33);
  });

  it("refuses to play a zero-duration track, and schedules nothing", async () => {
    // One point: `first.t === last.t`, so there is no interval to advance across. Playing it
    // would schedule a tick that can only resolve to the same instant — and, before the guard
    // existed, would flip the control to Pause for a trip that cannot move.
    const instant = {
      ...TRACK,
      points: [{ lat: 1, lng: 2, t: 500 }],
      segments: [{ id: "s1", startIndex: 0, endIndex: 0, startedAt: 500, endedAt: 500 }],
      startedAt: 500,
      endedAt: 500,
    } satisfies Track;
    const { clock, advance, scheduled } = testClock();
    const { container, seen } = await mount({ track: instant, clock });

    expect(scrub(container).value).toBe("500");
    expect(marker(seen), "a finite position, not NaN").toMatchObject({ lat: 1, lng: 2, t: 500 });

    await act(async () => {
      clickLive(toggle(container), "Play");
    });
    expect(toggle(container).textContent, "a zero-duration trip must not enter playback").toBe(
      "Play",
    );
    expect(scheduled(), "nothing may be scheduled for a trip that cannot advance").toBe(0);

    await advance(5_000);
    expect(scrub(container).value).toBe("500");
  });

  it("stops playback when the track is replaced mid-play", async () => {
    // The active-playback case, distinct from replacing while paused: the replacement resets
    // the cursor *and* clears `playing`, so a scheduled tick from the previous trip cannot
    // carry playback into the new one.
    const { clock, advance } = testClock();
    const mounted = await mount({ track: UNEVEN, clock });
    await act(async () => {
      clickLive(toggle(mounted.container), "Play");
    });
    await advance(500);
    expect(scrub(mounted.container).value).toBe("500");
    expect(toggle(mounted.container).textContent).toBe("Pause");

    await mounted.rerender({
      track: TRACK,
      events: EVENTS,
      store: STORE,
      sources: SOURCES,
      create: mounted.create,
      clock,
    } as never);

    expect(scrub(mounted.container).value, "the cursor must land in the new track").toBe("1000");
    expect(toggle(mounted.container).textContent, "playback carried into a different trip").toBe(
      "Play",
    );

    await advance(5_000);
    expect(scrub(mounted.container).value, "a disowned tick kept advancing the cursor").toBe(
      "1000",
    );
  });

  it("draws the chart cursor from the same value as the map marker", async () => {
    // The bar from checkpoint 0. Two surfaces, one cursor: if the chart derived its own time
    // the two could disagree about where the trip was, which is the reason there is one value.
    // Asserted as a correspondence — the chart's x and the marker's position must both be the
    // answer for the *same* t, so a chart reading a different time fails even if it looks
    // plausible on its own.
    const { clock } = testClock();
    const { container, seen } = await mount({ track: UNEVEN, clock });
    const cursorX = (): number =>
      Number(find<Element>(container, ".mapatlas-trip-chart-cursor").getAttribute("x1"));

    setRange(scrub(container), 500);
    await act(async () => undefined);
    // t=500 of a 10 000 ms span across 300 units: 15. And halfway along the first segment.
    expect(cursorX(), "the chart cursor is not at the cursor's time").toBeCloseTo(15, 1);
    expect(marker(seen)?.lat, "the marker is not at the cursor's time").toBeCloseTo(59.305, 5);

    setRange(scrub(container), 9_500);
    await act(async () => undefined);
    expect(cursorX(), "the chart cursor did not follow").toBeCloseTo(285, 1);
    expect(marker(seen)?.lat).toBeCloseTo(59.325, 5);
  });

  it("holds the chart cursor and the marker at the same place through a pause", async () => {
    // Both surfaces refuse to interpolate across the stop, but they refuse *differently*: the
    // chart's cursor keeps moving in x because time keeps passing, while the marker holds its
    // position because the track has no observation there. Same value, different projections.
    const { clock } = testClock();
    const { container, seen } = await mount({ track: UNEVEN, clock });
    const cursorX = (): number =>
      Number(find<Element>(container, ".mapatlas-trip-chart-cursor").getAttribute("x1"));

    setRange(scrub(container), 5_000);
    await act(async () => undefined);
    const held = marker(seen)?.lat;
    expect(cursorX(), "time still passes during a pause").toBeCloseTo(150, 1);

    setRange(scrub(container), 8_000);
    await act(async () => undefined);
    expect(cursorX(), "the chart cursor must advance with time").toBeCloseTo(240, 1);
    expect(marker(seen)?.lat, "the marker must not move during the pause").toBe(held);
  });

  it("renders no controls for a track with no points", async () => {
    const { clock } = testClock();
    const empty = { ...TRACK, points: [], segments: [] } satisfies Track;
    const { container } = await mount({ track: empty, clock });
    expect(container.querySelector(".mapatlas-trip-replay")).toBeNull();
  });
});
