// SPDX-License-Identifier: Apache-2.0

/**
 * The field-logging loop — T7.1 increment 2: record → pin → photo → review.
 *
 * **Assembled only from package entry points**, on the same terms as the shell: `useTrackRecorder`,
 * `useEventLog`, `EventComposer` and `TripReview` all arrive from `@mapatlas/react` by bare name,
 * and `noopAnalyzer` from `@mapatlas/core`. This file is the evidence that a consumer can build
 * the loop out of what `api.md` §9 publishes and nothing else.
 *
 * **Why events are bound to the trip at finalize, not when they are dropped.** `useTrackRecorder`
 * publishes `track` only once `stop()` resolves — during a recording it is `undefined` (the hook
 * clears it on `start()`), and no in-progress track id is exposed anywhere on the seam. So an
 * event pinned mid-trip cannot carry a `trackId` at the moment it is written. It is stored
 * unbound, remembered here for the length of the recording, and updated with the finalized id
 * when the trip ends. That is a consequence of the published surface rather than a preference,
 * and it is the single most surprising thing in this file.
 */

import { useCallback, useMemo, useState } from "react";
import type { ReactElement } from "react";

import { noopAnalyzer } from "@mapatlas/core";
import type { Id, LatLng, MapEvent, TerrainOptions, Track } from "@mapatlas/core";
import {
  EventComposer,
  MapCanvas,
  TripReview,
  useEventLog,
  useTrackList,
  useTrackRecorder,
} from "@mapatlas/react";
import type { JSONValue, TileSource } from "@mapatlas/core";

import { Authoring } from "./authoring.js";
import { createDemoChannel } from "./channel.js";
import { buildTripExport, downloadDocument } from "./export.js";
import { releaseMedia } from "./media.js";
import { DEMO_CATEGORIES, demoPresentation } from "./presentation.js";
import type { DemoStorage } from "./storage.js";
import { TripList } from "./trips.js";

export interface LoopProps {
  readonly storage: DemoStorage;
  readonly sources: TileSource[];
  readonly style: JSONValue;
  readonly terrain: TerrainOptions | null;
  readonly initialCamera: { center?: LatLng; zoom?: number };
}

export function Loop({ storage, sources, style, terrain, initialCamera }: LoopProps): ReactElement {
  /**
   * The fake telemetry channel (T7.1c increment 1).
   *
   * **Built once and held**, not per render: `useTrackRecorder` treats a new `sensors` array as a
   * new set of sources, and a source rebuilt mid-recording would be started again with its
   * sequence reset. `useMemo` with no dependencies is the smallest thing that is right here,
   * because nothing about this source depends on props.
   *
   * **Wired at the published seam and nowhere else.** Swapping this for a real instrument is one
   * constructor call in `channel.ts`; nothing under `packages/` changes, which is the claim
   * `PRD.md` §6 makes about `SensorSource`.
   */
  const sensors = useMemo(() => [createDemoChannel()], []);
  const recorder = useTrackRecorder({ store: storage.trips, sensors });

  /** The finalized trip under review. Set by `stop()`, cleared when a new recording starts. */
  const [reviewing, setReviewing] = useState<Track | undefined>(undefined);
  /** Where the composer is open, if it is. `undefined` is closed — never a sentinel LatLng. */
  const [pinAt, setPinAt] = useState<LatLng | undefined>(undefined);
  /**
   * Ids written during this recording, in order.
   *
   * Held rather than derived: once bound, these events are indistinguishable from any other
   * event on the same trip, so "which ones did this session write" is not a question the store
   * can answer afterwards.
   */
  const [sessionIds, setSessionIds] = useState<readonly Id[]>([]);
  /**
   * Writes issued and not yet settled.
   *
   * **Finalizing is not allowed to overtake one.** `stop()` reads the ids written so far and binds
   * those events to the finalized track; a write still in flight is not in that list yet, so a
   * stop that ran first would finalize the trip, publish the review without the event, and leave
   * the event unbound with nothing in this UI able to reach it. Counted rather than a boolean: two
   * composers cannot be open at once today, but a count cannot be wrong if that changes.
   */
  const [inFlight, setInFlight] = useState(0);
  /** The last event write that failed, surfaced rather than discarded silently. */
  const [failure, setFailure] = useState<string | undefined>(undefined);

  /**
   * The stored trips (T7.1b increment 1).
   *
   * **The store is what is listed, not this document.** Holding the trips this session happened
   * to finalize would render identically for as long as the page stays open and then lose every
   * one of them on reload — which is the whole thing the list exists to prevent, and is why the
   * browser scenario reloads before it looks. `useTrackList` re-lists from the adapter and keeps
   * its published order — `api.md` declares `listTrackSummaries()` *"ordered by `startedAt`
   * ascending, ties broken by id. Required, not optional"*, and the storage conformance suite
   * holds every adapter to it — so nothing is re-sorted here either.
   */
  const trips = useTrackList(storage.trips);
  /** The trip opened from the list, so the row for it can say so. */
  const [openedId, setOpenedId] = useState<Id | undefined>(undefined);
  /** A trip that could not be opened — the list can name one that is no longer there. */
  const [openFailure, setOpenFailure] = useState<string | undefined>(undefined);
  /** Whether the hand-authoring flow has the map (T7.1b increment 2). */
  const [authoring, setAuthoring] = useState(false);

  // Bound to the trip under review, and to nothing while recording: `useEventLog(store, undefined)`
  // lists *every* event ever stored, which on the live map would draw previous trips' pins over
  // the one being recorded.
  const log = useEventLog(storage.trips, reviewing?.id);

  const session = useMemo(
    () => log.events.filter((event) => sessionIds.includes(event.id)),
    [log.events, sessionIds],
  );

  const start = useCallback(async (): Promise<void> => {
    setAuthoring(false);
    setReviewing(undefined);
    setSessionIds([]);
    setExported(undefined);
    setOpenedId(undefined);
    setOpenFailure(undefined);
    await recorder.start();
  }, [recorder]);

  const stop = useCallback(async (): Promise<void> => {
    const finalized = await recorder.stop();
    // Bind before publishing the track: a review that rendered first would list the trip's
    // events by `trackId` and find none, which is a blank review panel rather than an error.
    for (const event of log.events.filter((candidate) => sessionIds.includes(candidate.id))) {
      await log.updateEvent({ ...event, trackId: finalized.id });
    }
    setReviewing(finalized);
    setOpenedId(undefined);
    // **Listed as soon as it exists, not on the next load.** `useTrackList` lists on mount and
    // when the store is replaced; a trip finalized afterwards is in the store and absent from the
    // rendered list until something asks again. Awaited rather than fired and forgotten, so a
    // failure to re-list is not silently the same as an empty list.
    await trips.refresh();
  }, [log, recorder, sessionIds, trips]);

  const save = useCallback(
    async (input: Omit<MapEvent, "id" | "position">, at: LatLng): Promise<void> => {
      setInFlight((n) => n + 1);
      try {
        const written = await log.addEvent({ ...input, position: at });
        setSessionIds((ids) => [...ids, written.id]);
        setFailure(undefined);
      } catch (reason) {
        // **The composer cannot recover this.** It seals itself *before* invoking `onSave`
        // (ADR-0027), so the composer still on screen can neither retry nor cancel. Leaving
        // `pinAt` set would hold `finalizable` false with no control able to clear it — the trip
        // would have no exit at all, which is worse than the failed write. Closing the
        // composition is what makes the trip operable again; the notice is what stops that from
        // being a silent discard.
        const unconfirmed = await releaseMedia(storage.trips, input.media);
        const why = reason instanceof Error ? reason.message : String(reason);
        setFailure(unconfirmed === undefined ? why : `${why} (${unconfirmed})`);
      } finally {
        // **Both, and in `finally`.** The success path clears `pinAt` too, and a rejection that
        // cleared only `inFlight` is exactly the strand this replaced.
        setPinAt(undefined);
        setInFlight((n) => n - 1);
      }
    },
    [log, storage],
  );

  /**
   * A trip that was authored rather than recorded, once it is in the store.
   *
   * Reviewed immediately and listed by the same refresh a finalized recording gets: the criterion
   * is that an authored trip is not a second class of thing, so it takes the same path.
   */
  const authored = useCallback(
    async (track: Track): Promise<void> => {
      setAuthoring(false);
      setSessionIds([]);
      setExported(undefined);
      setOpenedId(track.id);
      setReviewing(track);
      await trips.refresh();
    },
    [trips],
  );

  const recording = recorder.status === "recording" || recorder.status === "paused";
  /**
   * Composition belongs to a trip, and there is no trip yet.
   *
   * An event dropped while the recorder is `finalized` is written with no `trackId` and is
   * remembered only in `sessionIds` — which the next `start()` clears. The event survives in the
   * store, orphaned, with no path back to it from this UI. The demo is a consumer's reference:
   * shipping that shape would teach the pattern.
   */
  const composable = recording && reviewing === undefined;
  /** What the last export wrote, so the media obligation is visible rather than discovered later. */
  const [exported, setExported] = useState<string | undefined>(undefined);

  /**
   * The reviewed trip's events, filtered here rather than trusted from the log.
   *
   * **`useEventLog`'s list lags its `trackId` on purpose.** Switching from `undefined` to the
   * finalized id issues a fresh load, and until that load lands the binding still answers with
   * the *previous* list — which, while recording, was every event ever stored. It also keeps
   * that list deliberately when the filtered read rejects, so the lag has no upper bound.
   * `trackToGeoJSON` serializes exactly the events it is handed, so an export taken in that
   * window would carry other trips' events and their media references into this trip's file.
   *
   * Filtering synchronously closes the window instead of racing it. It feeds the review as well
   * as the export: the same stale list would otherwise draw a previous trip's pins over this
   * one, which is the same defect wearing different clothes.
   */
  const reviewEvents = useMemo(
    () =>
      reviewing === undefined ? [] : log.events.filter((event) => event.trackId === reviewing.id),
    [log.events, reviewing],
  );

  const exportTrip = useCallback((): void => {
    if (reviewing === undefined) return;
    const doc = buildTripExport(reviewing, reviewEvents);
    downloadDocument(doc);
    setExported(
      doc.media.length === 0
        ? doc.filename
        : `${doc.filename} — ${String(doc.media.length)} photo${doc.media.length === 1 ? "" : "s"} referenced, not included`,
    );
  }, [reviewEvents, reviewing]);

  /**
   * Open a listed trip for review.
   *
   * **Hydrated here, once.** The list holds summaries with no points in them (ADR-0014), and
   * `TripReview` needs the track — so this is the one place `getTrack` is called, rather than per
   * row while rendering.
   *
   * A summary whose track has gone is a reachable state, not an impossible one: the list is a
   * snapshot, and anything that deletes a trip between the render and the click produces exactly
   * this. Reported rather than returned from silently, which would look to the reader like a
   * button that does nothing.
   */
  const openTrip = useCallback(
    async (id: Id): Promise<void> => {
      setOpenFailure(undefined);
      const track = await storage.trips.getTrack(id);
      if (track === undefined) {
        setOpenFailure(`That trip is no longer stored (${id}).`);
        await trips.refresh();
        return;
      }
      // Not this session's events: `sessionIds` describes a recording, and an opened trip is not
      // one. Left standing, the recorder line would report a count belonging to another trip.
      setSessionIds([]);
      setExported(undefined);
      setOpenedId(id);
      setReviewing(track);
    },
    [storage, trips],
  );

  /** Finalizing has to wait for the composer to be resolved and for every write to settle. */
  const finalizable = recording && pinAt === undefined && inFlight === 0;

  return (
    <>
      <p id="recorder-status" data-status={recorder.status} data-events={String(session.length)}>
        {`Recorder ${recorder.status}. ${String(session.length)} event${session.length === 1 ? "" : "s"} this trip.`}
      </p>

      {failure === undefined ? null : (
        <p id="event-failure" role="alert" data-failure={failure}>
          {`The event was not saved: ${failure}`}
        </p>
      )}

      <div className="app-controls">
        <button id="record-start" type="button" onClick={() => void start()} disabled={recording}>
          Start recording
        </button>
        <button
          id="record-pause"
          type="button"
          onClick={() => {
            recorder.pause();
          }}
          disabled={recorder.status !== "recording"}
        >
          Pause
        </button>
        <button
          id="record-resume"
          type="button"
          onClick={() => {
            recorder.resume();
          }}
          disabled={recorder.status !== "paused"}
        >
          Resume
        </button>
        <button id="record-stop" type="button" onClick={() => void stop()} disabled={!finalizable}>
          Stop and review
        </button>
        <button
          id="author-start"
          type="button"
          onClick={() => {
            setReviewing(undefined);
            setOpenedId(undefined);
            setAuthoring(true);
          }}
          // A recording owns the map: drawing over a trip in progress would take the taps the
          // recorder's own pins need, and there is no second map to put it on.
          disabled={recording || authoring}
        >
          Draw a trip
        </button>
      </div>

      {authoring ? (
        <Authoring
          storage={storage}
          sources={sources}
          style={style}
          terrain={terrain}
          initialCamera={initialCamera}
          onSaved={(track) => void authored(track)}
          onCancel={() => {
            setAuthoring(false);
          }}
        />
      ) : reviewing === undefined ? (
        <div className="app-map" id="app-map">
          {/* **The camera is load-bearing, not a nicety.** The archives cover 0.08 degrees;
              the default view is the whole world, and from there every tile MapLibre asks for is
              outside them — a flat grey box with a correct attribution line and a correct source
              count. Read once at construction and never tracked (ADR-0037). */}
          <MapCanvas
            sources={sources}
            style={style}
            terrain={terrain}
            initialCamera={initialCamera}
            presentation={demoPresentation}
            events={session}
            {...(recorder.livePoint === undefined ? {} : { livePoint: recorder.livePoint })}
            {...(composable ? { onMapTap: setPinAt } : {})}
          />
        </div>
      ) : (
        <div className="app-review" id="app-review">
          <div className="app-export">
            <button id="export-geojson" type="button" onClick={exportTrip}>
              Export GeoJSON
            </button>
            {exported === undefined ? null : (
              <p id="export-result" data-file={exported}>{`Exported ${exported}`}</p>
            )}
          </div>
          <TripReview
            track={reviewing}
            events={reviewEvents}
            store={storage.trips}
            sources={sources}
            style={style}
            terrain={terrain}
            presentation={demoPresentation}
          />
        </div>
      )}

      {openFailure === undefined ? null : (
        <p id="trip-failure" role="alert">
          {openFailure}
        </p>
      )}

      <TripList
        tracks={trips.tracks}
        loading={trips.loading}
        openId={openedId}
        onOpen={(id) => void openTrip(id)}
      />

      {pinAt === undefined || !composable ? null : (
        <div className="app-composer" id="app-composer">
          <EventComposer
            at={pinAt}
            store={storage.trips}
            // **The analyzer seam, wired at the seam.** `noopAnalyzer` is the shipped default
            // behaviour made explicit: a consumer swaps this one prop for their own
            // `MediaAnalyzer` and nothing under `packages/core` changes. That "zero core changes"
            // claim is a `git diff`, not a test, which is why the prop is passed here rather
            // than left to the component's own default.
            analyzer={noopAnalyzer}
            mode="photo"
            categories={[...DEMO_CATEGORIES]}
            onSave={(input) => void save(input, pinAt)}
            onCancel={() => {
              setPinAt(undefined);
            }}
          />
        </div>
      )}
    </>
  );
}
