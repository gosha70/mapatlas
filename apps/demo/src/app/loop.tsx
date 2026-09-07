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
  useTrackRecorder,
} from "@mapatlas/react";
import type { JSONValue, TileSource } from "@mapatlas/core";

import { DEMO_CATEGORIES, demoPresentation } from "./presentation.js";
import type { DemoStorage } from "./storage.js";

export interface LoopProps {
  readonly storage: DemoStorage;
  readonly sources: TileSource[];
  readonly style: JSONValue;
  readonly terrain: TerrainOptions | null;
  readonly initialCamera: { center?: LatLng; zoom?: number };
}

export function Loop({ storage, sources, style, terrain, initialCamera }: LoopProps): ReactElement {
  const recorder = useTrackRecorder({ store: storage.trips });

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

  // Bound to the trip under review, and to nothing while recording: `useEventLog(store, undefined)`
  // lists *every* event ever stored, which on the live map would draw previous trips' pins over
  // the one being recorded.
  const log = useEventLog(storage.trips, reviewing?.id);

  const session = useMemo(
    () => log.events.filter((event) => sessionIds.includes(event.id)),
    [log.events, sessionIds],
  );

  const start = useCallback(async (): Promise<void> => {
    setReviewing(undefined);
    setSessionIds([]);
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
  }, [log, recorder, sessionIds]);

  const save = useCallback(
    async (input: Omit<MapEvent, "id" | "position">, at: LatLng): Promise<void> => {
      setInFlight((n) => n + 1);
      try {
        const written = await log.addEvent({ ...input, position: at });
        setSessionIds((ids) => [...ids, written.id]);
        setPinAt(undefined);
      } finally {
        // Released in `finally`, so a rejected write re-enables Stop instead of stranding the
        // trip in a state with no way out.
        setInFlight((n) => n - 1);
      }
    },
    [log],
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
  /** Finalizing has to wait for the composer to be resolved and for every write to settle. */
  const finalizable = recording && pinAt === undefined && inFlight === 0;

  return (
    <>
      <p id="recorder-status" data-status={recorder.status} data-events={String(session.length)}>
        {`Recorder ${recorder.status}. ${String(session.length)} event${session.length === 1 ? "" : "s"} this trip.`}
      </p>

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
      </div>

      {reviewing === undefined ? (
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
          <TripReview
            track={reviewing}
            events={log.events}
            store={storage.trips}
            sources={sources}
            style={style}
            terrain={terrain}
            presentation={demoPresentation}
          />
        </div>
      )}

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
