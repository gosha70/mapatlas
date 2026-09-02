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

  /**
   * Which *context* a load would belong to — bumped when the store is replaced.
   *
   * Read **before** issuing a request, never when publishing one. Publishing is guarded by the
   * sequence alone, and comparing the context there as well is redundant: every context change
   * re-runs the effect, which issues a load, which bumps the sequence before awaiting — so a
   * stale context always implies a stale sequence. Mutation showed it: dropping the comparison
   * changed no test in any of the three hooks that had it.
   */
  const context = useRef(0);
  /**
   * Which load is the newest — bumped once per request issued, before awaiting.
   *
   * This is the guard that orders things. An initial list and a post-delete list share a
   * context, so nothing but a sequence can stop the slower one publishing over the newer.
   */
  const issued = useRef(0);

  const load = useCallback(async (current: StorageAdapter): Promise<void> => {
    const sequence = (issued.current += 1);
    setLoading(true);
    try {
      const listed = await current.listTrackSummaries();
      if (issued.current === sequence) setTracks(listed);
    } finally {
      // **Only the newest request may clear `loading`.** An older one settling first would
      // report the list as settled while the request whose answer will actually be shown is
      // still in flight — a spinner that stops before the thing it was waiting for arrives.
      if (issued.current === sequence) setLoading(false);
    }
  }, []);

  useEffect(() => {
    context.current += 1;
    void load(store).catch(() => {
      // An initial failure has no published error field to occupy, so it keeps whatever was
      // already shown rather than blanking the list. `loading` is ended by the `finally` above.
    });
  }, [store, load]);

  const refresh = useCallback(async (): Promise<void> => {
    // Explicit, so its failure reaches the caller — unlike the initial load, which nobody asked
    // for and which has nowhere to report.
    await load(store);
  }, [load, store]);

  const remove = useCallback(
    async (id: Id): Promise<void> => {
      const at = context.current;
      // No optimistic filter: a rejected delete would otherwise leave the row gone from a list
      // whose store still holds it, and the consumer's next act is usually to free space.
      await store.deleteTrack(id);
      // **Not a saved read — a correctness guard.** Issuing this list would bump the sequence,
      // and the *replacement* store's list, still in flight, would then find itself stale and
      // refuse to publish: it would never arrive and `loading` would never clear, because of a
      // mutation belonging to a store the consumer has already left.
      if (context.current !== at) return;
      await load(store);
    },
    [load, store],
  );

  return { tracks, loading, refresh, remove };
}
