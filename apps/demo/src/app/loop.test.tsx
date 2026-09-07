// @vitest-environment happy-dom
// SPDX-License-Identifier: Apache-2.0
import { act, createElement, useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Id, LatLng, MapEvent, StorageAdapter, Track } from "@mapatlas/core";

/**
 * The loop, wired.
 *
 * **What this lane can and cannot see.** The published bindings are doubled here — they build a
 * real MapLibre map and a real IndexedDB log, neither of which exists in happy-dom. What is left
 * is exactly the thing increment 2 adds: *the wiring*. Which prop reaches which component, in
 * which order, carrying which value. Whether the map draws is the browser lane's question.
 *
 * **Each step is asserted on its own**, because the acceptance criterion says so and because the
 * obvious composite assertion — "a review appeared" — is satisfied by a loop that recorded
 * nothing, pinned nothing and attached nothing.
 */

const seen = vi.hoisted(() => ({
  map: undefined as Record<string, unknown> | undefined,
  composer: undefined as Record<string, unknown> | undefined,
  review: undefined as Record<string, unknown> | undefined,
  stops: 0,
  starts: 0,
  /** When set, `addEvent` blocks on this until the test releases it. */
  holdWrite: undefined as { release: () => void; blocked: Promise<void> } | undefined,
}));

/** The trip `stop()` resolves. Two points, so it is a track rather than a placeholder. */
const FINALIZED: Track = {
  id: "trip-1",
  startedAt: 1_000,
  endedAt: 2_000,
  status: "finalized",
  origin: "recorded",
  points: [
    { lat: 1, lng: 2, t: 1_000 },
    { lat: 1.001, lng: 2.001, t: 2_000 },
  ],
  segments: [{ startIndex: 0, endIndex: 1 }],
} as unknown as Track;

vi.mock("@mapatlas/react", () => ({
  // A recorder whose state lives in React, so `start()` and `stop()` re-render the component
  // under test the way the real hook does.
  useTrackRecorder: () => {
    const [status, setStatus] = useState("finalized");
    const start = useCallback(async () => {
      seen.starts += 1;
      setStatus("recording");
      return Promise.resolve();
    }, []);
    const stop = useCallback(async () => {
      seen.stops += 1;
      setStatus("finalized");
      return Promise.resolve(FINALIZED);
    }, []);
    return {
      status,
      start,
      stop,
      pause: () => {
        setStatus("paused");
      },
      resume: () => {
        setStatus("recording");
      },
      livePoint: undefined,
    };
  },

  // An in-memory log with the real one's two behaviours that matter here: ids are assigned on
  // write, and `list` is filtered by `trackId`.
  useEventLog: (_store: StorageAdapter, trackId?: Id) => {
    const [all, setAll] = useState<MapEvent[]>([]);
    const addEvent = useCallback(async (input: Omit<MapEvent, "id">) => {
      // A real write is not instantaneous. Holding it here is the only way to observe what the
      // component permits *during* the gap between issuing the write and it landing.
      if (seen.holdWrite !== undefined) await seen.holdWrite.blocked;
      const written = { ...input, id: `e${String(Date.now())}-${String(Math.random())}` };
      setAll((prior) => [...prior, written]);
      return written;
    }, []);
    const updateEvent = useCallback(async (event: MapEvent) => {
      setAll((prior) => prior.map((held) => (held.id === event.id ? event : held)));
      return Promise.resolve();
    }, []);
    return {
      events: trackId === undefined ? all : all.filter((e) => e.trackId === trackId),
      addEvent,
      updateEvent,
      deleteEvent: async () => Promise.resolve(),
    };
  },

  MapCanvas: (props: Record<string, unknown>) => {
    seen.map = props;
    return createElement("button", {
      "data-testid": "map",
      type: "button",
      // The tap is a real user action in this lane too: the component under test is what decides
      // that a tap opens a composer at that position.
      // Absent when the component declines to accept taps: the stub must report that rather
      // than throw, so a test can assert the tap did nothing.
      "data-taps": props["onMapTap"] === undefined ? "declined" : "accepted",
      onClick: () => {
        (props["onMapTap"] as ((at: LatLng) => void) | undefined)?.({ lat: 10, lng: 20 });
      },
    });
  },

  EventComposer: (props: Record<string, unknown>) => {
    seen.composer = props;
    return createElement("button", {
      "data-testid": "composer",
      type: "button",
      onClick: () => {
        (props["onSave"] as (i: Omit<MapEvent, "id" | "position">) => void)({
          occurredAt: 1_500,
          comment: "a note",
          category: "observation",
          tags: [],
          // The photo. `EventComposer` writes the blob and hands back the ref; what the loop
          // must do is carry it through to storage unchanged.
          media: [{ id: "m1", mime: "image/jpeg", blobKey: "blob-1" }],
        });
      },
    });
  },

  TripReview: (props: Record<string, unknown>) => {
    seen.review = props;
    return createElement("div", { "data-testid": "review" });
  },
}));

const { Loop } = await import("./loop.js");
const { OBSERVATION, WAYPOINT, demoPresentation } = await import("./presentation.js");

let root: Root | undefined;
let host: HTMLElement | undefined;

const storage = () =>
  ({ trips: {} as StorageAdapter, assets: {} }) as unknown as Parameters<typeof Loop>[0]["storage"];

const render = async (): Promise<HTMLElement> => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      createElement(
        StrictMode,
        null,
        createElement(Loop, {
          storage: storage(),
          sources: [],
          style: {},
          terrain: null,
          initialCamera: { center: { lat: 1, lng: 2 }, zoom: 12 },
        }),
      ),
    );
  });
  return host;
};

const click = async (id: string): Promise<void> => {
  const target = host?.querySelector<HTMLElement>(id);
  if (!target) throw new Error(`no ${id}`);
  await act(async () => {
    target.click();
  });
};

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = undefined;
  host?.remove();
  document.body.innerHTML = "";
  seen.map = undefined;
  seen.composer = undefined;
  seen.review = undefined;
  seen.starts = 0;
  seen.stops = 0;
  seen.holdWrite = undefined;
});

/** A write the test settles by hand. */
const holdTheWrite = (): (() => void) => {
  let release = (): void => undefined;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  seen.holdWrite = { release, blocked };
  return release;
};

const disabled = (id: string): boolean =>
  (host?.querySelector<HTMLButtonElement>(id) ?? null)?.disabled ?? false;

describe("record", () => {
  it("starts a recording and says it is recording", async () => {
    const app = await render();
    expect(app.querySelector("#recorder-status")?.getAttribute("data-status")).toBe("finalized");

    await click("#record-start");

    expect(seen.starts).toBe(1);
    expect(app.querySelector("#recorder-status")?.getAttribute("data-status")).toBe("recording");
  });

  it("pauses and resumes the session it is holding", async () => {
    const app = await render();
    await click("#record-start");
    await click("#record-pause");
    expect(app.querySelector("#recorder-status")?.getAttribute("data-status")).toBe("paused");

    await click("#record-resume");
    expect(app.querySelector("#recorder-status")?.getAttribute("data-status")).toBe("recording");
  });
});

describe("pin", () => {
  it("opens the composer where the map was tapped, not at a default", async () => {
    // **The value, not the presence.** A composer opened at a stale or zeroed position writes an
    // event somewhere the user did not tap, and every "the composer opened" assertion passes.
    const app = await render();
    await click("#record-start");
    expect(app.querySelector("#app-composer"), "the composer was open before any tap").toBeNull();

    await click('[data-testid="map"]');

    expect(app.querySelector("#app-composer")).not.toBeNull();
    expect(seen.composer?.["at"]).toStrictEqual({ lat: 10, lng: 20 });
  });

  it("offers the demo's own categories", async () => {
    await render();
    await click("#record-start");
    await click('[data-testid="map"]');

    expect(
      (seen.composer?.["categories"] as { value: string }[]).map((c) => c.value),
    ).toStrictEqual([OBSERVATION, WAYPOINT]);
  });

  it("writes the pinned event at the tapped position", async () => {
    const app = await render();
    await click("#record-start");
    await click('[data-testid="map"]');
    await click('[data-testid="composer"]');

    expect(app.querySelector("#recorder-status")?.getAttribute("data-events")).toBe("1");
    expect((seen.map?.["events"] as MapEvent[])[0]?.position).toStrictEqual({ lat: 10, lng: 20 });
    expect(app.querySelector("#app-composer"), "the composer stayed open after save").toBeNull();
  });
});

describe("photo", () => {
  it("carries the composer's media through to the stored event", async () => {
    // The photo is the step most easily lost: it is written by the composer, and a loop that
    // dropped `media` while keeping the comment would look entirely correct on the map.
    await render();
    await click("#record-start");
    await click('[data-testid="map"]');
    await click('[data-testid="composer"]');

    const pinned = (seen.map?.["events"] as MapEvent[])[0];
    expect(pinned?.media).toHaveLength(1);
    expect(pinned?.media[0]?.blobKey).toBe("blob-1");
  });

  it("wires the analyzer seam explicitly", async () => {
    // The criterion is *zero core changes* when a consumer swaps this: the evidence is that the
    // swap happens at this prop. Left to the component's default, there would be no seam here to
    // point at.
    await render();
    await click("#record-start");
    await click('[data-testid="map"]');

    expect((seen.composer?.["analyzer"] as { id: string } | undefined)?.id).toBeDefined();
    expect((seen.composer?.["analyzer"] as { runsRemotely: boolean }).runsRemotely).toBe(false);
  });
});

describe("review", () => {
  it("binds the trip's events to the finalized track", async () => {
    // **The association that could not happen when the event was written.** `useTrackRecorder`
    // publishes no id while recording, so the event went in unbound; if this step were dropped,
    // the review below would list nothing and still render.
    await render();
    await click("#record-start");
    await click('[data-testid="map"]');
    await click('[data-testid="composer"]');
    await click("#record-stop");

    expect(seen.stops).toBe(1);
    expect((seen.review?.["events"] as MapEvent[])[0]?.trackId).toBe(FINALIZED.id);
  });

  it("reviews the recorded trip, with its event and its photo", async () => {
    const app = await render();
    await click("#record-start");
    await click('[data-testid="map"]');
    await click('[data-testid="composer"]');
    await click("#record-stop");

    expect(app.querySelector("#app-review")).not.toBeNull();
    expect(app.querySelector("#app-map"), "the live map outlived the recording").toBeNull();
    expect((seen.review?.["track"] as Track).id).toBe(FINALIZED.id);

    const reviewed = seen.review?.["events"] as MapEvent[];
    expect(reviewed).toHaveLength(1);
    expect(reviewed[0]?.media[0]?.blobKey, "the photo did not reach the review").toBe("blob-1");
  });

  it("hands the review the demo's presentation and its store", async () => {
    await render();
    await click("#record-start");
    await click("#record-stop");

    // Without the store the review cannot resolve a `blobKey` into an image (ADR-0028).
    expect(seen.review?.["store"]).toBeDefined();
    expect(seen.review?.["presentation"]).toBe(demoPresentation);
  });

  it("starts a fresh trip rather than adding to the reviewed one", async () => {
    const app = await render();
    await click("#record-start");
    await click('[data-testid="map"]');
    await click('[data-testid="composer"]');
    await click("#record-stop");
    expect(app.querySelector("#recorder-status")?.getAttribute("data-events")).toBe("1");

    await click("#record-start");

    expect(
      app.querySelector("#app-review"),
      "the previous review outlived the new trip",
    ).toBeNull();
    expect(app.querySelector("#recorder-status")?.getAttribute("data-events")).toBe("0");
  });
});

describe("the live map", () => {
  it("draws the demo's presentation while recording", async () => {
    await render();
    await click("#record-start");

    expect(seen.map?.["presentation"]).toBe(demoPresentation);
  });

  it("shows only this trip's events, not every event ever stored", async () => {
    // `useEventLog(store, undefined)` lists everything. Drawing that on the live map would put
    // previous trips' pins over the one being recorded — and would still look like a working map.
    await render();
    await click("#record-start");
    await click('[data-testid="map"]');
    await click('[data-testid="composer"]');
    await click("#record-stop");
    await click("#record-start");

    expect(seen.map?.["events"]).toHaveLength(0);
  });
});

describe("a pin belongs to a trip", () => {
  it("declines taps before any recording has started", async () => {
    // **The orphan this prevents.** An event dropped while the recorder is `finalized` is written
    // with no `trackId` and remembered only in `sessionIds` — which the next `start()` clears.
    // It survives in the store with nothing in this UI able to reach it.
    const app = await render();
    expect(app.querySelector("#recorder-status")?.getAttribute("data-status")).toBe("finalized");

    expect(seen.map?.["data-taps"] ?? seen.map?.["onMapTap"]).toBeUndefined();
    await click('[data-testid="map"]');

    expect(app.querySelector("#app-composer"), "a pin was accepted before any trip").toBeNull();
  });

  it("declines taps once the trip is under review", async () => {
    const app = await render();
    await click("#record-start");
    await click("#record-stop");

    expect(app.querySelector("#app-map"), "the live map outlived the recording").toBeNull();
    expect(app.querySelector("#app-composer")).toBeNull();
  });
});

describe("finalizing waits for the trip's writes", () => {
  it("will not stop while a composer is open and unsaved", async () => {
    // Stopping here would finalize a trip while the user is still describing an event on it, and
    // the composer would then be composing onto a trip that no longer accepts events.
    await render();
    await click("#record-start");
    expect(disabled("#record-stop")).toBe(false);

    await click('[data-testid="map"]');

    expect(disabled("#record-stop"), "stop was live with an open composer").toBe(true);
  });

  it("will not stop while a write is still in flight", async () => {
    // **The race.** `stop()` binds the ids written *so far*; a write that has not landed is not
    // among them, so a stop that overtook it would publish a review without the event and leave
    // the event unbound.
    const release = holdTheWrite();
    await render();
    await click("#record-start");
    await click('[data-testid="map"]');
    await click('[data-testid="composer"]');

    expect(disabled("#record-stop"), "stop was live during an unsettled write").toBe(true);

    await act(async () => {
      release();
      await Promise.resolve();
    });

    expect(disabled("#record-stop"), "stop never came back after the write settled").toBe(false);
  });

  it("binds the late write once it settles, rather than losing it", async () => {
    const release = holdTheWrite();
    const app = await render();
    await click("#record-start");
    await click('[data-testid="map"]');
    await click('[data-testid="composer"]');

    await act(async () => {
      release();
      await Promise.resolve();
    });
    await click("#record-stop");

    expect(app.querySelector("#recorder-status")?.getAttribute("data-events")).toBe("1");
    expect((seen.review?.["events"] as MapEvent[])[0]?.trackId).toBe(FINALIZED.id);
  });
});
