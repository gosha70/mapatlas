// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef, useState } from "react";

import type { Id, StorageAdapter, TrackSummary } from "@mapatlas/core";

/**
 * Bind a store's trip list to React state (`api.md` §9).
 *
 * **Summaries only, never tracks.** `listTrackSummaries` exists precisely so a device holding a
 * hundred trips does not deserialize a hundred point arrays to render a list (ADR-0014), and
 * calling `getTrack` per row here would undo that at the one layer a consumer cannot see. The
 * test makes `getTrack` throw so the claim crosses a seam rather than being inferred from the
 * returned type.
 *
 * **The adapter's order is kept verbatim.** Unlike `OfflineRegionStore.list`, this one is
 * *contractually* ordered — by `startedAt`, ties broken by id — and the storage conformance suite
 * enforces it for every adapter. Re-sorting here would duplicate that rule above the seam, where
 * it would drift, and would silently override an adapter that got it right.
 */
export interface TrackListBinding {
  tracks: TrackSummary[];
  loading: boolean;
  refresh(): Promise<void>;
  remove(id: Id): Promise<void>;
}

export function useTrackList(store: StorageAdapter): TrackListBinding {
  const [tracks, setTracks] = useState<TrackSummary[]>([]);
  const [loading, setLoading] = useState(true);

  /** Which *context* a load belongs to — bumped when the store is replaced. */
  const context = useRef(0);
  /**
   * Which load is the newest — bumped once per request issued.
   *
   * Both guards, as in the other hooks and for the two distinct reasons: the context says which
   * store, and the sequence orders two loads *within* one store. An initial list and a
   * post-delete list share a context, so nothing but a sequence can stop the slower one
   * publishing over the newer.
   */
  const issued = useRef(0);

  const load = useCallback(async (current: StorageAdapter, at: number): Promise<void> => {
    const sequence = (issued.current += 1);
    setLoading(true);
    try {
      const listed = await current.listTrackSummaries();
      if (context.current === at && issued.current === sequence) setTracks(listed);
    } finally {
      // **Only the newest request may clear `loading`.** An older one settling first would
      // report the list as settled while the request whose answer will actually be shown is
      // still in flight — a spinner that stops before the thing it was waiting for arrives.
      if (context.current === at && issued.current === sequence) setLoading(false);
    }
  }, []);

  useEffect(() => {
    context.current += 1;
    const at = context.current;
    void load(store, at).catch(() => {
      // An initial failure has no published error field to occupy, so it keeps whatever was
      // already shown rather than blanking the list. `loading` is ended by the `finally` above.
    });
  }, [store, load]);

  const refresh = useCallback(async (): Promise<void> => {
    // Explicit, so its failure reaches the caller — unlike the initial load, which nobody asked
    // for and which has nowhere to report.
    await load(store, context.current);
  }, [load, store]);

  const remove = useCallback(
    async (id: Id): Promise<void> => {
      const at = context.current;
      // No optimistic filter: a rejected delete would otherwise leave the row gone from a list
      // whose store still holds it, and the consumer's next act is usually to free space.
      await store.deleteTrack(id);
      // Not merely "do not publish" — do not *list*. The store this deletion belonged to is no
      // longer the one on screen, and its answer could only be discarded.
      if (context.current !== at) return;
      await load(store, at);
    },
    [load, store],
  );

  return { tracks, loading, refresh, remove };
}
