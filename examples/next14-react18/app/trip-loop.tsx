// SPDX-License-Identifier: Apache-2.0
"use client";

/**
 * The complete foreground trip loop, in a Next 14 App Router project on React 18 (ADR-0043).
 *
 * record → pause → resume → pin with a photo → reload → resume the recovered trip → stop → review.
 *
 * The quick start proves the shorter loop on the React and bundler this repository develops on.
 * This proves the longer one where a consumer like HookAtlas actually lives: webpack under Next,
 * server rendering then hydration, and React 18. Recovery is in the loop because it is the step
 * that crosses a page load, and so the one most likely to depend on what the framework does to
 * a module between loads.
 */

import { useCallback, useEffect, useState } from "react";

import type { LatLng, MapEvent, TileSource, Track } from "@mapatlas/core";
import {
  EventComposer,
  MapCanvas,
  TripReview,
  useEventLog,
  useTrackRecorder,
} from "@mapatlas/react";
import { createIdbStorageAdapter } from "@mapatlas/storage-idb";

/**
 * One adapter per document. Module scope, as the quick start does it, so this also covers the
 * case a consumer writes without thinking: the module is evaluated on the server during
 * prerendering, where the adapter must not touch IndexedDB until it is used.
 */
const store = createIdbStorageAdapter();

/**
 * The basemap the lane serves at `/basemap.pmtiles`. Built after mount, because an absolute URL
 * needs `window.location` and this module is also evaluated on the server.
 */
function basemap(origin: string): TileSource {
  return {
    id: "basemap",
    kind: "vector",
    transport: "pmtiles",
    url: new URL("/basemap.pmtiles", origin).toString(),
    attribution: "© synthetic test basemap",
    styleLayers: [
      {
        id: "basemap-earth",
        type: "fill",
        source: "basemap",
        "source-layer": "earth",
        paint: { "fill-color": "#e8e4dc" },
      },
      {
        id: "basemap-water",
        type: "fill",
        source: "basemap",
        "source-layer": "water",
        paint: { "fill-color": "#0f8a7a" },
      },
    ],
  };
}

const CAMERA = { center: { lat: 45.84, lng: 6.865 }, zoom: 12 };

export function TripLoop() {
  const recorder = useTrackRecorder({ store });
  const log = useEventLog(store);

  const [sources, setSources] = useState<TileSource[] | undefined>(undefined);
  const [trip, setTrip] = useState<Track | undefined>(undefined);
  const [pinAt, setPinAt] = useState<LatLng | undefined>(undefined);

  /**
   * The worker URL before the first map exists, then the sources that let the map mount. The
   * worker files are served from this origin (`public/maplibre/`): under webpack MapLibre cannot
   * find its worker by itself, and the map would construct and never build a tile. `maplibre-gl`
   * is imported here, inside an effect, because this module is also evaluated on the server.
   */
  useEffect(() => {
    let live = true;
    void import("maplibre-gl").then(({ setWorkerUrl }) => {
      setWorkerUrl(new URL("/maplibre/maplibre-gl-worker.mjs", window.location.href).toString());
      if (live) setSources([basemap(window.location.href)]);
    });
    return () => {
      live = false;
    };
  }, []);

  /**
   * Events not yet bound to a finalized track. An event pinned while recording cannot carry a
   * `trackId` — the hook publishes the track only when `stop()` resolves — so it is stored
   * unbound, survives the reload in IndexedDB, and is bound at stop.
   */
  const unbound = log.events.filter((event) => event.trackId === undefined);
  const recording = recorder.status === "recording";
  const live = recording || recorder.status === "paused";

  const stop = useCallback(async () => {
    const track = await recorder.stop();
    for (const event of unbound) await log.updateEvent({ ...event, trackId: track.id });
    setTrip(track);
  }, [log, recorder, unbound]);

  const save = useCallback(
    async (input: Omit<MapEvent, "id" | "position">, at: LatLng) => {
      try {
        await log.addEvent({ ...input, position: at });
      } finally {
        setPinAt(undefined);
      }
    },
    [log],
  );

  const reviewed = trip === undefined ? [] : log.events.filter((e) => e.trackId === trip.id);

  return (
    <>
      <p id="status" data-status={recorder.status} data-unbound={unbound.length}>
        {`Recorder ${recorder.status}. ${String(unbound.length)} unbound event(s).`}
      </p>

      {recorder.recovered === undefined ? null : (
        <p
          id="recovered"
          data-track-id={recorder.recovered.id}
          data-points={recorder.recovered.points.length}
        >
          {`An unfinished trip with ${String(recorder.recovered.points.length)} points was found.`}{" "}
          <button
            id="resume-recovered"
            type="button"
            onClick={() => void recorder.resumeRecovered()}
          >
            Resume it
          </button>{" "}
          <button
            id="discard-recovered"
            type="button"
            onClick={() => void recorder.discardRecovered()}
          >
            Discard it
          </button>
        </p>
      )}

      <p>
        <button id="start" type="button" onClick={() => void recorder.start()} disabled={live}>
          Start
        </button>{" "}
        <button id="pause" type="button" onClick={recorder.pause} disabled={!recording}>
          Pause
        </button>{" "}
        <button
          id="resume"
          type="button"
          onClick={recorder.resume}
          disabled={recorder.status !== "paused"}
        >
          Resume
        </button>{" "}
        <button
          id="stop"
          type="button"
          onClick={() => void stop()}
          disabled={!live || pinAt !== undefined}
        >
          Stop and review
        </button>
      </p>

      {sources === undefined ? null : trip === undefined ? (
        <div id="map" style={{ width: 640, height: 360 }}>
          <MapCanvas
            sources={sources}
            initialCamera={CAMERA}
            events={unbound}
            {...(recorder.livePoint === undefined ? {} : { livePoint: recorder.livePoint })}
            {...(recording ? { onMapTap: setPinAt } : {})}
          />
        </div>
      ) : (
        <div
          id="review"
          data-track-id={trip.id}
          data-segments={trip.segments.length}
          data-points={trip.points.length}
          data-events={reviewed.length}
        >
          <TripReview track={trip} events={reviewed} store={store} sources={sources} />
        </div>
      )}

      {pinAt === undefined ? null : (
        <EventComposer
          at={pinAt}
          store={store}
          mode="photo"
          onSave={(input) => void save(input, pinAt)}
          onCancel={() => {
            setPinAt(undefined);
          }}
        />
      )}
    </>
  );
}
