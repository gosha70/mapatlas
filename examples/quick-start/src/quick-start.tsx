// SPDX-License-Identifier: Apache-2.0

/**
 * Record a track, pin an event on it with a photo, review what was recorded.
 *
 * Everything here arrives from a published entry point — `@mapatlas/react` for the hooks and
 * components, `@mapatlas/storage-idb` for persistence, `@mapatlas/core` for the types. Nothing
 * reaches into a `dist` path or an internal module, because a consumer cannot.
 *
 * What it leaves out is deliberate: offline regions, hand-authored tracks, telemetry channels,
 * an AI analyzer and a trip list are all built and all proved elsewhere. This is the loop the
 * first afternoon needs and nothing beyond it.
 */

import { useCallback, useState } from "react";
import type { ReactElement } from "react";

import type { LatLng, MapEvent, MediaRef, Track } from "@mapatlas/core";
import {
  EventComposer,
  MapCanvas,
  TripReview,
  useEventLog,
  useTrackRecorder,
} from "@mapatlas/react";
import { createIdbStorageAdapter } from "@mapatlas/storage-idb";

import { BASEMAP, CAMERA } from "./map-source.js";

/**
 * One adapter per document, not one per render. It opens its IndexedDB connection lazily and
 * memoises it, so a second adapter would open a second connection to the same database.
 */
const store = createIdbStorageAdapter();

/** Stable across renders: `MapCanvas` treats a new array as a new source stack. */
const sources = [BASEMAP];

/**
 * Give back the blobs an event that was never written was carrying.
 *
 * **`EventComposer` seals itself before it calls `onSave`, and from that moment these bytes are
 * yours** — the composer will not delete them again, unmount included (ADR-0027). So a rejected
 * write leaves nothing referencing the blob and nothing that will ever collect it. This is the
 * obligation that comes with the handover, not error-handling ceremony.
 *
 * A delete that itself fails is reported as **unconfirmed** rather than swallowed or retried: the
 * bytes may or may not still be there, and claiming either would be a guess.
 */
async function releaseMedia(media: readonly MediaRef[]): Promise<string | undefined> {
  const stranded: string[] = [];
  for (const item of media) {
    if (item.blobKey === undefined) continue;
    try {
      await store.deleteBlob(item.blobKey);
    } catch {
      stranded.push(item.blobKey);
    }
  }
  return stranded.length === 0 ? undefined : `${String(stranded.length)} photo left unconfirmed`;
}

export function QuickStart(): ReactElement {
  const recorder = useTrackRecorder({ store });
  const log = useEventLog(store);

  /** The finalized trip under review; `undefined` means the live map is showing instead. */
  const [trip, setTrip] = useState<Track | undefined>(undefined);
  /** Where the composer is open, if it is. */
  const [pinAt, setPinAt] = useState<LatLng | undefined>(undefined);
  /** The events written during this recording, so the review can render them. */
  const [pinned, setPinned] = useState<MapEvent[]>([]);
  /** The last event write that failed, surfaced rather than discarded silently. */
  const [failure, setFailure] = useState<string | undefined>(undefined);

  const recording = recorder.status === "recording";

  const start = useCallback(async (): Promise<void> => {
    setTrip(undefined);
    setPinned([]);
    await recorder.start();
  }, [recorder]);

  /**
   * Stop, then bind the events to the trip they belong to.
   *
   * An event pinned mid-recording cannot carry a `trackId`: `useTrackRecorder` publishes the
   * track only when `stop()` resolves, so there is no id to write yet. The events are stored
   * unbound and updated here, before the review is shown.
   */
  const stop = useCallback(async (): Promise<void> => {
    const track = await recorder.stop();
    const bound = pinned.map((event) => ({ ...event, trackId: track.id }));
    for (const event of bound) await log.updateEvent(event);
    setPinned(bound);
    setTrip(track);
  }, [log, pinned, recorder]);

  /**
   * Write the composed event. The composer has already written the photo to `store` as a blob
   * and handed back a `MediaRef` carrying its `blobKey`; this stores the event that references
   * it, and `TripReview` resolves the key back to an image through the same store.
   *
   * **The rejection path is not optional, and it is not symmetric with the success path.** The
   * composer sealed itself before calling this, so it can neither retry nor cancel — a failed
   * write that left the composition open would leave a trip with no way to finish and a photo
   * nothing references. Both halves are handled below.
   */
  const save = useCallback(
    async (input: Omit<MapEvent, "id" | "position">, at: LatLng): Promise<void> => {
      try {
        const written = await log.addEvent({ ...input, position: at });
        setPinned((events) => [...events, written]);
        setFailure(undefined);
      } catch (reason) {
        const unconfirmed = await releaseMedia(input.media);
        const why = reason instanceof Error ? reason.message : String(reason);
        setFailure(unconfirmed === undefined ? why : `${why} (${unconfirmed})`);
      } finally {
        // **In `finally`, and that is the point rather than tidiness.** Closing the composition
        // is what makes the trip operable again: Stop is disabled while a composer is open, so
        // leaving `pinAt` set after a rejection would hold the trip open with no control able to
        // clear it. The notice above is what stops that from being a silent discard.
        //
        // Clearing it here also means Stop cannot run *during* a write — there is only ever one
        // composer, so `pinAt` is the whole in-flight window.
        setPinAt(undefined);
      }
    },
    [log],
  );

  return (
    <>
      <h1>Field log</h1>
      <p id="status" data-status={recorder.status}>
        {`Recorder ${recorder.status}. ${String(pinned.length)} event${pinned.length === 1 ? "" : "s"}.`}
      </p>

      {failure === undefined ? null : (
        <p id="failure" role="alert">
          {`The event was not saved: ${failure}`}
        </p>
      )}

      <p>
        <button id="start" type="button" onClick={() => void start()} disabled={recording}>
          Start recording
        </button>{" "}
        <button
          id="stop"
          type="button"
          onClick={() => void stop()}
          // Not while a composer is open: its event is not written yet, so finalizing now would
          // leave it unbound with nothing on screen able to reach it.
          disabled={!recording || pinAt !== undefined}
        >
          Stop and review
        </button>
      </p>

      {trip === undefined ? (
        <div id="map">
          <MapCanvas
            sources={sources}
            initialCamera={CAMERA}
            events={pinned}
            {...(recorder.livePoint === undefined ? {} : { livePoint: recorder.livePoint })}
            {...(recording ? { onMapTap: setPinAt } : {})}
          />
        </div>
      ) : (
        <div id="review">
          <TripReview track={trip} events={pinned} store={store} sources={sources} />
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
