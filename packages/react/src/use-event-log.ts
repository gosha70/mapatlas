// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useMemo, useState } from "react";
import { EventLog } from "@mapatlas/core";
import type { Id, MapEvent, StorageAdapter } from "@mapatlas/core";

export interface EventLogControls {
  events: MapEvent[];
  addEvent(input: Omit<MapEvent, "id">): Promise<MapEvent>;
  updateEvent(e: MapEvent): Promise<void>;
  deleteEvent(id: Id): Promise<void>;
}

/**
 * Read and mutate the {@link MapEvent} log for a store (optionally scoped to a
 * track) from React. Every mutation re-reads the store so the `events` array
 * stays the single source of truth — the store is authoritative, not local
 * state (mirrors {@link EventLog}).
 */
export function useEventLog(
  store: StorageAdapter,
  trackId?: Id,
): EventLogControls {
  const log = useMemo(() => new EventLog(store, trackId), [store, trackId]);
  const [events, setEvents] = useState<MapEvent[]>([]);

  const refresh = useCallback(async () => {
    setEvents(await log.list());
  }, [log]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const addEvent = useCallback(
    async (input: Omit<MapEvent, "id">) => {
      const created = await log.create(input);
      await refresh();
      return created;
    },
    [log, refresh],
  );

  const updateEvent = useCallback(
    async (e: MapEvent) => {
      await log.update(e);
      await refresh();
    },
    [log, refresh],
  );

  const deleteEvent = useCallback(
    async (id: Id) => {
      await log.delete(id);
      await refresh();
    },
    [log, refresh],
  );

  return { events, addEvent, updateEvent, deleteEvent };
}
