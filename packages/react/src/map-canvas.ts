// SPDX-License-Identifier: Apache-2.0

import { createElement, useEffect, useRef } from "react";
import type { ReactElement } from "react";

import type {
  DraftTrackPoint,
  Id,
  JSONValue,
  LatLng,
  MapEvent,
  TerrainOptions,
  TileSource,
  Track,
  TrackPoint,
} from "@mapatlas/core";
import type {
  DrawModeHandlers,
  EventPresentation,
  MapController,
  MapControllerOptions,
} from "@mapatlas/maplibre";
import { createMapController } from "@mapatlas/maplibre";

/**
 * A React face over {@link MapController} (`api.md` §9, T5.2).
 *
 * **A reconciliation component over an already-complete controller.** Every prop except `style`
 * maps to a controller mutator, so every prop except `style` reconciles through the existing
 * controller — recreating for anything else would churn a live WebGL context to do what a method
 * call does. `style` is construction-only by the controller's design, so it is the one
 * recreation boundary, and after recreating, the whole current state is re-applied.
 *
 * **Presence is lifecycle; identity is data.** A listener or `onDraw` changing *identity* — the
 * ordinary React case of an inline callback — changes which function is called, never the
 * subscription or the draw session; a prop appearing or disappearing is what subscribes,
 * unsubscribes, enters or exits. Re-entering draw mode on a handler identity change would drop
 * the keyboard grab and roving focus mid-edit.
 *
 * **SSR-safe by construction order.** Rendering returns the container `<div>` and nothing else;
 * the controller is built in an effect, which never runs on a server.
 */
export interface MapCanvasProps {
  sources: TileSource[];
  style?: string | JSONValue;
  terrain?: TerrainOptions | null;
  presentation?: EventPresentation;
  track?: Track;
  events?: MapEvent[];
  livePoint?: TrackPoint;
  draft?: DraftTrackPoint[];
  drawMode?: boolean;
  onDraw?: DrawModeHandlers;
  onMapTap?(at: LatLng): void;
  onEventClick?(id: Id): void;
}

/** What the live controller currently shows, so reconciliation is a comparison, not a replay. */
interface Applied {
  sources: TileSource[];
  terrain: TerrainOptions | null | undefined;
  presentation: EventPresentation | undefined;
  track: Track | undefined;
  events: MapEvent[] | undefined;
  livePoint: TrackPoint | undefined;
  draft: DraftTrackPoint[] | undefined;
}

/** One live controller and everything owned on its behalf, torn down as a unit. */
interface Session {
  controller: MapController;
  applied: Applied;
  offMapTap?: (() => void) | undefined;
  offEventClick?: (() => void) | undefined;
  exitDraw?: (() => void) | undefined;
}

/** @internal — the seam the tests count constructions on. Never exported from the barrel. */
export function MapCanvasInternal(
  props: MapCanvasProps & { create: (options: MapControllerOptions) => MapController },
): ReactElement {
  const { create, style } = props;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sessionRef = useRef<Session | undefined>(undefined);

  /**
   * The live props, read by every stable callback.
   *
   * This is what makes identity data rather than lifecycle: the subscription and the draw
   * session hold wrappers that read this ref at call time, so a consumer's inline arrow
   * functions update behaviour without touching the controller.
   */
  const latest = useRef(props);
  latest.current = props;

  const hasMapTap = props.onMapTap !== undefined;
  const hasEventClick = props.onEventClick !== undefined;
  const drawActive = props.drawMode === true && props.onDraw !== undefined;

  /** Subscribe the stable tap listener; presence decided by the caller. */
  const wireMapTap = (session: Session): void => {
    session.offMapTap = session.controller.onMapTap((at) => latest.current.onMapTap?.(at));
  };
  const wireEventClick = (session: Session): void => {
    session.offEventClick = session.controller.onEventClick((id) =>
      latest.current.onEventClick?.(id),
    );
  };
  const enterDraw = (session: Session): void => {
    // All three keys defined on the wrapper, forwarding through the ref with optional chaining.
    // Draw mode only presence-checks `onVertexClick` at its call sites, so a defined wrapper
    // that forwards to an absent consumer handler is behaviourally identical to absence.
    session.exitDraw = session.controller.enterDrawMode({
      onVertexAdd: (at) => latest.current.onDraw?.onVertexAdd(at),
      onVertexMove: (index, to) => latest.current.onDraw?.onVertexMove(index, to),
      onVertexClick: (index) => latest.current.onDraw?.onVertexClick?.(index),
    });
  };

  // Construction and teardown — the one effect keyed on the recreation boundary. Defined first
  // so it runs first on mount; its cleanup tears the whole session down itself rather than
  // relying on the other effects' cleanup order, which React does not promise in the shape this
  // needs (their cleanups guard on the session still being current instead).
  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return undefined;

    const current = latest.current;
    const controller = create({
      container,
      sources: current.sources,
      ...(current.style === undefined ? {} : { style: current.style }),
      ...(current.terrain === undefined ? {} : { terrain: current.terrain }),
      ...(current.presentation === undefined ? {} : { presentation: current.presentation }),
    });
    const session: Session = {
      controller,
      applied: {
        sources: current.sources,
        terrain: current.terrain,
        presentation: current.presentation,
        track: undefined,
        events: undefined,
        livePoint: undefined,
        draft: undefined,
      },
    };
    sessionRef.current = session;

    // **The whole current state, immediately — this is what a style recreation must restore.**
    // A controller built from the constructor options alone would silently drop the track, the
    // events, the live point, the draft, the listeners and the draw session. The per-prop
    // effects below do not rerun on recreation when their own dependencies did not change, so
    // relying on them here is the implementation the plan names as the common defect.
    applyState(session, current);
    if (current.onMapTap !== undefined) wireMapTap(session);
    if (current.onEventClick !== undefined) wireEventClick(session);
    if (current.drawMode === true && current.onDraw !== undefined) enterDraw(session);

    return () => {
      // Exit interaction before destroy, in the reverse of the order it was set up.
      session.exitDraw?.();
      session.offMapTap?.();
      session.offEventClick?.();
      controller.destroy();
      if (sessionRef.current === session) sessionRef.current = undefined;
    };
    // Deliberately only [create, style]: `style` is the recreation boundary, and everything
    // else reconciles through the session without rebuilding the controller.
  }, [create, style]);

  // Reconciliation — data props, compared against what the live controller shows.
  useEffect(() => {
    const session = sessionRef.current;
    if (session !== undefined) applyState(session, props);
  });

  // Listener presence. Identity is handled by the ref; these effects run only when a listener
  // appears or disappears — and their cleanups guard on the session, because on a style change
  // the construction effect has already torn the whole session down.
  useEffect(() => {
    const session = sessionRef.current;
    if (session === undefined) return undefined;
    if (hasMapTap && session.offMapTap === undefined) wireMapTap(session);
    return () => {
      if (!hasMapTap) return;
      const live = sessionRef.current;
      if (live === session && session.offMapTap !== undefined) {
        session.offMapTap();
        session.offMapTap = undefined;
      }
    };
  }, [hasMapTap]);

  useEffect(() => {
    const session = sessionRef.current;
    if (session === undefined) return undefined;
    if (hasEventClick && session.offEventClick === undefined) wireEventClick(session);
    return () => {
      if (!hasEventClick) return;
      const live = sessionRef.current;
      if (live === session && session.offEventClick !== undefined) {
        session.offEventClick();
        session.offEventClick = undefined;
      }
    };
  }, [hasEventClick]);

  // Draw-session presence: active means `drawMode` and handlers are both present. Exiting when
  // either goes is the half a suite that only checks identity cannot see — a session left alive
  // after its handlers disappeared would keep editing into callbacks that no longer exist.
  useEffect(() => {
    const session = sessionRef.current;
    if (session === undefined) return undefined;
    if (drawActive && session.exitDraw === undefined) enterDraw(session);
    return () => {
      if (!drawActive) return;
      const live = sessionRef.current;
      if (live === session && session.exitDraw !== undefined) {
        session.exitDraw();
        session.exitDraw = undefined;
      }
    };
  }, [drawActive]);

  return createElement("div", { ref: containerRef, style: { width: "100%", height: "100%" } });
}

/** Bring a session's controller to the given props; absent data props clear their layer. */
function applyState(session: Session, props: MapCanvasProps): void {
  const { controller, applied } = session;
  if (applied.sources !== props.sources) {
    controller.setSources(props.sources);
    applied.sources = props.sources;
  }
  if (applied.terrain !== props.terrain) {
    controller.setTerrain(props.terrain ?? null);
    applied.terrain = props.terrain;
  }
  if (applied.presentation !== props.presentation) {
    controller.setPresentation(props.presentation ?? null);
    applied.presentation = props.presentation;
  }
  if (applied.track !== props.track) {
    controller.renderTrack(props.track ?? null);
    applied.track = props.track;
  }
  if (applied.events !== props.events) {
    controller.renderEvents(props.events ?? []);
    applied.events = props.events;
  }
  if (applied.livePoint !== props.livePoint) {
    controller.showLivePosition(props.livePoint ?? null);
    applied.livePoint = props.livePoint;
  }
  if (applied.draft !== props.draft) {
    controller.renderDraft(props.draft ?? null);
    applied.draft = props.draft;
  }
}

/** The public component, with exactly the props `api.md` §9 publishes. */
export function MapCanvas(props: MapCanvasProps): ReactElement {
  return MapCanvasInternal({ ...props, create: createMapController });
}
