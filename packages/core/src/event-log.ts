// SPDX-License-Identifier: Apache-2.0
import type { Id, MapEvent } from "./types";
import type { StorageAdapter } from "./seams";
import { newId } from "./id";

/**
 * Create/update/delete map events against a StorageAdapter. Holds no state of
 * its own — the adapter is the source of truth — so it works against any
 * conformant persistence implementation.
 */
export class EventLog {
  readonly #store: StorageAdapter;
  readonly #trackId: Id | undefined;

  constructor(store: StorageAdapter, trackId?: Id) {
    this.#store = store;
    this.#trackId = trackId;
  }

  /** List events, scoped to this log's track when one was provided. */
  list(): Promise<MapEvent[]> {
    return this.#store.listEvents(this.#trackId);
  }

  /** Create and persist a new event, assigning it a fresh id. */
  async create(input: Omit<MapEvent, "id">): Promise<MapEvent> {
    const event: MapEvent = { ...input, id: newId() };
    await this.#store.saveEvent(event);
    return event;
  }

  /** Persist an update to an existing event. */
  async update(event: MapEvent): Promise<void> {
    await this.#store.saveEvent(event);
  }

  /** Delete an event by id. */
  async delete(id: Id): Promise<void> {
    await this.#store.deleteEvent(id);
  }
}
