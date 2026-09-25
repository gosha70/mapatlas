// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef } from "react";
import type {
  Id,
  LatLng,
  MapEvent,
  TileSource,
  Track,
  TrackPoint,
} from "@mapatlas/core";
// Type-only import: erased at build, so this module pulls in no MapLibre (and no
// `window`) at import time. The renderer is loaded dynamically on mount below,
// which keeps <MapCanvas> SSR-safe (MapLibre touches `window` when it loads).
import type { MapController } from "@mapatlas/maplibre";

export interface MapCanvasProps {
  sources: TileSource[];
  // `| undefined` on the optionals so callers may pass a possibly-undefined
  // value directly under `exactOptionalPropertyTypes` (e.g. `track={maybeTrack}`).
  track?: Track | undefined;
  events?: MapEvent[] | undefined;
  livePoint?: TrackPoint | undefined;
  onMapTap?(at: LatLng): void;
  onEventClick?(id: Id): void;
  className?: string | undefined;
  style?: React.CSSProperties | undefined;
}

export function MapCanvas(props: MapCanvasProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<MapController | null>(null);

  // Keep the latest interaction callbacks in refs so the (mount-only) map
  // wiring can call through to them without re-subscribing every render.
  const tapRef = useRef<MapCanvasProps["onMapTap"]>(undefined);
  const clickRef = useRef<MapCanvasProps["onEventClick"]>(undefined);
  tapRef.current = props.onMapTap;
  clickRef.current = props.onEventClick;

  // Mount once: dynamically import the renderer, then create the controller.
  useEffect(() => {
    let cancelled = false;
    const el = containerRef.current;
    if (!el) return;

    void import("@mapatlas/maplibre").then(({ createMapController }) => {
      if (cancelled || !containerRef.current) return;
      const controller = createMapController({
        container: el,
        sources: props.sources,
      });
      controller.onMapTap((at) => tapRef.current?.(at));
      controller.onEventClick((id) => clickRef.current?.(id));
      controllerRef.current = controller;

      // Apply the current props now that the controller exists.
      controller.setSources(props.sources);
      controller.renderTrack(props.track ?? null);
      controller.renderEvents(props.events ?? []);
      controller.showLivePosition(props.livePoint ?? null);
      if (props.track) controller.fitTrack(props.track);
    });

    return () => {
      cancelled = true;
      controllerRef.current?.destroy();
      controllerRef.current = null;
    };
    // Mount-only: the controller is created once; live prop changes are handled
    // by the reactive effects below.
  }, []);

  // Reactive updates once the controller is live.
  useEffect(() => {
    controllerRef.current?.setSources(props.sources);
  }, [props.sources]);
  useEffect(() => {
    controllerRef.current?.renderTrack(props.track ?? null);
    // Demo fix: keep the recorded track in view as it appears / grows.
    const n =
      props.track?.simplified?.length ?? props.track?.points.length ?? 0;
    if (props.track && n >= 2) controllerRef.current?.fitTrack(props.track);
  }, [props.track]);
  useEffect(() => {
    controllerRef.current?.renderEvents(props.events ?? []);
  }, [props.events]);
  useEffect(() => {
    controllerRef.current?.showLivePosition(props.livePoint ?? null);
  }, [props.livePoint]);

  return (
    <div
      ref={containerRef}
      className={props.className ?? "mapatlas-map-canvas"}
      role="application"
      aria-label="Interactive map"
      style={props.style ?? { width: "100%", height: "100%", minHeight: 240 }}
    />
  );
}
