// SPDX-License-Identifier: Apache-2.0

/**
 * The page a browser test drives.
 *
 * It exposes the engine on `window.mapatlas` so a test can exercise it through real
 * platform APIs — a real geolocation watch, a real IndexedDB, and later a real WebGL
 * canvas — rather than through anything the test supplied.
 */

import { recoverInterruptedTrack } from "@mapatlas/core";
import type { Track } from "@mapatlas/core";
import { createIdbStorageAdapter } from "@mapatlas/storage-idb";
import { createWebTrackRecorder } from "@mapatlas/recorder-web";

declare global {
  interface Window {
    mapatlas: {
      createWebTrackRecorder: typeof createWebTrackRecorder;
      createIdbStorageAdapter: typeof createIdbStorageAdapter;
      recoverInterruptedTrack: typeof recoverInterruptedTrack;
      /** Set by a running scenario, read by the test. */
      result?: unknown;
      lastTrack?: Track;
    };
  }
}

window.mapatlas = {
  createWebTrackRecorder,
  createIdbStorageAdapter,
  recoverInterruptedTrack,
};
