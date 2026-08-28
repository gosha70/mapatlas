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
import { createMapController } from "@mapatlas/maplibre/controller";
import { isPmtilesProtocolRegistered } from "@mapatlas/maplibre/protocols";

declare global {
  interface Window {
    mapatlas: {
      createWebTrackRecorder: typeof createWebTrackRecorder;
      createMapController: typeof createMapController;
      /**
       * Whether the realm's PMTiles handler has been registered.
       *
       * Not a test-only export: it is an honest query the module already publishes. A
       * browser test needs it because registration is load-gated, so nothing observable in
       * the DOM distinguishes "the protocol was registered" from "the map drew a canvas".
       */
      isPmtilesProtocolRegistered: typeof isPmtilesProtocolRegistered;
      /** A sized, attached container, since a map with no dimensions never finishes load. */
      mapContainer(): HTMLElement;
      createIdbStorageAdapter: typeof createIdbStorageAdapter;
      recoverInterruptedTrack: typeof recoverInterruptedTrack;
      /**
       * Signals a test can wait on instead of sleeping.
       *
       * A fixed delay asserts nothing about what the browser has actually done: on a slow
       * runner the test proceeds before the first fix arrives, and the scenario then waits
       * for something that will never happen. These let a test wait for the event itself.
       */
      signals: Record<string, boolean>;
      /** The controller under test, so a later `page.evaluate` can drive it. */
      controller?: ReturnType<typeof createMapController>;
      /** Set by a running scenario, read by the test. */
      result?: unknown;
      lastTrack?: Track;
    };
  }
}

function mapContainer(): HTMLElement {
  const element = document.createElement("div");
  element.style.width = "800px";
  element.style.height = "600px";
  document.body.append(element);
  return element;
}

window.mapatlas = {
  createWebTrackRecorder,
  createMapController,
  isPmtilesProtocolRegistered,
  mapContainer,
  createIdbStorageAdapter,
  recoverInterruptedTrack,
  signals: {},
};
