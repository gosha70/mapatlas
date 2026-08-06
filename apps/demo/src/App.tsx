// SPDX-License-Identifier: Apache-2.0
import { useEffect, useMemo, useState } from "react";
import {
  noopAnalyzer,
  trackToGeoJSON,
  type LatLng,
  type MapEvent,
  type MediaAnalyzer,
  type OfflineRegionStore,
  type StorageAdapter,
  type TileSource,
  type Track,
} from "@mapatlas/core";
import { createIdbStorageAdapter } from "@mapatlas/storage-idb";
import {
  createPMTilesOfflineRegionStore,
  createMemoryTileCache,
  installGuidance,
  requestPersistentStorage,
  type TileByteSource,
} from "@mapatlas/offline-pmtiles";
import {
  EventComposer,
  MapCanvas,
  TripReview,
  useEventLog,
  useOfflineRegions,
  useTrackRecorder,
} from "@mapatlas/react";

/**
 * A generic field-logger. It carries no domain: an event is a comment + photos
 * + free-form tags, nothing more. Everything variable — storage, the offline
 * tile source, and the photo analyzer — is injected, defaulting to the engine's
 * shipped implementations (IndexedDB, an empty offline source, `noopAnalyzer`).
 */
export interface AppProps {
  store?: StorageAdapter;
  offlineStore?: OfflineRegionStore;
  /** The analyzer slot — defaults to the no-op analyzer. */
  analyzer?: MediaAnalyzer;
  sources?: TileSource[];
}

// A production consumer must self-host tiles or ship a PMTiles archive; this
// placeholder keeps the demo domain- and vendor-neutral (see architecture §8).
export const DEMO_SOURCES: TileSource[] = [
  {
    id: "demo-base",
    kind: "xyz",
    url: "https://tile.example/{z}/{x}/{y}.png",
    attribution:
      "© OpenStreetMap contributors (ODbL) — replace with a self-hosted source",
  },
];

const DEFAULT_BBOX: [number, number, number, number] = [
  -122.36, 47.59, -122.31, 47.63,
];

function trackBbox(track: Track | undefined): [number, number, number, number] {
  const pts = track?.simplified ?? track?.points ?? [];
  if (pts.length === 0) return DEFAULT_BBOX;
  let w = pts[0]!.lng,
    e = pts[0]!.lng,
    s = pts[0]!.lat,
    n = pts[0]!.lat;
  for (const p of pts) {
    w = Math.min(w, p.lng);
    e = Math.max(e, p.lng);
    s = Math.min(s, p.lat);
    n = Math.max(n, p.lat);
  }
  return [w, s, e, n];
}

function downloadText(name: string, mime: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

const emptySource: TileByteSource = {
  getTile: () => Promise.resolve(undefined),
};

export function App(props: AppProps): React.JSX.Element {
  const store = useMemo(
    () => props.store ?? createIdbStorageAdapter("mapatlas-demo"),
    [props.store],
  );
  const offlineStore = useMemo(
    () =>
      props.offlineStore ??
      createPMTilesOfflineRegionStore({
        source: emptySource,
        cache: createMemoryTileCache(),
      }),
    [props.offlineStore],
  );
  const analyzer = props.analyzer ?? noopAnalyzer;
  const sources = props.sources ?? DEMO_SOURCES;

  const recorder = useTrackRecorder({ store });
  const events = useEventLog(store, recorder.track?.id);
  const offline = useOfflineRegions(offlineStore);

  const [composerAt, setComposerAt] = useState<LatLng | null>(null);
  const [persisted, setPersisted] = useState(false);
  const guidance = useMemo(() => installGuidance(), []);

  // Persist the finalized track so it survives a reload.
  useEffect(() => {
    if (recorder.track) void store.saveTrack(recorder.track);
  }, [recorder.track, store]);

  const saveEvent = (
    input: Omit<MapEvent, "id" | "position">,
    at: LatLng,
  ): void => {
    const full: Omit<MapEvent, "id"> = { ...input, position: at };
    if (recorder.track) full.trackId = recorder.track.id;
    void events.addEvent(full);
    setComposerAt(null);
  };

  const exportGeoJSON = (): void => {
    if (!recorder.track) return;
    const fc = trackToGeoJSON(recorder.track, events.events);
    downloadText(
      "trip.geojson",
      "application/geo+json",
      JSON.stringify(fc, null, 2),
    );
  };

  const enablePersistence = async (): Promise<void> => {
    setPersisted(await requestPersistentStorage());
  };

  const finalized = recorder.status === "finalized" && recorder.track;

  return (
    <main className="mapatlas-demo">
      <header>
        <h1>MAP-ATLAS field logger</h1>
        <p>Record a track, drop events where they happened, review the trip.</p>
      </header>

      <section
        aria-label="Recording controls"
        className="mapatlas-demo__controls"
      >
        <span>Status: {recorder.status}</span>
        <button type="button" onClick={() => void recorder.start()}>
          Start
        </button>
        <button type="button" onClick={() => recorder.pause()}>
          Pause
        </button>
        <button type="button" onClick={() => recorder.resume()}>
          Resume
        </button>
        <button type="button" onClick={() => void recorder.stop()}>
          Stop
        </button>
        <button
          type="button"
          onClick={exportGeoJSON}
          disabled={!recorder.track}
        >
          Export GeoJSON
        </button>
        {recorder.error ? (
          <span role="alert">Recorder error: {recorder.error.kind}</span>
        ) : null}
      </section>

      <div className="mapatlas-demo__map" style={{ height: 360 }}>
        <MapCanvas
          sources={sources}
          track={recorder.track}
          events={events.events}
          livePoint={recorder.livePoint}
          onMapTap={(at) => setComposerAt(at)}
        />
      </div>

      {composerAt ? (
        <EventComposer
          at={composerAt}
          analyzer={analyzer}
          store={store}
          onSave={(input) => saveEvent(input, composerAt)}
          onCancel={() => setComposerAt(null)}
        />
      ) : null}

      <section aria-label="Offline maps" className="mapatlas-demo__offline">
        <h2>Offline maps</h2>
        <button
          type="button"
          onClick={() =>
            void offline.download({
              name: "Current area",
              bbox: trackBbox(recorder.track),
              minZoom: 12,
              maxZoom: 14,
            })
          }
        >
          Download current area
        </button>
        <ul>
          {offline.regions.map((r) => (
            <li key={r.id}>
              {r.name} — {Math.round((r.sizeBytes ?? 0) / 1024)} KB{" "}
              <button type="button" onClick={() => void offline.remove(r.id)}>
                Delete
              </button>
            </li>
          ))}
        </ul>
        <div className="mapatlas-demo__persistence">
          <button type="button" onClick={() => void enablePersistence()}>
            Enable persistent storage
          </button>
          {persisted ? <span>Storage is persistent ✓</span> : null}
          <details>
            <summary>
              Install for reliable offline use ({guidance.platform})
            </summary>
            <p>{guidance.reason}</p>
            <ol>
              {guidance.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </details>
        </div>
      </section>

      {finalized ? (
        <section aria-label="Trip review">
          <h2>Trip review</h2>
          <TripReview
            track={recorder.track!}
            events={events.events}
            store={store}
          />
        </section>
      ) : null}
    </main>
  );
}
