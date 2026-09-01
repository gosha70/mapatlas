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
   * Which *context* a load belongs to — bumped when the store or `trackId` changes.
   *
   * A token rather than a boolean, because the hazard is not only "after unmount": a list for
   * `trackId: A` can resolve *after* one for `B` and overwrite it, leaving the component showing
   * another track's events with no error anywhere. Every load captures the token it began in,
   * and only a load still in the current context may set state.
   */
  const context = useRef(0);
  /**
   * Which load is the newest — bumped once per `list` issued.
   *
   * **Context alone is not enough.** The context token only changes when the store or `trackId`
   * does, so an initial list and a post-mutation list *in the same context* carry the same
   * token. If the mutation's list publishes and the initial list then resolves with its older
   * snapshot, that snapshot passes a context-only guard and silently undoes the mutation.
   * Ordering between two loads needs a token that orders them.
   */
  const issued = useRef(0);

  const load = useCallback(
    async (current: EventLog, id: Id | undefined, at: number): Promise<void> => {
      const sequence = (issued.current += 1);
      const listed = await current.list(id);
      // Both: the right log and track, and still the newest request for them.
      if (context.current === at && issued.current === sequence) setEvents(listed);
    },
    [],
  );

  useEffect(() => {
    // Incremented **here**, at the start of each run, which is what makes the previous load
    // stale. A cleanup that incremented again would be unobservable: every re-run already
    // invalidates its predecessor, and after unmount there is nothing to invalidate for —
    // a state update on a torn-down root is inert. Verified by mutation rather than reasoned
    // about: adding one changed no test, so it is not here.
    context.current += 1;
    const at = context.current;
    void load(log, trackId, at).catch(() => {
      // A failed initial list leaves the previous events rather than blanking the view; the
      // consumer's own error path is not this hook's to invent.
    });
  }, [log, trackId, load]);

  /**
   * Run a mutation, then re-read — under the context token current **when it started**.
   *
   * Sampling the context token after the mutation resolved was a race: a mutation against log A, a
   * change of `store` or `trackId` to B while it ran, and then A's re-read taking
   * `context.current` — a ref, so it holds *B's* token — and publishing A's events over B's.
   * Capturing first makes the stale re-read fail the guard that exists to stop it.
   */
  const mutate = useCallback(
    async (current: EventLog, id: Id | undefined, run: () => Promise<unknown>): Promise<void> => {
      const at = context.current;
      await run();
      // Not merely "do not publish" — do not *list* at all: the log this mutation belonged to is
      // no longer the one on screen, and its answer could only ever be discarded.
      if (context.current !== at) return;
      await load(current, id, at);
    },
    [load],
  );

  const addEvent = useCallback(
    async (input: Omit<MapEvent, "id">): Promise<MapEvent> => {
      let created: MapEvent | undefined;
      await mutate(log, trackId, async () => {
        created = await log.add(input);
      });
      // `mutate` only resolves after `log.add` did, so this is set.
      return created as MapEvent;
    },
    [log, mutate, trackId],
  );

  const updateEvent = useCallback(
    async (event: MapEvent): Promise<void> => {
      // No local patch before the await: a rejected update would otherwise leave the component
      // showing an edit the store refused.
      await mutate(log, trackId, () => log.update(event));
    },
    [log, mutate, trackId],
  );

  const deleteEvent = useCallback(
    async (id: Id): Promise<void> => {
      await mutate(log, trackId, () => log.remove(id));
    },
    [log, mutate, trackId],
  );

  return { events, addEvent, updateEvent, deleteEvent };
}
