// SPDX-License-Identifier: Apache-2.0

import type { MapEvent } from "./event.js";
import type { Id } from "./ids.js";
import { newId } from "./ids.js";
import type { StorageAdapter } from "./storage.js";

/**
 * Create, update and delete events against a {@link StorageAdapter}.
 *
 * Thin on purpose. The engine has no opinion about what an event *means* — `tags`,
 * `category` and `fields` are consumer bags — so there is nothing here to validate beyond
 * the structural minimum, and inventing rules would be inventing a domain. (ADR-0001)
 *
 * It exists at all because "assign an id, persist, list back in a stable order" is worth
 * having in one place rather than in every consumer and every React hook.
 */
export interface EventLog {
  /** Assign an id and persist. Returns the stored event, id included. */
  add(input: Omit<MapEvent, "id">): Promise<MapEvent>;
  /** Overwrite an existing event. Rejects if it is not there — a silent insert would hide a bug. */
  update(event: MapEvent): Promise<void>;
  get(id: Id): Promise<MapEvent | undefined>;
  /** Chronological by `occurredAt`; ties broken by id, so the order is total and stable. */
  list(trackId?: Id): Promise<MapEvent[]>;
  remove(id: Id): Promise<void>;
}

/** An update was addressed to an event the store does not hold. */
export class EventNotFoundError extends Error {
  readonly eventId: Id;

  constructor(eventId: Id) {
    super(`no event with id ${eventId}`);
    this.name = "EventNotFoundError";
    this.eventId = eventId;
  }
}

export function createEventLog(store: StorageAdapter): EventLog {
  return {
    add: async (input) => {
      const event: MapEvent = { ...input, id: newId() };
      await store.saveEvent(event);
      return event;
    },

    update: async (event) => {
      // Read first: `saveEvent` would happily insert, and an update that silently creates
      // turns "I edited the wrong id" into a duplicate rather than an error.
      const existing = await store.getEvent(event.id);
      if (existing === undefined) throw new EventNotFoundError(event.id);
      await store.saveEvent(event);
    },

    get: (id) => store.getEvent(id),

    list: async (trackId) => {
      const events = await store.listEvents(trackId);
      // Adapters are not required to return any particular order, so impose one here rather
      // than letting a consumer's list reshuffle when the storage layer changes. `occurredAt`
      // is the meaningful key; the id tiebreak makes it total, since two events can share a
      // timestamp and an unstable sort would otherwise flicker between renders.
      return events.sort((a, b) => a.occurredAt - b.occurredAt || a.id.localeCompare(b.id));
    },

    remove: (id) => store.deleteEvent(id),
  };
}
