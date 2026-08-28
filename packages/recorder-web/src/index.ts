// SPDX-License-Identifier: Apache-2.0

/**
 * `@mapatlas/recorder-web` — the foreground `TrackRecorder` for a browser.
 *
 * Separate from `core` because it touches the DOM: geolocation and the Screen Wake Lock.
 * `core` stays unit-testable in Node with no browser at all. (ADR-0013)
 */

export type {
  PositionFailure,
  PositionFix,
  WakeLockLease,
  WebRecorderEnvironment,
} from "./environment.js";
export { POSITION_ERROR, createBrowserEnvironment } from "./environment.js";

export { createWebTrackRecorder } from "./recorder.js";

/** Package identity, so a consumer can report which engine build it embeds. */
export const PACKAGE_NAME = "@mapatlas/recorder-web";
