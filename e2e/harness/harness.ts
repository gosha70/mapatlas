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
// The renderer's stylesheet is the **consumer's** to load, and this harness is a consumer.
// Without it markers lay out in normal flow rather than absolutely against the map, so a
// mark sits wherever the document happens to put it — generally outside the map entirely.
import "maplibre-gl/dist/maplibre-gl.css";

// MapLibre 6 loads its worker as a separate module, resolved relative to the *importing*
// chunk. Under a bundler that rewrites imports — Vite's optimised dependency chunks here —
// that resolution lands beside the rewritten chunk instead of beside the package, and the
// request 404s. Nothing errors: the map is constructed, the style parses, sources emit
// `sourcedata`, and then nothing is ever painted because no tile is ever built.
//
// `?worker&url` asks the bundler for a URL it will actually serve, and `setWorkerUrl` tells
// MapLibre to use it. This is a **consumer** responsibility — the engine cannot do it,
// because the correct URL depends on the consumer's bundler — and it is documented as one.
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { setWorkerUrl } from "maplibre-gl";

import { createBrowserMapEnvironment, createMapController } from "@mapatlas/maplibre/controller";
import { createMapControllerInternal } from "@mapatlas/maplibre/controller-internal";
import type {
  MapControllerCore,
  MapControllerOptions,
} from "@mapatlas/maplibre/controller-internal";
import { isPmtilesProtocolRegistered } from "@mapatlas/maplibre/protocols";

declare global {
  interface Window {
    mapatlas: {
      createWebTrackRecorder: typeof createWebTrackRecorder;
      createMapController: typeof createMapController;
      /**
       * A controller plus a window onto what the real map actually holds.
       *
       * `MapController` deliberately exposes no getters — a consumer sets state, it does not
       * interrogate it — but a browser test has to check what MapLibre did rather than what
       * the controller believes. `getTerrain()` and `getLayer()` are the library's own
       * answers, and `getLayer` matters because MapLibre can report a layer-validation error
       * and return *without adding the layer*, rather than throwing.
       */
      mountWithProbe(options: MapControllerOptions): MountedProbe;
      /**
       * A bare MapLibre map with no controller, so a test can establish what the library
       * does on its own before asserting what the controller does about it.
       */
      mountRawMap(style: unknown): { getTerrain(): unknown };
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
      /** Set by a map scenario, so later `page.evaluate` calls can drive and read it. */
      probe?: MountedProbe;
      /** Set by the bare-MapLibre scenario. */
      rawMap?: { getTerrain(): unknown };
      /** What a draw-mode scenario's handlers recorded. */
      drawLog?: {
        moved: [number, { lat: number; lng: number }][];
        added: { lat: number; lng: number }[];
        clicked: number[];
      };
      /** The draw-mode exit function, so a test can release interaction. */
      exitDraw?: () => void;
      /** The controller under test, so a later `page.evaluate` can drive it. */
      controller?: ReturnType<typeof createMapController>;
      /** Set by a running scenario, read by the test. */
      result?: unknown;
      lastTrack?: Track;
    };
  }
}

setWorkerUrl(maplibreWorkerUrl);

function mapContainer(): HTMLElement {
  const element = document.createElement("div");
  element.style.width = "800px";
  element.style.height = "600px";
  document.body.append(element);
  return element;
}

/** What the probe needs from MapLibre's `Map` beyond the controller seam. */
interface MapProbe {
  getTerrain(): unknown;
  getLayer(id: string): unknown;
  dragPan: { isEnabled(): boolean };
  queryRenderedFeatures(
    point: { x: number; y: number },
    layerIds: readonly string[],
  ): readonly unknown[];
}

interface MountedProbe {
  controller: MapControllerCore;
  getTerrain(): unknown;
  hasLayer(id: string): boolean;
  /** Whether the map will pan again, which draw mode borrows and must give back. */
  dragPanEnabled(): boolean;
  /** Whether a draft vertex is actually painted, and so hit-testable. */
  vertexIsRendered(): boolean;
}

function mountWithProbe(options: MapControllerOptions): MountedProbe {
  const environment = createBrowserMapEnvironment();
  let map: MapProbe | undefined;
  const controller = createMapControllerInternal(options, {
    ...environment,
    createMap: (mapOptions: Parameters<typeof environment.createMap>[0]) => {
      const created = environment.createMap(mapOptions);
      map = created as unknown as MapProbe;
      return created;
    },
  });
  return {
    controller,
    getTerrain: () => map?.getTerrain() ?? null,
    hasLayer: (id: string) => map?.getLayer(id) !== undefined,
    // `dragPan` is on the controller's own seam, so this needs nothing the engine does not
    // already publish. The camera deliberately is *not*: reading it would mean widening
    // `MapLike` for a test, and a mark anchored to a coordinate is a better observable
    // anyway — it is what a user would see move.
    dragPanEnabled: () => map?.dragPan.isEnabled() ?? false,
    vertexIsRendered: () =>
      (map?.queryRenderedFeatures({ x: 400, y: 300 }, ["mapatlas:draft-vertex"]).length ?? 0) > 0,
  };
}

function mountRawMap(style: unknown): { getTerrain(): unknown } {
  const environment = createBrowserMapEnvironment();
  const map = environment.createMap({
    container: mapContainer(),
    style: style as MapControllerOptions["style"] & {},
    attributionControl: { customAttribution: [] },
  });
  return { getTerrain: () => map.getTerrain() };
}

window.mapatlas = {
  createWebTrackRecorder,
  createMapController,
  mountWithProbe,
  mountRawMap,
  isPmtilesProtocolRegistered,
  mapContainer,
  createIdbStorageAdapter,
  recoverInterruptedTrack,
  signals: {},
};
