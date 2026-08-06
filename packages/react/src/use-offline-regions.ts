// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useState } from "react";
import type { Id, OfflineRegion, OfflineRegionStore } from "@mapatlas/core";

export interface OfflineRegionControls {
  regions: OfflineRegion[];
  download(r: Parameters<OfflineRegionStore["download"]>[0]): Promise<void>;
  remove(id: Id): Promise<void>;
}

/**
 * List, download, and delete offline map regions from React. Each mutation
 * re-reads the store's region list.
 */
export function useOfflineRegions(
  store: OfflineRegionStore,
): OfflineRegionControls {
  const [regions, setRegions] = useState<OfflineRegion[]>([]);

  const refresh = useCallback(async () => {
    setRegions(await store.list());
  }, [store]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const download = useCallback(
    async (r: Parameters<OfflineRegionStore["download"]>[0]) => {
      await store.download(r);
      await refresh();
    },
    [store, refresh],
  );

  const remove = useCallback(
    async (id: Id) => {
      await store.delete(id);
      await refresh();
    },
    [store, refresh],
  );

  return { regions, download, remove };
}
