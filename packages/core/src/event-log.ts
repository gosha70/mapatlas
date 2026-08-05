// SPDX-License-Identifier: Apache-2.0

import type { Id, MapEvent } from "./types.js";
import type { StorageAdapter } from "./interfaces.js";
import { newId } from "./id.js";

/**
 * EventLog (tasks T1.5): create/update/delete `MapEvent`s against a
 * `StorageAdapter`. Pure orchestration — no domain knowledge; consumer data
 * rides in `tags`, `category`, and `fields`.
 */
export class EventLog {
  constructor(private readonly store: StorageAdapter) {}

  /** Create a new event, assigning a fresh id, and persist it. */
  async create(input: Omit<MapEvent, "id">): Promise<MapEvent> {
    const event: MapEvent = { ...input, id: newId() };
    await this.store.saveEvent(event);
    return event;
  }

  /** Persist an update to an existing event. */
  async update(event: MapEvent): Promise<void> {
    await this.store.saveEvent(event);
  }

  /** Delete an event by id. */
  async delete(id: Id): Promise<void> {
    await this.store.deleteEvent(id);
  }

  /** Read one event by id. */
  get(id: Id): Promise<MapEvent | undefined> {
    return this.store.getEvent(id);
  }

  /** List events, optionally filtered to a track. */
  list(trackId?: Id): Promise<MapEvent[]> {
    return this.store.listEvents(trackId);
  }
}
