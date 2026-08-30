// SPDX-License-Identifier: Apache-2.0

import type { DraftTrackPoint, LatLng } from "@mapatlas/core";

import { applyMarkerStyle, createMarkerElement } from "../marks/marker-element.js";
import type { MarkerStyle } from "../marks/marker-style.js";
import { ENGINE_LAYER } from "./engine-layers.js";
import type {
  MapEnvironment,
  MapLike,
  MapPointerEvent,
  MapPointerEventName,
  MarkerHandle,
} from "./environment.js";

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
const START_EVENTS: readonly MapPointerEventName[] = ["mousedown", "touchstart"];
/** Events that continue one. */
const MOVE_EVENTS: readonly MapPointerEventName[] = ["mousemove", "touchmove"];
/**
 * Where the gesture is *taken away* rather than finished: a system gesture claims the touch,
 * a call arrives.
 *
 * Routed to the same handler as an ordinary ending, because the borrowed state a cancellation
 * has to release is exactly the state a release has to — and the path that forgets to release
 * is the one that leaves the map unpannable. The retained gesture needs nothing further
 * either: no click follows a cancellation, which is the renderer's rule and one the fake
 * enforces, so nothing consumes the gesture at the time and the next press replaces it.
 *
 * `mouseout` is deliberately **not** here. It bubbles, so it fires when the pointer crosses a
 * marker inside the map, and cancelling there re-enables panning while the button is still
 * down — the remainder of the gesture then pans the map under the vertex being dragged.
 * Ending is handled by a document-level release instead, which also covers the case `mouseout`
 * was standing in for: a release outside the container, which the map never reports.
 */
const CANCEL_EVENTS: readonly MapPointerEventName[] = ["touchcancel"];

/**
 * Screen pixels per keydown, matching MapLibre's own keyboard-marker movement: one pixel for
 * placement, ten with Shift for travel. The coarse step is not a nicety — at one pixel a press,
 * crossing the width of a marker takes a dozen presses and crossing the viewport takes
 * hundreds, which would leave the keyboard path an order of magnitude slower than the pointer
 * one in the task whose point is that they are equals.
 */
const KEYBOARD_NUDGE_PX = 1;
const KEYBOARD_NUDGE_LARGE_PX = 10;
/** Large enough to expose a platform focus ring without covering the painted vertex. */
const KEYBOARD_VERTEX_SIZE_PX: readonly [number, number] = [24, 24];
const FOCUS_OUTLINE = "3px solid #0969da";

const ARROW_DELTA: Readonly<Record<string, readonly [dx: number, dy: number]>> = Object.freeze({
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
});

let nextVertexGroupId = 1;

interface AccessibleVertex {
  index: number;
  readonly indexRef: { current: number };
  readonly element: HTMLElement;
  readonly marker: MarkerHandle;
}

function vertexStyle(index: number, count: number): MarkerStyle {
  return {
    ariaLabel: `Draft vertex ${String(index + 1)} of ${String(count)}`,
    anchor: "center",
    className: "mapatlas-draft-vertex",
    sizePx: [...KEYBOARD_VERTEX_SIZE_PX],
  };
}

/** Which vertex, if any, is drawn under a point. */
function vertexAt(map: MapLike, point: { x: number; y: number }): number | null {
  for (const feature of map.queryRenderedFeatures(point, [ENGINE_LAYER.draftVertex])) {
    const index = feature.properties["index"];
    if (typeof index === "number") return index;
    // A vertex the engine drew but cannot identify. Reading it as empty map would be worse
    // than failing: the click that follows would add a vertex on top of the one already
    // there, which looks like the map ignoring an edit rather than like a defect.
    throw new MapDrawModeError(
      `a draft vertex carries no numeric index (${JSON.stringify(feature.properties)}), so the ` +
        `vertex under the pointer cannot be identified`,
    );
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
  /** Reconcile the keyboard layer to the same indexed points as the painted source. */
  renderDraft(points: readonly DraftTrackPoint[] | null): void;
  /** Give an overlapping draft vertex first claim on a DOM event-mark activation. */
  activateVertexAt(at: LatLng): boolean;
  /** Idempotent: releases interaction, removes the keyboard layer, restores panning. */
  exit(): void;
}

export function startDrawMode(
  map: MapLike,
  environment: MapEnvironment,
  container: HTMLElement,
  initialDraft: readonly DraftTrackPoint[] | null,
  handlers: DrawModeHandlers,
): DrawSession {
  /** The gesture in flight, and whether it has moved. */
  let gesture: { index: number; moved: boolean } | null = null;
  /** What panning was before the engine borrowed it, so it is given back as found. */
  let panningWasEnabled: boolean | null = null;
  let dragListenersAttached = false;
  /** Unsubscribes the document-level release, once a drag is in flight. */
  let stopListeningForRelease: (() => void) | null = null;
  let vertices: AccessibleVertex[] = [];
  let draft: DraftTrackPoint[] = [];
  let rovingIndex = 0;
  let grabbedIndex: number | null = null;
  let renderVersion = 0;

  const groupId = `mapatlas-draft-vertices-${String(nextVertexGroupId)}`;
  nextVertexGroupId += 1;
  const group = environment.document.createElement("div");
  group.id = groupId;
  group.setAttribute("role", "group");
  group.setAttribute("aria-label", "Draft vertices");
  group.className = "mapatlas-draft-vertices";
  group.style.position = "absolute";
  group.style.left = "0";
  group.style.top = "0";
  group.style.width = "1px";
  group.style.height = "1px";
  group.style.pointerEvents = "none";
  container.append(group);

  const live = environment.document.createElement("span");
  live.setAttribute("aria-live", "polite");
  live.setAttribute("aria-atomic", "true");
  live.style.position = "absolute";
  live.style.width = "1px";
  live.style.height = "1px";
  live.style.padding = "0";
  live.style.margin = "-1px";
  live.style.overflow = "hidden";
  live.style.clip = "rect(0, 0, 0, 0)";
  live.style.whiteSpace = "nowrap";
  live.style.border = "0";
  group.append(live);

  function announce(message: string): void {
    live.textContent = message;
  }

  function setGrabbed(index: number | null, announcement?: string): void {
    if (grabbedIndex !== null) {
      vertices[grabbedIndex]?.element.setAttribute("aria-pressed", "false");
    }
    grabbedIndex = index;
    if (index !== null) vertices[index]?.element.setAttribute("aria-pressed", "true");
    if (announcement !== undefined) announce(announcement);
  }

  function toggleGrab(index: number): void {
    if (grabbedIndex === index) {
      setGrabbed(null, `Dropped draft vertex ${String(index + 1)}`);
      return;
    }
    setGrabbed(index, `Grabbed draft vertex ${String(index + 1)}`);
  }

  function syncTabStops(): void {
    for (const vertex of vertices) vertex.element.tabIndex = vertex.index === rovingIndex ? 0 : -1;
  }

  function focusVertex(index: number): void {
    if (vertices.length === 0) return;
    rovingIndex = (index + vertices.length) % vertices.length;
    syncTabStops();
    vertices[rovingIndex]?.element.focus();
  }

  function onVertexKeyDown(index: number, marker: MarkerHandle, event: KeyboardEvent): void {
    const delta = ARROW_DELTA[event.key];
    if (delta === undefined) {
      if (event.key === "Escape" && grabbedIndex === index) {
        event.preventDefault();
        setGrabbed(null, `Cancelled draft vertex ${String(index + 1)}`);
      }
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey) return;

    event.preventDefault();
    if (grabbedIndex !== index) {
      const direction = delta[0] + delta[1];
      focusVertex(index + (direction < 0 ? -1 : 1));
      return;
    }

    const point = draft[index];
    if (point === undefined) return;
    const step = event.shiftKey ? KEYBOARD_NUDGE_LARGE_PX : KEYBOARD_NUDGE_PX;
    const projected = map.project([point.lng, point.lat]);
    const next = map.unproject({
      x: projected.x + delta[0] * step,
      y: projected.y + delta[1] * step,
    });
    const version = renderVersion;
    try {
      handlers.onVertexMove(index, { lat: next.lat, lng: next.lng });
    } catch (error) {
      setGrabbed(null, `Cancelled draft vertex ${String(index + 1)}`);
      throw error;
    }
    // A consumer normally answers `onVertexMove` with `renderDraft`. If it did not, keep the
    // keyboard marker and the next nudge moving from the coordinate just reported rather than
    // repeating the same pixel forever. A synchronous render remains authoritative.
    if (renderVersion === version && draft[index] !== undefined) {
      draft[index] = { ...draft[index], lat: next.lat, lng: next.lng };
      marker.setLngLat(next.lng, next.lat);
    }
  }

  function createAccessibleVertex(
    index: number,
    count: number,
    point: DraftTrackPoint,
  ): AccessibleVertex {
    const indexRef = { current: index };
    const markerRef: { current: MarkerHandle | null } = { current: null };
    const element = createMarkerElement(environment.document, vertexStyle(index, count), () => {
      toggleGrab(indexRef.current);
    });
    element.id = `${groupId}-vertex-${String(index)}`;
    element.setAttribute("aria-pressed", "false");
    element.setAttribute(
      "aria-keyshortcuts",
      "Enter Space Escape ArrowUp ArrowDown ArrowLeft ArrowRight " +
        "Shift+ArrowUp Shift+ArrowDown Shift+ArrowLeft Shift+ArrowRight",
    );
    // Pointer interaction remains canvas hit-testing. If this transparent keyboard layer
    // becomes the pointer target, the draw path bypasses `queryRenderedFeatures` entirely.
    element.style.pointerEvents = "none";
    element.style.borderRadius = "50%";
    element.addEventListener("focus", () => {
      rovingIndex = indexRef.current;
      syncTabStops();
      element.style.outline = FOCUS_OUTLINE;
      element.style.outlineOffset = "2px";
      // No announcement here. The element's own accessible name already says which vertex it
      // is, and `aria-posinset`/`aria-setsize` say where it sits, so a live message on focus
      // is the same sentence twice. It is also the one unthrottled path: a held arrow moves
      // focus on every repeat, and each repeat would write to the region. The live region is
      // for the state changes that have no other channel — grab, drop, cancel.
    });
    element.addEventListener("blur", () => {
      element.style.removeProperty("outline");
      element.style.removeProperty("outline-offset");
      if (grabbedIndex === indexRef.current) {
        // Synchronous by design: focus reaches the canvas before a later keydown can, so the
        // grabbed state must already be over when MapLibre's keyboard handler sees that key.
        setGrabbed(null, `Cancelled draft vertex ${String(indexRef.current + 1)}`);
      }
    });
    element.addEventListener("keydown", (event) => {
      if (markerRef.current !== null) onVertexKeyDown(indexRef.current, markerRef.current, event);
    });

    const marker = environment.createMarker(element, { anchor: "center" });
    markerRef.current = marker;
    const vertex: AccessibleVertex = { index, indexRef, element, marker };
    // MapLibre reads the coordinate during `addTo`; attaching first leaves its internal
    // position undefined and fails before a later `setLngLat` can repair it.
    marker.setLngLat(point.lng, point.lat);
    marker.addTo(map);
    return vertex;
  }

  function reconcileDraft(points: readonly DraftTrackPoint[] | null): void {
    renderVersion += 1;
    const next = (points ?? []).map((point) => ({ ...point }));
    const active = environment.document.activeElement;
    const focusedIndex = vertices.findIndex((vertex) => vertex.element === active);
    const groupWasFocused = active === group;

    // A changed cardinality means indices may now name different vertices. A grabbed vertex
    // cannot survive that ambiguity; cancel before removing anything because DOM removal may
    // move focus to the body without firing blur.
    if (grabbedIndex !== null && next.length !== draft.length) {
      const cancelled = grabbedIndex;
      setGrabbed(null, `Cancelled draft vertex ${String(cancelled + 1)}`);
    }

    const reconciled: AccessibleVertex[] = [];
    for (const [index, point] of next.entries()) {
      const vertex = vertices[index] ?? createAccessibleVertex(index, next.length, point);
      vertex.index = index;
      vertex.indexRef.current = index;
      applyMarkerStyle(vertex.element, vertexStyle(index, next.length));
      vertex.element.id = `${groupId}-vertex-${String(index)}`;
      vertex.element.setAttribute("aria-posinset", String(index + 1));
      vertex.element.setAttribute("aria-setsize", String(next.length));
      vertex.marker.setLngLat(point.lng, point.lat);
      reconciled.push(vertex);
    }
    for (const stale of vertices.slice(next.length)) stale.marker.remove();
    vertices = reconciled;
    draft = next;
    group.setAttribute("aria-owns", vertices.map((vertex) => vertex.element.id).join(" "));

    if (vertices.length === 0) {
      group.tabIndex = 0;
      rovingIndex = 0;
      if (focusedIndex >= 0) group.focus();
      return;
    }

    group.tabIndex = -1;
    if (focusedIndex >= 0) rovingIndex = Math.min(focusedIndex, vertices.length - 1);
    else rovingIndex = Math.min(rovingIndex, vertices.length - 1);
    syncTabStops();

    if (focusedIndex >= vertices.length || groupWasFocused) {
      vertices[rovingIndex]?.element.focus();
    }
  }

  /**
   * End the active drag, whatever ended it — a release, a cancellation, or a consumer
   * callback that threw. Idempotent, and the only path that restores panning, so no
   * termination can leave the map borrowed.
   */
  function releaseDrag(): void {
    if (dragListenersAttached) {
      for (const type of MOVE_EVENTS) map.off(type, onMove);
      for (const type of CANCEL_EVENTS) map.off(type, onEnd);
      stopListeningForRelease?.();
      stopListeningForRelease = null;
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

    // Before the hit test, not after it. A second touch landing on empty map during a drag
    // would otherwise return early and leave the first gesture's listeners attached with
    // panning still disabled — a live drag nobody can drive until some later release.
    releaseDrag();

    const index = vertexAt(map, event.point);
    if (index === null) return;

    // Before anything else. The renderer decides at gesture start whether it owns the
    // pointer, so disabling panning inside this callback can already be too late.
    event.preventDefault();

    gesture = { index, moved: false };
    panningWasEnabled = map.dragPan.isEnabled();
    map.dragPan.disable();
    for (const type of MOVE_EVENTS) map.on(type, onMove);
    for (const type of CANCEL_EVENTS) map.on(type, onEnd);
    stopListeningForRelease = environment.onPointerRelease(onEnd);
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
   * The gesture is over — finished or taken away — so the drag is released, but the gesture
   * itself is **kept**.
   *
   * Whether a click follows cannot be decided here: the renderer sends one for a press that
   * stayed within its movement tolerance and none for a press that passed it, and that
   * threshold is the renderer's, not ours. So the gesture waits, and the two things that can
   * happen to it both do the right thing — a click consumes it, and the next press discards
   * it. Clearing here instead would let a press that drifted a couple of pixels off a vertex
   * fall through to the hit test and be taken as an instruction to add one.
   *
   * A taken-away touch needs nothing further: the platform stopped tracking the sequence, so
   * it dispatches no click and there is nothing for a kept gesture to swallow. Clearing it
   * anyway looked like prudence and was unobservable — the fake enforces the no-click rule,
   * and removing the clearing changed no test.
   */
  function onEnd(): void {
    releaseDrag();
  }

  function activateVertex(point: { x: number; y: number }): boolean {
    if (gesture !== null) {
      const { index, moved } = gesture;
      gesture = null;
      // A press that went down on a vertex and did not move is a click on that vertex,
      // wherever the pointer ended up. One that moved is a drag, and a drag is a drag and
      // nothing else — never also a click, and never an instruction to add another vertex.
      if (!moved) handlers.onVertexClick?.(index);
      return true;
    }
    const index = vertexAt(map, point);
    if (index !== null) {
      handlers.onVertexClick?.(index);
      return true;
    }
    return false;
  }

  function onClick(event: MapPointerEvent): void {
    if (activateVertex(event.point)) return;
    handlers.onVertexAdd({ lat: event.lngLat.lat, lng: event.lngLat.lng });
  }

  for (const type of START_EVENTS) map.on(type, onStart);
  map.on("click", onClick);
  reconcileDraft(initialDraft);

  return {
    renderDraft(points): void {
      reconcileDraft(points);
    },
    activateVertexAt(at): boolean {
      return activateVertex(map.project([at.lng, at.lat]));
    },
    /**
     * Idempotent by composition rather than by a flag: `releaseDrag` already returns early
     * with nothing attached and nothing borrowed, clearing an empty vertex list and a null
     * grab are no-ops, removing a detached node is a no-op, and `off` for a listener already
     * taken off is one too. A flag guarding all that was unobservable — every test still
     * passed with it removed — and an unobservable guard is a claim nobody can check.
     */
    exit(): void {
      releaseDrag();
      gesture = null;
      setGrabbed(null);
      for (const vertex of vertices) vertex.marker.remove();
      vertices = [];
      draft = [];
      group.remove();
      for (const type of START_EVENTS) map.off(type, onStart);
      map.off("click", onClick);
    },
  };
}
