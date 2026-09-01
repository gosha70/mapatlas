// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { EventLog, Id, MapEvent, StorageAdapter } from "@mapatlas/core";
import { createEventLog } from "@mapatlas/core";

/**
 * Bind an event log to React state (`api.md` §9).
 *
 * **Core owns the policy; this owns the lifecycle.** Id assignment, the refusal to insert on
 * update, and the stable chronological order all live in `createEventLog`, whose own
 * documentation says it exists "because 'assign an id, persist, list back in a stable order' is
 * worth having in one place rather than in every consumer and every React hook". Reimplementing
 * any of it here would give the engine two answers to the same question.
 *
 * **State after a mutation comes from the log, never from local array surgery.** Splicing the
 * returned event into the array a component is holding looks equivalent and is not: it would put
 * the event wherever the array happened to end, while the log orders by `occurredAt` with ties
 * broken by id. A consumer would then see one order until it refreshed and a different one
 * after — and the version that ordered correctly would be the one nobody tested.
 */
export interface EventLogBinding {
  events: MapEvent[];
  addEvent(input: Omit<MapEvent, "id">): Promise<MapEvent>;
  updateEvent(event: MapEvent): Promise<void>;
  deleteEvent(id: Id): Promise<void>;
}

/** @internal — lets the tests supply a counted log without mocking the module graph. */
export interface UseEventLogInternals {
  createLog?: (store: StorageAdapter) => EventLog;
}

export function useEventLog(
  store: StorageAdapter,
  trackId?: Id,
  internals: UseEventLogInternals = {},
): EventLogBinding {
  const build = internals.createLog ?? createEventLog;
  // One log per store, so a re-render does not rebuild it and the identity below is stable.
  const log = useMemo(() => build(store), [build, store]);
  const [events, setEvents] = useState<MapEvent[]>([]);

  /**
   * Which load is allowed to publish.
   *
   * A counter rather than a boolean, because the hazard is not only "after unmount": a list for
   * `trackId: A` can resolve *after* one for `B` and overwrite it, leaving the component showing
   * another track's events with no error anywhere. Every load captures the generation it began
   * in, and only the current one may set state.
   */
  const generation = useRef(0);

  const load = useCallback(
    async (current: EventLog, id: Id | undefined, at: number): Promise<void> => {
      const listed = await current.list(id);
      if (generation.current === at) setEvents(listed);
    },
    [],
  );

  useEffect(() => {
    // Incremented **here**, at the start of each run, which is what makes the previous load
    // stale. A cleanup that incremented again would be unobservable: every re-run already
    // invalidates its predecessor, and after unmount there is nothing to invalidate for —
    // a state update on a torn-down root is inert. Verified by mutation rather than reasoned
    // about: adding one changed no test, so it is not here.
    generation.current += 1;
    const at = generation.current;
    void load(log, trackId, at).catch(() => {
      // A failed initial list leaves the previous events rather than blanking the view; the
      // consumer's own error path is not this hook's to invent.
    });
  }, [log, trackId, load]);

  /** Re-read after a mutation, under the generation that was current when it was issued. */
  const refresh = useCallback(async (): Promise<void> => {
    await load(log, trackId, generation.current);
  }, [load, log, trackId]);

  const addEvent = useCallback(
    async (input: Omit<MapEvent, "id">): Promise<MapEvent> => {
      const created = await log.add(input);
      await refresh();
      return created;
    },
    [log, refresh],
  );

  const updateEvent = useCallback(
    async (event: MapEvent): Promise<void> => {
      // No local patch before the await: a rejected update would otherwise leave the component
      // showing an edit the store refused.
      await log.update(event);
      await refresh();
    },
    [log, refresh],
  );

  const deleteEvent = useCallback(
    async (id: Id): Promise<void> => {
      await log.remove(id);
      await refresh();
    },
    [log, refresh],
  );

  return { events, addEvent, updateEvent, deleteEvent };
}
