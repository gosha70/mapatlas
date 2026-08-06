// SPDX-License-Identifier: Apache-2.0

/**
 * @mapatlas/react — React bindings for MAP-ATLAS.
 *
 * Hooks and components over the engine seams and the Leaflet renderer. The
 * renderer (and Leaflet) is loaded lazily inside `<MapCanvas>` so importing
 * this package is SSR-safe.
 */
export const VERSION = "0.1.0";

export { useTrackRecorder, useEventLog, useOfflineRegions } from "./hooks.js";
export type {
  UseTrackRecorderOptions,
  UseTrackRecorderResult,
  UseEventLogResult,
  UseOfflineRegionsResult,
} from "./hooks.js";

export { MapCanvas } from "./MapCanvas.js";
export type { MapCanvasProps } from "./MapCanvas.js";

export { EventComposer } from "./EventComposer.js";
export type { EventComposerProps } from "./EventComposer.js";

export { TripReview } from "./TripReview.js";
export type { TripReviewProps } from "./TripReview.js";

// Storage-persistence + install guidance (T6.2)
export {
  requestPersistentStorage,
  estimateStorage,
  detectPlatform,
  installPromptGuidance,
} from "./persistence.js";
export type { PersistResult, Platform } from "./persistence.js";
