// @vitest-environment happy-dom
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { LatLng, TileSource, Track } from "@mapatlas/core";
import type { DrawModeHandlers, MapController, MapControllerOptions } from "@mapatlas/maplibre";

import { renderComponent } from "./testing/render-hook.js";
import type { MapCanvasProps } from "./map-canvas.js";
import { MapCanvasInternal } from "./map-canvas.js";

/**
 * A counted controller: every call recorded, every teardown handle refusing a second call.
 *
 * The refusals matter as much as the counts. `off()` and `exitDraw()` called twice, or
 * `destroy()` after `destroy()`, are the defects a recreation boundary breeds — and a fake that
 * tolerated them would let the component pass while double-releasing a live session.
 */
interface FakeController extends MapController {
  readonly calls: string[];
  readonly tapListeners: number;
  readonly clickListeners: number;
  readonly drawSessions: number;
  readonly drawHandlers: DrawModeHandlers[];
  readonly destroyed: boolean;
  fireTap(at: LatLng): void;
  fireVertexAdd(at: LatLng): void;
}

interface Constructed {
  options: MapControllerOptions;
  controller: FakeController;
}

function fakeControllers(): {
  create: (options: MapControllerOptions) => MapController;
  created: Constructed[];
} {
  const created: Constructed[] = [];

  const create = (options: MapControllerOptions): MapController => {
    const calls: string[] = [];
    const taps: ((at: LatLng) => void)[] = [];
    const clicks: ((id: string) => void)[] = [];
    const drawHandlers: DrawModeHandlers[] = [];
    let activeDraw: DrawModeHandlers | undefined;
    let destroyed = false;

    const refuse = (what: string): never => {
      throw new Error(`${what} on controller #${String(created.length)} — a double release`);
    };

    const controller: FakeController = {
      get calls() {
        return calls;
      },
      get tapListeners() {
        return taps.length;
      },
      get clickListeners() {
        return clicks.length;
      },
      get drawSessions() {
        return activeDraw === undefined ? 0 : 1;
      },
      get drawHandlers() {
        return drawHandlers;
      },
      get destroyed() {
        return destroyed;
      },
      setSources: (sources) => {
        calls.push(`setSources:${String(sources.length)}`);
      },
      setTerrain: (terrain) => {
        calls.push(`setTerrain:${terrain === null ? "null" : terrain.sourceId}`);
      },
      setPresentation: (presentation) => {
        calls.push(`setPresentation:${presentation === null ? "null" : "set"}`);
      },
      renderTrack: (track) => {
        calls.push(`renderTrack:${track === null ? "null" : track.id}`);
      },
      renderEvents: (events) => {
        calls.push(`renderEvents:${String(events.length)}`);
      },
      renderDraft: (points) => {
        calls.push(`renderDraft:${points === null ? "null" : String(points.length)}`);
      },
      showLivePosition: (point) => {
        calls.push(`showLivePosition:${point === null ? "null" : String(point.t)}`);
      },
      fitTrack: () => {
        calls.push("fitTrack");
      },
      fitBounds: () => {
        calls.push("fitBounds");
      },
      recenter: () => {
        calls.push("recenter");
      },
      onMapTap: (cb) => {
        taps.push(cb);
        calls.push("onMapTap");
        let off = false;
        return () => {
          if (off) refuse("second unsubscribe of onMapTap");
          off = true;
          taps.splice(taps.indexOf(cb), 1);
        };
      },
      onEventClick: (cb) => {
        clicks.push(cb);
        calls.push("onEventClick");
        let off = false;
        return () => {
          if (off) refuse("second unsubscribe of onEventClick");
          off = true;
          clicks.splice(clicks.indexOf(cb), 1);
        };
      },
      enterDrawMode: (handlers) => {
        if (activeDraw !== undefined) refuse("enterDrawMode while a session is active");
        activeDraw = handlers;
        drawHandlers.push(handlers);
        calls.push("enterDrawMode");
        let exited = false;
        return () => {
          if (exited) return; // the controller documents exit as idempotent
          exited = true;
          activeDraw = undefined;
          calls.push("exitDrawMode");
        };
      },
      destroy: () => {
        if (destroyed) refuse("second destroy");
        destroyed = true;
        calls.push("destroy");
      },
      fireTap: (at) => {
        for (const cb of [...taps]) cb(at);
      },
      fireVertexAdd: (at) => {
        activeDraw?.onVertexAdd(at);
      },
    };
    created.push({ options, controller });
    return controller;
  };
  return { create, created };
}

const SOURCES: TileSource[] = [
  {
    id: "base",
    kind: "raster",
    transport: "template",
    url: "https://t.invalid/{z}",
    attribution: "a",
  },
];

const track = (id: string): Track => ({
  id,
  startedAt: 1,
  status: "finalized",
  origin: "recorded",
  points: [{ lat: 1, lng: 2, t: 1 }],
  segments: [{ id: `${id}-s`, startIndex: 0, endIndex: 0, startedAt: 1 }],
});

type Props = MapCanvasProps & { create: (options: MapControllerOptions) => MapController };

const mount = async (props: Props, strict = false) =>
  renderComponent((p: Props) => MapCanvasInternal(p), props, { strict });

describe("MapCanvas — construction boundary", () => {
  it("constructs once, in an effect, and reconciles data props through it", async () => {
    const { create, created } = fakeControllers();
    const harness = await mount({ create, sources: SOURCES });
    expect(created).toHaveLength(1);

    await harness.rerender({ create, sources: SOURCES, track: track("t1") });
    await harness.rerender({ create, sources: SOURCES, track: track("t1"), events: [] });

    expect(created, "a data prop change rebuilt the controller").toHaveLength(1);
    expect(created[0]?.controller.calls).toContain("renderTrack:t1");
    await harness.unmount();
  });

  it("passes sources, style, terrain and presentation to the constructor", async () => {
    const { create, created } = fakeControllers();
    const harness = await mount({
      create,
      sources: SOURCES,
      style: "https://style.invalid/s.json",
      terrain: { sourceId: "dem" },
    });

    const options = created[0]?.options;
    expect(options?.sources).toBe(SOURCES);
    expect(options?.style).toBe("https://style.invalid/s.json");
    expect(options?.terrain).toEqual({ sourceId: "dem" });
    await harness.unmount();
  });

  it("opens at the camera it was given", async () => {
    // **The prop the first consumer needed.** Without it the map opens at MapLibre's world
    // view, so an app over a regional archive draws a grey box while every "a canvas exists"
    // assertion still passes — which is how this arrived: T7.1's shell, over real archives,
    // fetched two headers and not one tile.
    const { create, created } = fakeControllers();
    const harness = await mount({
      create,
      sources: SOURCES,
      initialCamera: { center: { lat: 45.84, lng: 6.865 }, zoom: 12 },
    });

    expect(created[0]?.options.center).toEqual({ lat: 45.84, lng: 6.865 });
    expect(created[0]?.options.zoom).toBe(12);
    await harness.unmount();
  });

  it("passes neither key when no camera is given, so the controller's default stands", async () => {
    // Absent, not `undefined`. Under `exactOptionalPropertyTypes` the two are different values,
    // and a controller reading `"zoom" in options` would take an explicit `undefined` for a
    // caller's choice — which is how a default silently stops applying.
    const { create, created } = fakeControllers();
    const harness = await mount({ create, sources: SOURCES });

    expect(created[0]?.options).not.toHaveProperty("center");
    expect(created[0]?.options).not.toHaveProperty("zoom");
    await harness.unmount();
  });

  it("takes half a camera as half a camera", async () => {
    const { create, created } = fakeControllers();
    const harness = await mount({ create, sources: SOURCES, initialCamera: { zoom: 9 } });

    expect(created[0]?.options.zoom).toBe(9);
    expect(
      created[0]?.options,
      "a centre was invented for a caller who named none",
    ).not.toHaveProperty("center");
    await harness.unmount();
  });

  it("does not move the map when the camera prop changes, and never rebuilds for it", async () => {
    // **Construction-only is the claim, so this is the test that says so.** A parent that
    // re-renders with a fresh object literal — the ordinary React case — must not drag the
    // camera out from under a user mid-pan, and must not churn a live WebGL context either.
    const { create, created } = fakeControllers();
    const harness = await mount({
      create,
      sources: SOURCES,
      initialCamera: { center: { lat: 1, lng: 2 }, zoom: 5 },
    });

    await harness.rerender({
      create,
      sources: SOURCES,
      initialCamera: { center: { lat: 50, lng: 50 }, zoom: 15 },
    });

    expect(created, "a camera change rebuilt the controller").toHaveLength(1);
    expect(
      created[0]?.controller.calls.filter((call) => call.startsWith("recenter")),
      "the camera prop moved a map it does not track",
    ).toEqual([]);
    await harness.unmount();
  });

  it("destroys and recreates only when style changes, restoring the whole current state", async () => {
    // **The plan's recreation test: every other prop held constant.** The replacement must
    // carry the entire current state, and "carry" means logically present — sources, terrain
    // and presentation may arrive in the constructor options, while track, events, live point,
    // draft, listeners and the draw session necessarily use controller operations. This is the
    // test that kills the implementation where per-prop effects simply do not rerun because
    // their own dependencies did not change.
    const { create, created } = fakeControllers();
    const presentation = { marker: () => ({ color: "#123456" }) } as never;
    const full: Props = {
      create,
      sources: SOURCES,
      style: "one",
      terrain: { sourceId: "dem" },
      presentation,
      track: track("t1"),
      events: [],
      livePoint: { lat: 1, lng: 2, t: 77 },
      draft: [{ lat: 3, lng: 4 }],
      drawMode: true,
      onDraw: { onVertexAdd: () => undefined, onVertexMove: () => undefined },
      onMapTap: () => undefined,
      onEventClick: () => undefined,
    };
    const harness = await mount(full);
    const first = created[0]!.controller;
    expect(first.drawSessions).toBe(1);

    await harness.rerender({ ...full, style: "two" });

    // The old session is completely released: draw exited, listeners gone, destroy called.
    expect(first.destroyed).toBe(true);
    expect(first.calls).toContain("exitDrawMode");
    expect(first.tapListeners).toBe(0);
    expect(first.clickListeners).toBe(0);

    // The replacement carries everything.
    expect(created).toHaveLength(2);
    const second = created[1]!;
    expect(second.options.style).toBe("two");
    expect(second.options.sources).toBe(SOURCES);
    expect(second.options.terrain).toEqual({ sourceId: "dem" });
    expect(second.options.presentation).toBe(presentation);
    expect(second.controller.calls).toContain("renderTrack:t1");
    expect(second.controller.calls).toContain("renderEvents:0");
    expect(second.controller.calls).toContain("showLivePosition:77");
    expect(second.controller.calls).toContain("renderDraft:1");
    expect(second.controller.tapListeners).toBe(1);
    expect(second.controller.clickListeners).toBe(1);
    expect(second.controller.drawSessions).toBe(1);
    await harness.unmount();
  });

  it("holds one live controller under StrictMode", async () => {
    // Mount-cleanup-remount must destroy the first construction; two live controllers is two
    // WebGL contexts on one container.
    const { create, created } = fakeControllers();
    const harness = await mount({ create, sources: SOURCES }, true);

    const live = created.filter((c) => !c.controller.destroyed);
    expect(live).toHaveLength(1);
    expect(created.length - live.length, "earlier constructions were not destroyed").toBe(
      created.length - 1,
    );

    await harness.unmount();
    expect(created.every((c) => c.controller.destroyed)).toBe(true);
  });
});

describe("MapCanvas — absent props clear", () => {
  it("clears each layer when its prop disappears", async () => {
    const { create, created } = fakeControllers();
    const full: Props = {
      create,
      sources: SOURCES,
      track: track("t1"),
      events: [],
      livePoint: { lat: 1, lng: 2, t: 5 },
      draft: [{ lat: 3, lng: 4 }],
    };
    const harness = await mount(full);
    const controller = created[0]!.controller;
    controller.calls.length = 0;

    await harness.rerender({ create, sources: SOURCES });

    expect(controller.calls).toContain("renderTrack:null");
    expect(controller.calls).toContain("renderEvents:0");
    expect(controller.calls).toContain("showLivePosition:null");
    expect(controller.calls).toContain("renderDraft:null");
    await harness.unmount();
  });
});

describe("MapCanvas — presence is lifecycle, identity is data", () => {
  it("keeps one subscription across listener identity changes, calling the latest", async () => {
    const { create, created } = fakeControllers();
    const seen: string[] = [];
    const harness = await mount({ create, sources: SOURCES, onMapTap: () => seen.push("first") });
    const controller = created[0]!.controller;
    expect(controller.tapListeners).toBe(1);

    await harness.rerender({ create, sources: SOURCES, onMapTap: () => seen.push("second") });

    // **Cumulative, not at-rest.** An unsubscribe-and-resubscribe churn ends with one listener
    // too — the at-rest count cannot see it, and the first version of this assertion did not.
    expect(
      controller.calls.filter((c) => c === "onMapTap"),
      "identity change churned the subscription",
    ).toHaveLength(1);
    expect(controller.tapListeners).toBe(1);
    controller.fireTap({ lat: 1, lng: 2 });
    expect(seen).toEqual(["second"]);
    await harness.unmount();
  });

  it("unsubscribes when the listener prop is removed, and resubscribes when it returns", async () => {
    const { create, created } = fakeControllers();
    const harness = await mount({ create, sources: SOURCES, onMapTap: () => undefined });
    const controller = created[0]!.controller;
    expect(controller.tapListeners).toBe(1);

    await harness.rerender({ create, sources: SOURCES });
    expect(controller.tapListeners, "removal did not unsubscribe").toBe(0);

    await harness.rerender({ create, sources: SOURCES, onMapTap: () => undefined });
    expect(controller.tapListeners).toBe(1);
    await harness.unmount();
  });

  it("keeps one draw session across onDraw identity changes, delivering to the latest", async () => {
    const { create, created } = fakeControllers();
    const seen: string[] = [];
    const drawWith = (label: string): DrawModeHandlers => ({
      onVertexAdd: () => seen.push(label),
      onVertexMove: () => undefined,
    });
    const harness = await mount({
      create,
      sources: SOURCES,
      drawMode: true,
      onDraw: drawWith("first"),
    });
    const controller = created[0]!.controller;
    expect(controller.drawSessions).toBe(1);

    await harness.rerender({
      create,
      sources: SOURCES,
      drawMode: true,
      onDraw: drawWith("second"),
    });

    // Cumulative for the same reason as the listener test: an exit-and-re-enter ends with one
    // active session, and only the total entry count can see the churn.
    expect(controller.drawHandlers, "identity change re-entered draw mode").toHaveLength(1);
    expect(controller.calls.filter((c) => c === "enterDrawMode")).toHaveLength(1);
    controller.fireVertexAdd({ lat: 1, lng: 2 });
    expect(seen).toEqual(["second"]);
    await harness.unmount();
  });

  it("exits when onDraw disappears while drawMode stays true, and re-enters when it returns", async () => {
    // **The presence half — the one a suite proving only identity cannot see.** A session left
    // alive after its handlers disappeared would keep editing into callbacks that no longer
    // exist.
    const { create, created } = fakeControllers();
    const onDraw: DrawModeHandlers = {
      onVertexAdd: () => undefined,
      onVertexMove: () => undefined,
    };
    const harness = await mount({ create, sources: SOURCES, drawMode: true, onDraw });
    const controller = created[0]!.controller;
    expect(controller.drawSessions).toBe(1);

    await harness.rerender({ create, sources: SOURCES, drawMode: true });
    expect(controller.drawSessions, "the session outlived its handlers").toBe(0);

    await harness.rerender({ create, sources: SOURCES, drawMode: true, onDraw });
    expect(controller.drawSessions).toBe(1);
    await harness.unmount();
  });

  it("toggling drawMode enters and exits exactly once each way", async () => {
    const { create, created } = fakeControllers();
    const onDraw: DrawModeHandlers = {
      onVertexAdd: () => undefined,
      onVertexMove: () => undefined,
    };
    const harness = await mount({ create, sources: SOURCES, onDraw });
    const controller = created[0]!.controller;
    expect(controller.drawSessions, "drawMode absent must not enter").toBe(0);

    await harness.rerender({ create, sources: SOURCES, drawMode: true, onDraw });
    expect(controller.drawSessions).toBe(1);
    expect(controller.calls.filter((c) => c === "enterDrawMode")).toHaveLength(1);

    await harness.rerender({ create, sources: SOURCES, drawMode: false, onDraw });
    expect(controller.drawSessions).toBe(0);
    expect(controller.calls.filter((c) => c === "exitDrawMode")).toHaveLength(1);
    await harness.unmount();
  });
});
