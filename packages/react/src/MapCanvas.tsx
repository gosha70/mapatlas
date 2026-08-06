// SPDX-License-Identifier: Apache-2.0

/**
 * `<MapCanvas>` (tasks T5.2): a React wrapper around the Leaflet
 * {@link MapController}.
 *
 * SSR-safe: `@mapatlas/leaflet` (and therefore Leaflet, which touches `window`
 * at import) is loaded via a dynamic `import()` inside an effect, so importing
 * this module on the server never evaluates Leaflet. Only `import type` appears
 * at module scope, which the compiler erases.
 */
import { useEffect, useRef } from "react";
import type { CSSProperties } from "react";
import type { MapController } from "@mapatlas/leaflet";
import type {
  Id,
  LatLng,
  MapEvent,
  TileSource,
  Track,
  TrackPoint,
} from "@mapatlas/core";

export interface MapCanvasProps {
  sources: TileSource[];
  track?: Track;
  events?: MapEvent[];
  livePoint?: TrackPoint;
  center?: LatLng;
  zoom?: number;
  onMapTap?(at: LatLng): void;
  onEventClick?(id: Id): void;
  className?: string;
  style?: CSSProperties;
}

export function MapCanvas(props: MapCanvasProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const controllerRef = useRef<MapController | null>(null);

  // Keep the latest interaction callbacks addressable from stable subscriptions.
  const tapRef = useRef<MapCanvasProps["onMapTap"]>(props.onMapTap);
  const eventClickRef = useRef<MapCanvasProps["onEventClick"]>(
    props.onEventClick,
  );
  tapRef.current = props.onMapTap;
  eventClickRef.current = props.onEventClick;

  // Mount the controller once, client-side only.
  useEffect(() => {
    let cancelled = false;
    const el = containerRef.current;
    if (!el) return;

    void (async () => {
      const { createMapController } = await import("@mapatlas/leaflet");
      if (cancelled) return;
      const controller = createMapController({
        container: el,
        sources: props.sources,
        ...(props.center ? { center: props.center } : {}),
        ...(props.zoom !== undefined ? { zoom: props.zoom } : {}),
      });
      controller.onMapTap((at) => tapRef.current?.(at));
      controller.onEventClick((id) => eventClickRef.current?.(id));
      controller.renderTrack(props.track ?? null);
      controller.renderEvents(props.events ?? []);
      controller.showLivePosition(props.livePoint ?? null);
      controllerRef.current = controller;
    })();

    return () => {
      cancelled = true;
      controllerRef.current?.destroy();
      controllerRef.current = null;
    };
    // Mount once; subsequent prop changes are handled by the effects below.
  }, []);

  useEffect(() => {
    controllerRef.current?.setSources(props.sources);
  }, [props.sources]);

  useEffect(() => {
    controllerRef.current?.renderTrack(props.track ?? null);
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
      className={props.className}
      style={props.style ?? { width: "100%", height: "100%" }}
      role="application"
      aria-label="Interactive map"
    />
  );
}
