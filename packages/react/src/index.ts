// SPDX-License-Identifier: Apache-2.0

/**
 * MAP-ATLAS React bindings — hooks and components (the integration face).
 * Components that mount MapLibre load it dynamically so this entry point is
 * SSR-safe (no `window` at import). Imports no domain concepts.
 */
export { useTrackRecorder } from "./use-track-recorder";
export type {
  UseTrackRecorderOptions,
  TrackRecorderControls,
} from "./use-track-recorder";

export { useEventLog } from "./use-event-log";
export type { EventLogControls } from "./use-event-log";

export { useOfflineRegions } from "./use-offline-regions";
export type { OfflineRegionControls } from "./use-offline-regions";

export { MapCanvas } from "./MapCanvas";
export type { MapCanvasProps } from "./MapCanvas";

export { EventComposer } from "./EventComposer";
export type { EventComposerProps } from "./EventComposer";

export { TripReview } from "./TripReview";
export type { TripReviewProps } from "./TripReview";
