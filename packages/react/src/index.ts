// SPDX-License-Identifier: Apache-2.0

/**
 * `@mapatlas/react` — React bindings: hooks and components.
 */

// Only the component. api.md §9 publishes MapCanvas with an inline props shape and no named
// props type; exporting MapCanvasProps here would quietly add public API outside the contract —
// invisibly, since a type-only export never appears in Object.keys. index.test.ts guards it.
export { MapCanvas } from "./map-canvas.js";
export type { EventLogBinding } from "./use-event-log.js";
export { useEventLog } from "./use-event-log.js";
export type { OfflineRegionsBinding } from "./use-offline-regions.js";
export { useOfflineRegions } from "./use-offline-regions.js";
export type { TrackDraftBinding, UseTrackDraftOptions } from "./use-track-draft.js";
export { useTrackDraft } from "./use-track-draft.js";
export type { TrackListBinding } from "./use-track-list.js";
export { useTrackList } from "./use-track-list.js";
export type { TrackRecorderBinding, UseTrackRecorderOptions } from "./use-track-recorder.js";
export { useTrackRecorder } from "./use-track-recorder.js";

export const PACKAGE_NAME = "@mapatlas/react";
