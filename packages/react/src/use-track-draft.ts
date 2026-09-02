// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  DraftTrackPoint,
  Id,
  InterpolateTimesOptions,
  LatLng,
  StorageAdapter,
  Track,
  TrackDraft,
} from "@mapatlas/core";
import { createTrackDraft } from "@mapatlas/core";

/**
 * Bind a {@link TrackDraft} to React state (`api.md` §9).
 *
 * **Core owns the editing; this owns the lifecycle.** Points, bounded undo/redo, timing,
 * validation, lap repair and authored finalization all live in `createTrackDraft`. React
 * subscribes, re-reads the draft's own `canUndo`, `canRedo` and `untimedIndices` after each
 * change, and performs no parallel array or history surgery — a second copy of that state would
 * drift from the first, and the drift would be invisible until a consumer trusted the wrong one.
 *
 * **A draft is identified by `from.id`, not by the object.** Rebuilding on object identity would
 * discard unsaved edits every time a parent re-rendered with an equivalent fresh `Track`, which
 * is the ordinary case in React. A consumer that really wants to reload the same id remounts.
 */
export interface TrackDraftBinding {
  points: DraftTrackPoint[];
  canUndo: boolean;
  canRedo: boolean;
  untimedIndices: number[];
  append(p: LatLng): void;
  insertAt(i: number, p: LatLng): void;
  moveAt(i: number, to: LatLng): void;
  removeAt(i: number): void;
  setTimeAt(i: number, t: number): void;
  interpolateTimes(o: InterpolateTimesOptions): void;
  breakAt(i: number): void;
  undo(): void;
  redo(): void;
  save(): Promise<Track>;
}

export interface UseTrackDraftOptions {
  from?: Track;
  store?: StorageAdapter;
}

/** @internal — lets a test order a draft's construction. Never exported from the barrel. */
export function useTrackDraftInternal(
  options: UseTrackDraftOptions,
  build: (from?: Track) => TrackDraft,
): TrackDraftBinding {
  const { from, store } = options;

  /**
   * Keyed on the **id**, not the object, so a fresh `Track` for the same track keeps the edits
   * and the history. `from` itself is deliberately absent from the dependencies: including it
   * would rebuild on every parent render that constructed an equivalent object, which is the
   * ordinary React case and would discard everything the user had drawn.
   */
  const fromId = from?.id;
  const draft = useMemo(() => build(from), [build, fromId]);

  const read = useCallback(
    (current: TrackDraft) => ({
      points: current.points,
      canUndo: current.canUndo,
      canRedo: current.canRedo,
      untimedIndices: current.untimedIndices,
    }),
    [],
  );
  const [snapshot, setSnapshot] = useState(() => read(draft));

  /**
   * The identity this session persists under.
   *
   * A seeded draft keeps `from.id` for the life of the session. A new draft adopts the id its
   * first `toTrack()` minted and reuses it — **adopted before `saveTrack` is awaited**, because
   * a write that rejects may still have landed, and retrying under a freshly minted id would
   * create a second trip instead of overwriting the uncertain first one. Reset when the draft is
   * replaced, since that is a different session.
   */
  const adoptedId = useRef<Id | undefined>(undefined);

  useEffect(() => {
    adoptedId.current = undefined;
    setSnapshot(read(draft));
    // A single subscription per draft, released when the draft is replaced: a callback held over
    // from the previous one would publish its points into the new session.
    return draft.onChange(() => {
      setSnapshot(read(draft));
    });
  }, [draft, read]);

  /** Every edit delegates and lets `onChange` publish; a rejected edit emits nothing. */
  const edit = useCallback(
    <A extends unknown[]>(run: (...args: A) => void) =>
      (...args: A): void => {
        run(...args);
      },
    [],
  );

  const save = useCallback(async (): Promise<Track> => {
    // `toTrack()` first, so an untimed point rejects before anything reaches storage.
    const track = draft.toTrack(adoptedId.current === undefined ? {} : { id: adoptedId.current });
    // `from.id` wins: a seeded draft already has an identity, and adopting a minted one would
    // fork the trip on its first save. `toTrack` carries the seeded id through, so this only
    // ever records what the draft itself decided.
    adoptedId.current = track.id;
    if (store !== undefined) await store.saveTrack(track);
    return track;
  }, [draft, store]);

  return {
    points: snapshot.points,
    canUndo: snapshot.canUndo,
    canRedo: snapshot.canRedo,
    untimedIndices: snapshot.untimedIndices,
    append: edit((p: LatLng) => {
      // A `LatLng` becomes an **untimed** vertex: timing is the explicit `setTimeAt` or
      // `interpolateTimes` step, and inventing a timestamp here would make `untimedIndices`
      // permanently empty and `save()` succeed on geometry nobody had timed.
      draft.append({ lat: p.lat, lng: p.lng });
    }),
    insertAt: edit((i: number, p: LatLng) => {
      draft.insertAt(i, { lat: p.lat, lng: p.lng });
    }),
    moveAt: edit((i: number, to: LatLng) => {
      draft.moveAt(i, to);
    }),
    removeAt: edit((i: number) => {
      draft.removeAt(i);
    }),
    setTimeAt: edit((i: number, t: number) => {
      draft.setTimeAt(i, t);
    }),
    interpolateTimes: edit((o: InterpolateTimesOptions) => {
      draft.interpolateTimes(o);
    }),
    breakAt: edit((i: number) => {
      draft.breakAt(i);
    }),
    undo: edit(() => {
      draft.undo();
    }),
    redo: edit(() => {
      draft.redo();
    }),
    save,
  };
}

/** The public entry point, with exactly the options `api.md` §9 publishes. */
export function useTrackDraft(options: UseTrackDraftOptions = {}): TrackDraftBinding {
  return useTrackDraftInternal(options, createTrackDraft);
}
