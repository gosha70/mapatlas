// SPDX-License-Identifier: Apache-2.0

/**
 * Authoring a trip by hand — T7.1b increment 2: draw → set times → pin → save.
 *
 * **Assembled only from package entry points**, on the same terms as the recorded loop:
 * `useTrackDraft`, `useEventLog`, `MapCanvas` and `EventComposer` all arrive from
 * `@mapatlas/react` by bare name. Drawing itself is the renderer's published draw mode — this
 * file contributes no hit testing, no vertex geometry and no map interaction of its own.
 *
 * **Why timing is a step and not a default.** `append` deliberately writes an *untimed* vertex,
 * and `toTrack()` refuses while `untimedIndices` is non-empty. A component that invented a
 * timestamp per click would make that list permanently empty and save geometry nobody had timed,
 * so `Save` stays disabled until the times exist and the button that sets them is a control the
 * person operates.
 *
 * **Why the pinned event is bound after the save, not before.** This has the same shape as the
 * recorded loop's bind-at-finalize (see `loop.tsx`'s header) and a different cause: there, the
 * track id does not exist until `stop()` resolves; here, a **draft is not a track and has no id
 * until `save()` returns one**. So an event pinned while drawing is written unbound, remembered
 * for the length of the authoring session, and updated with the id the save produced. An event
 * left unbound survives in the store with no path back to it from any trip — which is why a
 * failed save keeps this session open and retryable rather than discarding what it holds.
 */

import { useCallback, useMemo, useState } from "react";
import type { ReactElement } from "react";

import { noopAnalyzer } from "@mapatlas/core";
import type {
  Id,
  JSONValue,
  LatLng,
  MapEvent,
  TerrainOptions,
  TileSource,
  Track,
} from "@mapatlas/core";
import { EventComposer, MapCanvas, useEventLog, useTrackDraft } from "@mapatlas/react";

import { releaseMedia } from "./media.js";
import { DEMO_CATEGORIES, demoPresentation } from "./presentation.js";
import type { DemoStorage } from "./storage.js";

/**
 * The pace `Set times` interpolates at.
 *
 * `interpolateTimes` derives each vertex's timestamp from the distance along the drawn line, so
 * it needs a speed. Walking pace is a defensible default for a field log and — unlike inventing a
 * per-click timestamp — it produces times that are consistent with the geometry the person drew.
 */
const WALKING_MPS = 1.4;

export interface AuthoringProps {
  readonly storage: DemoStorage;
  readonly sources: TileSource[];
  readonly style: JSONValue;
  readonly terrain: TerrainOptions | null;
  readonly initialCamera: { center?: LatLng; zoom?: number };
  /** Handed the saved track, which by then is in the store and has an id. */
  readonly onSaved: (track: Track) => void;
  readonly onCancel: () => void;
}

/** Drawing adds vertices; pinning drops events. One map cannot do both with one tap. */
type Mode = "draw" | "pin";

export function Authoring({
  storage,
  sources,
  style,
  terrain,
  initialCamera,
  onSaved,
  onCancel,
}: AuthoringProps): ReactElement {
  const draft = useTrackDraft({ store: storage.trips });
  /**
   * Bound to no track, because there is no track yet.
   *
   * `useEventLog(store, undefined)` lists *every* event ever stored, so its list is not what the
   * map draws — the ids written in this session are, exactly as the recorded loop does it. What
   * is used here is the pair of mutators.
   */
  const log = useEventLog(storage.trips, undefined);

  const [mode, setMode] = useState<Mode>("draw");
  const [pinAt, setPinAt] = useState<LatLng | undefined>(undefined);
  /** Events written during this session, in order, still unbound to any track. */
  const [pendingIds, setPendingIds] = useState<readonly Id[]>([]);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);

  const pending = useMemo(
    () => log.events.filter((event) => pendingIds.includes(event.id)),
    [log.events, pendingIds],
  );

  const untimed = draft.untimedIndices.length;
  /**
   * What `Save` requires.
   *
   * `untimed === 0` is **the engine's rule**, surfaced before the button rather than after:
   * `toTrack()` throws while any vertex is untimed, so a Save offered in that state would fail at
   * the store for a reason the person could have been told first.
   *
   * `points.length >= 2` is **this demo's rule and not the engine's** — `finalizeTrack` will
   * happily produce a one-point track — said here so nobody reads it as a published constraint.
   * A single vertex is a place, and the thing being authored is a trip; the recorded side draws
   * the same line, where a track that kept one fix is not a trip either.
   */
  const savable = draft.points.length >= 2 && untimed === 0 && !saving;

  const pin = useCallback(
    async (input: Omit<MapEvent, "id" | "position">, at: LatLng): Promise<void> => {
      try {
        const written = await log.addEvent({ ...input, position: at });
        setPendingIds((ids) => [...ids, written.id]);
        setFailure(undefined);
      } catch (reason) {
        // The composer sealed itself before calling this and cannot retry or cancel (ADR-0027),
        // so the blobs it handed over are ours to give back.
        const unconfirmed = await releaseMedia(storage.trips, input.media);
        const why = reason instanceof Error ? reason.message : String(reason);
        setFailure(unconfirmed === undefined ? why : `${why} (${unconfirmed})`);
      } finally {
        setPinAt(undefined);
      }
    },
    [log, storage],
  );

  const save = useCallback(async (): Promise<void> => {
    setSaving(true);
    try {
      // The track first: `save()` runs `toTrack()` before anything reaches storage, so an untimed
      // vertex rejects without having written a track for the events to be bound to.
      const track = await draft.save();
      for (const event of log.events.filter((held) => pendingIds.includes(held.id))) {
        await log.updateEvent({ ...event, trackId: track.id });
      }
      onSaved(track);
    } catch (reason) {
      // **The session stays open.** The events are written and unbound; discarding them here
      // would delete a person's photograph and comment because a save failed, and clearing the
      // draft would lose the geometry. Held, so pressing Save again binds the same events.
      setFailure(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  }, [draft, log, onSaved, pendingIds]);

  return (
    <>
      <p
        id="authoring-status"
        data-mode={mode}
        data-points={String(draft.points.length)}
        data-untimed={String(untimed)}
        data-events={String(pending.length)}
        data-savable={String(savable)}
      >
        {`Drawing a trip. ${String(draft.points.length)} point${draft.points.length === 1 ? "" : "s"}, ` +
          `${String(untimed)} untimed, ${String(pending.length)} event${pending.length === 1 ? "" : "s"}.`}
      </p>

      {failure === undefined ? null : (
        <p id="authoring-failure" role="alert" data-failure={failure}>
          {`That did not complete: ${failure}`}
        </p>
      )}

      <div className="app-controls">
        <button
          id="author-draw"
          type="button"
          onClick={() => {
            setMode("draw");
          }}
          disabled={mode === "draw"}
        >
          Draw
        </button>
        <button
          id="author-pin"
          type="button"
          onClick={() => {
            setMode("pin");
          }}
          disabled={mode === "pin"}
        >
          Pin an event
        </button>
        <button
          id="author-times"
          type="button"
          onClick={() => {
            draft.interpolateTimes({ startedAt: Date.now(), speedMps: WALKING_MPS });
          }}
          // Nothing to time is the only refusal here. Two vertices is `Save`'s rule, not this
          // one — a single timed vertex is a perfectly good draft to go on drawing from.
          disabled={draft.points.length === 0}
        >
          Set times
        </button>
        <button
          id="author-undo"
          type="button"
          onClick={() => {
            draft.undo();
          }}
          disabled={!draft.canUndo}
        >
          Undo
        </button>
        <button id="author-save" type="button" onClick={() => void save()} disabled={!savable}>
          Save trip
        </button>
        <button id="author-cancel" type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>

      <div className="app-map" id="authoring-map">
        <MapCanvas
          sources={sources}
          style={style}
          terrain={terrain}
          initialCamera={initialCamera}
          presentation={demoPresentation}
          events={pending}
          draft={draft.points}
          drawMode={mode === "draw"}
          {...(mode === "draw"
            ? { onDraw: { onVertexAdd: draft.append, onVertexMove: draft.moveAt } }
            : { onMapTap: setPinAt })}
        />
      </div>

      {pinAt === undefined ? null : (
        <div className="app-composer" id="authoring-composer">
          <EventComposer
            at={pinAt}
            store={storage.trips}
            analyzer={noopAnalyzer}
            mode="photo"
            categories={[...DEMO_CATEGORIES]}
            onSave={(input) => void pin(input, pinAt)}
            onCancel={() => {
              setPinAt(undefined);
            }}
          />
        </div>
      )}
    </>
  );
}
