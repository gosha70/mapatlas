// @vitest-environment happy-dom
// SPDX-License-Identifier: Apache-2.0
import { act, createElement, StrictMode, useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { LatLng, MapEvent, StorageAdapter, Track } from "@mapatlas/core";

/**
 * Hand authoring, wired.
 *
 * **What this lane can see.** The published bindings are doubled — a real draft over a real
 * IndexedDB and a real MapLibre draw mode do not exist in happy-dom — so what is left is the
 * wiring, which is exactly what this increment adds: that a vertex placed on the map reaches the
 * draft, that timing gates the save the way `toTrack()` does, and that a pinned event is written
 * unbound and then bound to the id the save returned. Whether a click on a real canvas produces a
 * vertex is the renderer's question and the browser lane's.
 *
 * The draft double keeps the two behaviours that decide this file's correctness: `append` writes
 * an **untimed** vertex, and `save()` refuses while any vertex is untimed. A double that timed
 * points on append would make every assertion about the timing step vacuous.
 */

const seen = vi.hoisted(() => ({
  map: undefined as Record<string, unknown> | undefined,
  composer: undefined as Record<string, unknown> | undefined,
  saves: 0,
  /** When set, `save()` rejects with it — after the events have been written. */
  rejectSave: undefined as Error | undefined,
  /** Every event the log holds, and every update applied to one. */
  events: [] as MapEvent[],
  updates: [] as MapEvent[],
  /** When set, `addEvent` rejects with it. */
  rejectWrite: undefined as Error | undefined,
  deleted: [] as string[],
}));

const SAVED: Track = {
  id: "authored-1",
  startedAt: 5_000,
  endedAt: 6_000,
  status: "finalized",
  origin: "authored",
  points: [],
  segments: [],
} as unknown as Track;

vi.mock("@mapatlas/react", () => ({
  useTrackDraft: () => {
    const [points, setPoints] = useState<{ lat: number; lng: number; t?: number }[]>([]);
    const append = useCallback((p: LatLng) => {
      // **Untimed on purpose**, as the real binding is: timing is the explicit step, and a double
      // that stamped a time here would make `untimedIndices` permanently empty.
      setPoints((prior) => [...prior, { lat: p.lat, lng: p.lng }]);
    }, []);
    const untimedIndices = points.flatMap((p, i) => (p.t === undefined ? [i] : []));
    return {
      points,
      canUndo: points.length > 0,
      canRedo: false,
      untimedIndices,
      append,
      moveAt: () => undefined,
      insertAt: () => undefined,
      removeAt: () => undefined,
      setTimeAt: () => undefined,
      interpolateTimes: ({ startedAt }: { startedAt: number }) => {
        setPoints((prior) => prior.map((p, i) => ({ ...p, t: startedAt + i * 1_000 })));
      },
      breakAt: () => undefined,
      undo: () => undefined,
      redo: () => undefined,
      save: async () => {
        seen.saves += 1;
        // The real one runs `toTrack()` first, which throws while anything is untimed.
        if (untimedIndices.length > 0)
          throw new Error("cannot finalize a draft with untimed points");
        if (seen.rejectSave !== undefined) throw seen.rejectSave;
        return Promise.resolve(SAVED);
      },
    };
  },

  useEventLog: () => {
    const [all, setAll] = useState<MapEvent[]>([]);
    const addEvent = useCallback(
      async (input: Omit<MapEvent, "id">) => {
        if (seen.rejectWrite !== undefined) throw seen.rejectWrite;
        const written = { ...input, id: `e${String(all.length + 1)}` } as MapEvent;
        setAll((prior) => [...prior, written]);
        seen.events = [...seen.events, written];
        return written;
      },
      [all.length],
    );
    const updateEvent = useCallback(async (event: MapEvent) => {
      seen.updates.push(event);
      setAll((prior) => prior.map((held) => (held.id === event.id ? event : held)));
      return Promise.resolve();
    }, []);
    return { events: all, addEvent, updateEvent, deleteEvent: async () => Promise.resolve() };
  },

  MapCanvas: (props: Record<string, unknown>) => {
    seen.map = props;
    return createElement("button", {
      "data-testid": "map",
      type: "button",
      "data-draw": String(props["drawMode"]),
      // The stub reports which handler it was given rather than throwing, so a test can assert
      // that one mode declined what the other accepts.
      "data-vertices": props["onDraw"] === undefined ? "declined" : "accepted",
      "data-taps": props["onMapTap"] === undefined ? "declined" : "accepted",
      "data-draft": String((props["draft"] as unknown[] | undefined)?.length ?? 0),
      "data-events": String((props["events"] as unknown[] | undefined)?.length ?? 0),
      onClick: () => {
        const draw = props["onDraw"] as { onVertexAdd(at: LatLng): void } | undefined;
        if (draw !== undefined) draw.onVertexAdd({ lat: 1, lng: 2 });
        else (props["onMapTap"] as ((at: LatLng) => void) | undefined)?.({ lat: 3, lng: 4 });
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
          occurredAt: 5_500,
          comment: "a drawn note",
          category: "observation",
          tags: [],
          media: [{ id: "m1", mime: "image/jpeg", blobKey: "blob-1" }],
        } as never);
      },
    });
  },
}));

const { Authoring } = await import("./authoring.js");

let root: Root | undefined;
let host: HTMLElement | undefined;
const saved: Track[] = [];
let cancelled = 0;

const storage = () =>
  ({
    trips: {
      deleteBlob: async (key: string) => {
        seen.deleted.push(key);
        return Promise.resolve();
      },
    } as unknown as StorageAdapter,
    assets: {},
  }) as never;

const render = async () => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      createElement(
        StrictMode,
        null,
        createElement(Authoring, {
          storage: storage(),
          sources: [],
          style: {} as never,
          terrain: null,
          initialCamera: {},
          onSaved: (track: Track) => saved.push(track),
          onCancel: () => {
            cancelled += 1;
          },
        }),
      ),
    );
  });
  return host;
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
  seen.saves = 0;
  seen.rejectSave = undefined;
  seen.rejectWrite = undefined;
  seen.events = [];
  seen.updates = [];
  seen.deleted = [];
  saved.length = 0;
  cancelled = 0;
});

const click = async (selector: string) => {
  const target = host?.querySelector<HTMLElement>(selector);
  if (!target) throw new Error(`no ${selector}`);
  await act(async () => {
    target.click();
  });
};

const status = (): HTMLElement | null => host?.querySelector("#authoring-status") ?? null;
const disabled = (id: string): boolean =>
  host?.querySelector<HTMLButtonElement>(id)?.disabled ?? false;

/** Draw two vertices and time them — the shortest thing that is savable. */
const drawAndTime = async () => {
  await click('[data-testid="map"]');
  await click('[data-testid="map"]');
  await click("#author-times");
};

describe("drawing", () => {
  it("puts a vertex the map reported into the draft, and draws it back", async () => {
    await render();

    await click('[data-testid="map"]');

    expect(status()?.dataset["points"]).toBe("1");
    // The draft goes back to the canvas: a component that collected vertices without handing
    // them back would draw nothing while counting correctly.
    expect(host?.querySelector<HTMLElement>('[data-testid="map"]')?.dataset["draft"]).toBe("1");
  });

  it("gives the map vertex handlers while drawing and taps while pinning, never both", async () => {
    // One map, one tap. A tap that both added a vertex and opened a composer would make every
    // drawn trip carry an event nobody asked for.
    await render();
    const map = () => host?.querySelector<HTMLElement>('[data-testid="map"]');

    expect(map()?.dataset["vertices"]).toBe("accepted");
    expect(map()?.dataset["taps"]).toBe("declined");
    expect(map()?.dataset["draw"]).toBe("true");

    await click("#author-pin");

    expect(map()?.dataset["vertices"]).toBe("declined");
    expect(map()?.dataset["taps"]).toBe("accepted");
    expect(map()?.dataset["draw"]).toBe("false");
  });
});

describe("timing", () => {
  it("refuses to save while a vertex is untimed, and offers it once they are timed", async () => {
    /**
     * **The refusal is the engine's, surfaced before the button rather than after.** `append`
     * writes an untimed vertex and `toTrack()` throws while any remain, so a Save offered here
     * would fail at the store — and inventing a timestamp per click would make the whole timing
     * step vacuous.
     */
    await render();

    await click('[data-testid="map"]');
    await click('[data-testid="map"]');
    expect(status()?.dataset["untimed"]).toBe("2");
    expect(disabled("#author-save"), "a draft with untimed vertices was savable").toBe(true);

    await click("#author-times");

    expect(status()?.dataset["untimed"]).toBe("0");
    expect(disabled("#author-save")).toBe(false);
  });

  it("will not save a single vertex even once it is timed", async () => {
    // **This demo's rule, not the engine's**: `finalizeTrack` would produce a one-point track
    // quite happily. Asserted with the timing already done, so it cannot pass for the timing
    // reason and be mistaken for the engine refusing.
    await render();

    await click('[data-testid="map"]');
    await click("#author-times");

    expect(status()?.dataset["untimed"]).toBe("0");
    expect(disabled("#author-save")).toBe(true);
  });
});

describe("pinning and saving", () => {
  it("writes the pinned event unbound, then binds it to the id the save returned", async () => {
    /**
     * **The whole ordering claim of this increment.** A draft is not a track and has no id until
     * `save()` returns one, so the event cannot carry a `trackId` when it is written. What must
     * not happen is that it stays that way: an unbound event survives in the store with no path
     * back to it from any trip.
     */
    await render();
    await drawAndTime();

    await click("#author-pin");
    await click('[data-testid="map"]');
    await click('[data-testid="composer"]');

    expect(seen.events, "the pinned event was never written").toHaveLength(1);
    expect(seen.events[0]?.trackId, "the event was written already bound to something").toBe(
      undefined,
    );

    await click("#author-save");

    expect(seen.updates.map((event) => event.trackId)).toStrictEqual([SAVED.id]);
    expect(saved).toStrictEqual([SAVED]);
  });

  it("keeps the events and the geometry when the save fails, so a retry binds them", async () => {
    // Discarding here would delete a person's photograph and comment because a save failed, and
    // clearing the draft would lose what they drew.
    await render();
    await drawAndTime();
    await click("#author-pin");
    await click('[data-testid="map"]');
    await click('[data-testid="composer"]');

    seen.rejectSave = new Error("the store is full");
    await click("#author-save");

    expect(host?.querySelector("#authoring-failure")?.textContent ?? "").toContain("store is full");
    expect(seen.updates, "an event was bound to a track that was never saved").toStrictEqual([]);
    expect(status()?.dataset["events"]).toBe("1");
    expect(status()?.dataset["points"]).toBe("2");

    seen.rejectSave = undefined;
    await click("#author-save");

    expect(seen.updates.map((event) => event.trackId)).toStrictEqual([SAVED.id]);
  });

  it("gives back the photo when the pinned event cannot be written", async () => {
    // The composer sealed itself before handing the blob over (ADR-0027), so nothing else will
    // ever collect it.
    seen.rejectWrite = new Error("quota exceeded");
    await render();
    await drawAndTime();

    await click("#author-pin");
    await click('[data-testid="map"]');
    await click('[data-testid="composer"]');

    expect(seen.deleted).toStrictEqual(["blob-1"]);
    expect(host?.querySelector("#authoring-failure")?.textContent ?? "").toContain("quota");
    expect(status()?.dataset["events"]).toBe("0");
  });

  it("draws the pinned events on the map it was drawn on", async () => {
    await render();
    await drawAndTime();
    await click("#author-pin");
    await click('[data-testid="map"]');
    await click('[data-testid="composer"]');

    expect(host?.querySelector<HTMLElement>('[data-testid="map"]')?.dataset["events"]).toBe("1");
  });

  it("hands the cancel straight back, without saving anything", async () => {
    await render();
    await drawAndTime();

    await click("#author-cancel");

    expect(cancelled).toBe(1);
    expect(seen.saves).toBe(0);
  });
});
