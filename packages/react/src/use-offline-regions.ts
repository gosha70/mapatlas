// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef, useState } from "react";

import type { Id, OfflineRegion, OfflineRegionStore } from "@mapatlas/core";

/**
 * Bind an {@link OfflineRegionStore} to React state (`api.md` §9).
 *
 * **The store is the authority on what exists.** `download` resolves with the region it created,
 * and that region is *not* appended to local state: the hook re-lists instead. Appending would
 * be a guess about the store's ordering and about whether the store recorded anything else at
 * the same time — and it would be a guess that looks right until the first refresh disagreed
 * with it.
 *
 * **No ordering is imposed here.** `OfflineRegionStore.list` states none, unlike
 * `StorageAdapter.listTrackSummaries`, which is contractually ordered. Sorting regions in the
 * binding would invent a contract the seam does not make, and would then have to be reimplemented
 * identically by every other consumer of the store.
 *
 * This binds the seam, not `@mapatlas/offline-pmtiles` — which is a deliberate stub until T6.1.
 * A binding around an interface does not wait for one implementation of it.
 */
export interface OfflineRegionsBinding {
  regions: OfflineRegion[];
  download(region: Parameters<OfflineRegionStore["download"]>[0]): Promise<void>;
  remove(id: Id): Promise<void>;
}

export function useOfflineRegions(store: OfflineRegionStore): OfflineRegionsBinding {
  const [regions, setRegions] = useState<OfflineRegion[]>([]);

  /**
   * Which *context* a load would belong to — bumped when the store is replaced changes.
   *
   * Read **before** issuing a request, never when publishing one. Publishing is guarded by the
   * sequence alone, and comparing the context there as well is redundant: every context change
   * re-runs the effect, which issues a load, which bumps the sequence before awaiting — so a
   * stale context always implies a stale sequence. Mutation showed it: dropping the comparison
   * changed no test.
   */
  const context = useRef(0);
  /**
   * Which load is the newest — bumped once per request issued, before awaiting.
   *
   * This is the guard that orders things: two loads in one context are separated by nothing
   * else.
   */
  const issued = useRef(0);

  const load = useCallback(async (current: OfflineRegionStore): Promise<void> => {
    const sequence = (issued.current += 1);
    const listed = await current.list();
    if (issued.current === sequence) setRegions(listed);
  }, []);

  useEffect(() => {
    context.current += 1;
    void load(store).catch(() => {
      // A failed initial list leaves what was already shown rather than blanking it. The
      // consumer's error surface is theirs to build; inventing one here would be a policy.
    });
  }, [store, load]);

  /**
   * Run a mutation, then re-list — under the context token current **when it started**.
   *
   * Sampling the context token after the mutation resolved was a race, and a slow one is exactly
   * where it bites: a download against store A, a swap to store B while it runs, and then A's
   * refresh reading `context.current` — a ref, so it holds *B's* token — and publishing A's
   * list over B's. Capturing first makes the stale refresh fail the guard it is supposed to
   * fail. A download is the slowest thing this hook does, so the window is wide.
   */
  const mutate = useCallback(
    async (current: OfflineRegionStore, run: () => Promise<unknown>): Promise<void> => {
      const at = context.current;
      await run();
      // **The two guards divide the work:** context decides whether a post-mutation request is
      // *issued*, the sequence decides which answer is *published*. Issuing this one would make
      // it the newest request, so it would publish the **old** store's regions and the
      // replacement's answer would be the one discarded — not a wasted read, a wrong screen.
      if (context.current !== at) return;
      await load(current);
    },
    [load],
  );

  const download = useCallback(
    async (region: Parameters<OfflineRegionStore["download"]>[0]): Promise<void> => {
      // The created region is discarded on purpose — see the note above. `api.md` publishes this
      // as `Promise<void>`, so a consumer that wants the region reads it from `regions`.
      await mutate(store, () => store.download(region));
    },
    [mutate, store],
  );

  const remove = useCallback(
    async (id: Id): Promise<void> => {
      // No optimistic filter before the await: a rejected delete would otherwise leave the
      // component showing a region gone that is still on disk.
      await mutate(store, () => store.delete(id));
    },
    [mutate, store],
  );

  return { regions, download, remove };
}
