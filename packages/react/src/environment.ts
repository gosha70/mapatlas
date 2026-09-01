// SPDX-License-Identifier: Apache-2.0

import type { StorageAdapter, Track, TrackRecorder, TrackRecorderOptions } from "@mapatlas/core";
import { recoverInterruptedTrack } from "@mapatlas/core";
import { createWebTrackRecorder } from "@mapatlas/recorder-web";

/**
 * The two things `useTrackRecorder` reaches for when it owns the recorder.
 *
 * **Internal — never exported from the barrel, never in `api.md`.** It exists so ADR-0026's
 * rules can be proven *structurally* rather than inferred: "an injected recorder means no
 * default one is constructed" is a claim about a call that must not happen, and the only honest
 * way to assert that is to count the calls. A test that instead checked `recovered === undefined`
 * would pass just as well against a hook that constructed a recorder, scanned the store, and
 * happened to find nothing.
 *
 * A seam rather than module mocking, for the reason the rest of this engine uses seams: mocking
 * `@mapatlas/recorder-web` would make the test depend on the module graph, and would keep
 * passing if the hook stopped importing it.
 */
export interface TrackRecorderHookEnvironment {
  createRecorder(options: TrackRecorderOptions): TrackRecorder;
  recover(store: StorageAdapter): Promise<Track | undefined>;
}

/** What production binds to: the real web recorder, and core's own recovery scan. */
export const browserRecorderEnvironment: TrackRecorderHookEnvironment = {
  createRecorder: (options) => createWebTrackRecorder(options),
  recover: (store) => recoverInterruptedTrack(store),
};
