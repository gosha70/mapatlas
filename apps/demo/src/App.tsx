// SPDX-License-Identifier: Apache-2.0

/**
 * MAP-ATLAS demo — a generic field logger (no real domain) (tasks T7.1).
 *
 * Wires the recorder, map, event composer, storage, and offline persistence
 * into the record → pin → photo → review loop. The analyzer slot defaults to
 * `noopAnalyzer`; swap in any {@link MediaAnalyzer} to enable photo suggestions.
 */
import { useEffect, useMemo, useState } from "react";
import type { LatLng, MapEvent, Track } from "@mapatlas/core";
import { noopAnalyzer, trackToGeoJSON } from "@mapatlas/core";
import {
  EventComposer,
  MapCanvas,
  TripReview,
  installPromptGuidance,
  requestPersistentStorage,
  useEventLog,
  useTrackRecorder,
} from "@mapatlas/react";
import { IdbStorageAdapter } from "@mapatlas/storage-idb";
import { DEMO_SOURCES } from "./tile-sources.js";

function downloadJSON(name: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/geo+json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function App(): JSX.Element {
  const storage = useMemo(() => new IdbStorageAdapter(), []);
  const analyzer = noopAnalyzer; // swap for a real MediaAnalyzer to enable

  const recorder = useTrackRecorder({ store: storage });
  const { events, addEvent } = useEventLog(storage, recorder.track?.id);

  const [composeAt, setComposeAt] = useState<LatLng | null>(null);
  const [review, setReview] = useState<Track | null>(null);
  const [persistNote, setPersistNote] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const result = await requestPersistentStorage();
      if (result !== "persisted") setPersistNote(installPromptGuidance());
    })();
  }, []);

  const onSaveEvent = async (
    input: Omit<MapEvent, "id" | "position">,
  ): Promise<void> => {
    if (!composeAt) return;
    await addEvent({ ...input, position: composeAt });
    setComposeAt(null);
  };

  return (
    <main className="mapatlas-demo">
      <header>
        <h1>MAP-ATLAS field logger</h1>
        <p>Record a track, drop events, attach photos, review your trip.</p>
      </header>

      {persistNote && (
        <div role="status" className="mapatlas-persist-note">
          {persistNote}
        </div>
      )}

      <section className="mapatlas-controls" aria-label="Recording controls">
        {recorder.status !== "recording" ? (
          <button type="button" onClick={() => void recorder.start()}>
            Start recording
          </button>
        ) : (
          <>
            <button type="button" onClick={() => recorder.pause()}>
              Pause
            </button>
            <button
              type="button"
              onClick={() => void recorder.stop().then(setReview)}
            >
              Stop
            </button>
          </>
        )}
        {recorder.status === "paused" && recorder.track === undefined && (
          <button type="button" onClick={() => recorder.resume()}>
            Resume
          </button>
        )}
        {recorder.track && (
          <button
            type="button"
            onClick={() =>
              downloadJSON(
                `trip-${recorder.track!.id}.geojson`,
                trackToGeoJSON(recorder.track!, events),
              )
            }
          >
            Export GeoJSON
          </button>
        )}
        {recorder.error && (
          <span role="alert">Recorder error: {recorder.error.kind}</span>
        )}
      </section>

      <div className="mapatlas-map" style={{ height: 420 }}>
        <MapCanvas
          sources={DEMO_SOURCES}
          track={recorder.track}
          events={events}
          livePoint={recorder.livePoint}
          onMapTap={(at) => setComposeAt(at)}
        />
      </div>

      {composeAt && (
        <EventComposer
          at={composeAt}
          analyzer={analyzer}
          store={storage}
          onSave={(input) => void onSaveEvent(input)}
          onCancel={() => setComposeAt(null)}
        />
      )}

      {review && <TripReview track={review} events={events} />}
    </main>
  );
}
