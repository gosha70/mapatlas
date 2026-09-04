// SPDX-License-Identifier: Apache-2.0

/**
 * `@mapatlas/react` — React bindings: hooks and components.
 */

// Only the component. api.md §9 publishes MapCanvas with an inline props shape and no named
// props type; exporting MapCanvasProps here would quietly add public API outside the contract —
// invisibly, since a type-only export never appears in Object.keys. index.test.ts guards it.
export { MapCanvas } from "./map-canvas.js";
// `FieldSpec` *is* exported, unlike `MapCanvasProps`: api.md §9 publishes it as a named
// interface, so withholding it would be as much a contract breach as adding one.
export type { FieldSpec } from "./event-composer.js";
export { EventComposer } from "./event-composer.js";
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
// `TripReview`'s props are inline in §9, like `MapCanvas`'s — no named props type is published,
// and `TripReviewInternal` is a test seam that `index.test.ts` asserts never escapes.
export { TripReview } from "./trip-review.js";

export const PACKAGE_NAME = "@mapatlas/react";
