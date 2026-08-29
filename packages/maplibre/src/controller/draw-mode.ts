// SPDX-License-Identifier: Apache-2.0

import type { LatLng } from "@mapatlas/core";

import { ENGINE_LAYER } from "./engine-layers.js";
import type { MapEventName, MapLike, MapPointerEvent } from "./environment.js";

/**
 * Vertex editing over the draft geometry the renderer already draws.
 *
 * **Interaction is temporary; rendered draft state is desired state.** Entering draw mode
 * borrows listeners and the map's pan behaviour; exiting gives both back. It does not touch
 * the draft source or its layers, and exiting does not clear what is drawn — `renderDraft`
 * remains the only way to change that. A consumer may well want the line they authored to
 * stay on the map after they stop editing it.
 *
 * That distinction supersedes T4.5's original acceptance wording, which had `exit()` remove
 * the draft layer. T4.3 made engine layers persistent so ordering could not drift; removing
 * one here would put it back at a position no longer beneath the engine anchor.
 */

export interface DrawModeHandlers {
  onVertexAdd(at: LatLng): void;
  onVertexMove(index: number, to: LatLng): void;
  onVertexClick?(index: number): void;
}

export class MapDrawModeError extends Error {
  constructor(detail: string) {
    super(`map draw mode: ${detail}`);
    this.name = "MapDrawModeError";
  }
}

/** Events that begin a gesture, for both pointer families. */
const START_EVENTS: readonly MapEventName[] = ["mousedown", "touchstart"];
/** Events that continue one. */
const MOVE_EVENTS: readonly MapEventName[] = ["mousemove", "touchmove"];
/** Events that finish one, where a click follows and is the gesture's own. */
const END_EVENTS: readonly MapEventName[] = ["mouseup", "touchend"];
/**
 * Events where the gesture is *taken away* rather than finished: the pointer leaves the map,
 * a system gesture claims the touch, a call arrives.
 *
 * Separate from ending because no click follows a cancellation, so the gesture must be
 * forgotten — a remembered one would be consumed by the next unrelated click and swallow it.
 * Both paths release the drag, since the one that does not is the one that leaves the map
 * unpannable.
 */
const CANCEL_EVENTS: readonly MapEventName[] = ["mouseout", "touchcancel"];

/** Which vertex, if any, is drawn under a point. */
function vertexAt(map: MapLike, point: { x: number; y: number }): number | null {
  for (const feature of map.queryRenderedFeatures(point, [ENGINE_LAYER.draftVertex])) {
    const index = feature.properties["index"];
    if (typeof index === "number") return index;
  }
  return null;
}

/**
 * One draw-mode session.
 *
 * Only one may be active at a time. A second would leave two sets of listeners and two
 * claims on `dragPan`, and whichever exited last would decide what panning ends up as —
 * ownership nobody could reason about.
 */
export interface DrawSession {
  /** Idempotent: releases any drag, detaches every listener, restores panning. */
  exit(): void;
}

export function startDrawMode(map: MapLike, handlers: DrawModeHandlers): DrawSession {
  /** The gesture in flight, and whether it has moved. */
  let gesture: { index: number; moved: boolean } | null = null;
  /** What panning was before the engine borrowed it, so it is given back as found. */
  let panningWasEnabled: boolean | null = null;
  let dragListenersAttached = false;

  /**
   * End the active drag, whatever ended it — a release, a cancellation, or a consumer
   * callback that threw. Idempotent, and the only path that restores panning, so no
   * termination can leave the map borrowed.
   */
  function releaseDrag(): void {
    if (dragListenersAttached) {
      for (const type of MOVE_EVENTS) map.off(type, onMove);
      for (const type of END_EVENTS) map.off(type, onEnd);
      for (const type of CANCEL_EVENTS) map.off(type, onCancel);
      dragListenersAttached = false;
    }
    if (panningWasEnabled !== null) {
      // Restored to what it was, not enabled: a consumer may have turned panning off
      // themselves, and handing it back on would be the engine overriding them.
      if (panningWasEnabled) map.dragPan.enable();
      panningWasEnabled = null;
    }
  }

  function onStart(event: MapPointerEvent): void {
    // Any new press invalidates whatever the previous gesture was waiting for. This is where
    // a completed drag's gesture is finally dropped: the renderer sends no click after one, so
    // nothing consumes it at the time, and a gesture left waiting would be consumed by this
    // press's click instead — swallowing the user's next tap, once per drag.
    gesture = null;

    const index = vertexAt(map, event.point);
    if (index === null) return;

    // Before anything else. The renderer decides at gesture start whether it owns the
    // pointer, so disabling panning inside this callback can already be too late.
    event.preventDefault();

    releaseDrag();
    gesture = { index, moved: false };
    panningWasEnabled = map.dragPan.isEnabled();
    map.dragPan.disable();
    for (const type of MOVE_EVENTS) map.on(type, onMove);
    for (const type of END_EVENTS) map.on(type, onEnd);
    for (const type of CANCEL_EVENTS) map.on(type, onCancel);
    dragListenersAttached = true;
  }

  function onMove(event: MapPointerEvent): void {
    if (gesture === null) return;
    gesture.moved = true;
    try {
      handlers.onVertexMove(gesture.index, { lat: event.lngLat.lat, lng: event.lngLat.lng });
    } catch (error) {
      // The consumer's failure ends *this drag*, not draw mode: panning comes back, the
      // temporary listeners go, and the session stays live for another attempt. Rethrown
      // rather than swallowed — it is the consumer's exception and their event dispatch.
      //
      // The gesture is kept, for the same reason a successful one is: a click may still
      // follow, and it must be consumed rather than reported as a click on the vertex whose
      // move just failed. The next press discards it if no click comes.
      releaseDrag();
      throw error;
    }
  }

  /**
   * The gesture finished, so the drag is released — but the gesture itself is **kept**.
   *
   * Whether a click follows cannot be decided here: the renderer sends one for a press that
   * stayed within its movement tolerance and none for a press that passed it, and that
   * threshold is the renderer's, not ours. So the gesture waits, and the two things that can
   * happen to it both do the right thing — a click consumes it, and the next press discards
   * it. Clearing here instead would let a press that drifted a couple of pixels off a vertex
   * fall through to the hit test and be taken as an instruction to add one.
   */
  function onEnd(): void {
    releaseDrag();
  }

  /** The gesture was taken away. No click follows, so nothing should be waiting for one. */
  function onCancel(): void {
    releaseDrag();
    gesture = null;
  }

  function onClick(event: MapPointerEvent): void {
    if (gesture !== null) {
      const { index, moved } = gesture;
      gesture = null;
      // A press that went down on a vertex and did not move is a click on that vertex,
      // wherever the pointer ended up. One that moved is a drag, and a drag is a drag and
      // nothing else — never also a click, and never an instruction to add another vertex.
      if (!moved) handlers.onVertexClick?.(index);
      return;
    }
    const index = vertexAt(map, event.point);
    if (index !== null) {
      handlers.onVertexClick?.(index);
      return;
    }
    handlers.onVertexAdd({ lat: event.lngLat.lat, lng: event.lngLat.lng });
  }

  for (const type of START_EVENTS) map.on(type, onStart);
  map.on("click", onClick);

  return {
    /**
     * Idempotent by composition rather than by a flag.
     *
     * `releaseDrag` already returns early once it has nothing attached and nothing borrowed,
     * and detaching a listener that is not registered is a no-op in the renderer as it is
     * here. A guard on top of that would be state no test could distinguish — and unobservable
     * defensive state is the kind that quietly stops being true.
     */
    exit(): void {
      releaseDrag();
      gesture = null;
      for (const type of START_EVENTS) map.off(type, onStart);
      map.off("click", onClick);
    },
  };
}
