// SPDX-License-Identifier: Apache-2.0

/**
 * `@mapatlas/recorder-web` — the foreground `TrackRecorder` for a browser.
 *
 * Separate from `core` because it touches the DOM: geolocation and the Screen Wake Lock.
 * `core` stays unit-testable in Node with no browser at all. (ADR-0013)
 */

/**
 * `WebRecorderEnvironment` and its helpers are deliberately absent.
 *
 * T3.1 and `api.md` keep the injected browser off the public contract: a geolocation watch,
 * a wake lock and a timer are implementation machinery, and exporting them here would make
 * their shapes package API to maintain forever. Tests import `environment.js` directly,
 * which is what a source-local seam is for.
 */
export { createWebTrackRecorder } from "./recorder.js";

/**
 * The failures `createWebTrackRecorder` can raise, exported so a consumer can handle them
 * by type rather than by matching a message.
 *
 * `ChannelConflictError` means the sensors as configured disagree about a channel, and
 * carries the `channelKey`. `RecorderResumeError` means the track offered to `resumeFrom`
 * cannot be continued, and carries a `reason` — `not-interrupted`, `temporal-order`,
 * `channel-conflict` or `geometry` — with the underlying fault as `cause` where one exists.
 * A bad `autosaveMs` is an ordinary `RangeError`.
 */
export { ChannelConflictError, RecorderResumeError } from "./recorder.js";
export { DEFAULT_AUTOSAVE_MS } from "./recorder.js";

/** Package identity, so a consumer can report which engine build it embeds. */
export const PACKAGE_NAME = "@mapatlas/recorder-web";
