// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it } from "vitest";

import type { MapEvent } from "./event.js";
import { EventNotFoundError, createEventLog } from "./event-log.js";
import type { EventLog } from "./event-log.js";
import { newId } from "./ids.js";
import type { StorageAdapter } from "./storage.js";
import { createMemoryStorageAdapter } from "./testing/memory-storage.js";

const T0 = 1_700_000_000_000;

const draft = (overrides: Partial<Omit<MapEvent, "id">> = {}): Omit<MapEvent, "id"> => ({
  position: { lat: 59.33, lng: 18.06 },
  occurredAt: T0,
  media: [],
  tags: [],
  ...overrides,
});

let store: StorageAdapter;
let log: EventLog;

beforeEach(() => {
  store = createMemoryStorageAdapter();
  log = createEventLog(store);
});

describe("add", () => {
  it("assigns an id and persists", async () => {
    const added = await log.add(draft({ comment: "a note" }));

    expect(added.id).toHaveLength(26);
    expect(await store.getEvent(added.id)).toEqual(added);
  });

  it("gives every event a distinct id", async () => {
    const ids = await Promise.all(
      Array.from({ length: 100 }, () => log.add(draft()).then((e) => e.id)),
    );
    expect(new Set(ids).size).toBe(100);
  });

  it("carries consumer bags through without interpreting them", async () => {
    // The engine stores a consumer's vocabulary and learns nothing from it. (ADR-0001)
    const added = await log.add(
      draft({
        tags: ["one", "two"],
        category: "a-consumer-category",
        fields: { count: 3, nested: { deep: true }, note: "text" },
      }),
    );

    const stored = await store.getEvent(added.id);
    expect(stored?.tags).toEqual(["one", "two"]);
    expect(stored?.category).toBe("a-consumer-category");
    expect(stored?.fields).toEqual({ count: 3, nested: { deep: true }, note: "text" });
  });

  it("stores media references", async () => {
    const added = await log.add(
      draft({ media: [{ id: newId(), mime: "image/jpeg", blobKey: "blob-key", width: 4032 }] }),
    );
    expect((await store.getEvent(added.id))?.media[0]?.blobKey).toBe("blob-key");
  });
});

describe("update", () => {
  it("overwrites an existing event", async () => {
    const added = await log.add(draft({ comment: "before" }));
    await log.update({ ...added, comment: "after" });

    expect((await log.get(added.id))?.comment).toBe("after");
    expect(await log.list()).toHaveLength(1);
  });

  it("throws rather than silently inserting an event that is not there", async () => {
    // A save-through-update would turn "I edited the wrong id" into a duplicate record.
    const orphan: MapEvent = { ...draft(), id: newId() };

    await expect(log.update(orphan)).rejects.toThrow(EventNotFoundError);
    expect(await log.list()).toHaveLength(0);
  });

  it("names the id it could not find", async () => {
    const id = newId();
    await expect(log.update({ ...draft(), id })).rejects.toMatchObject({ eventId: id });
  });
});

describe("get and remove", () => {
  it("returns undefined for an unknown id", async () => {
    expect(await log.get(newId())).toBeUndefined();
  });

  it("removes an event", async () => {
    const added = await log.add(draft());
    await log.remove(added.id);
    expect(await log.get(added.id)).toBeUndefined();
  });

  it("is silent when removing something that is already gone", async () => {
    // Idempotent: a consumer retrying a delete should not have to catch.
    await expect(log.remove(newId())).resolves.toBeUndefined();
  });
});

describe("list", () => {
  it("orders chronologically by occurredAt", async () => {
    await log.add(draft({ occurredAt: T0 + 3000, comment: "third" }));
    await log.add(draft({ occurredAt: T0 + 1000, comment: "first" }));
    await log.add(draft({ occurredAt: T0 + 2000, comment: "second" }));

    expect((await log.list()).map((e) => e.comment)).toEqual(["first", "second", "third"]);
  });

  it("breaks ties by id, so the order is total and does not flicker", async () => {
    // Two events sharing a timestamp is ordinary — a burst of pins, or an import that
    // rounds to the second. An unstable sort would reshuffle them between renders.
    const shared = T0 + 5000;
    const added = await Promise.all([
      log.add(draft({ occurredAt: shared })),
      log.add(draft({ occurredAt: shared })),
      log.add(draft({ occurredAt: shared })),
    ]);

    const expected = added.map((e) => e.id).sort((a, b) => a.localeCompare(b));
    expect((await log.list()).map((e) => e.id)).toEqual(expected);
    expect((await log.list()).map((e) => e.id)).toEqual(expected);
  });

  it("filters to one track", async () => {
    const trip = newId();
    const other = newId();
    await log.add(draft({ trackId: trip }));
    await log.add(draft({ trackId: trip }));
    await log.add(draft({ trackId: other }));
    await log.add(draft());

    expect(await log.list(trip)).toHaveLength(2);
    expect(await log.list(other)).toHaveLength(1);
    expect(await log.list()).toHaveLength(4);
  });

  it("returns an empty list rather than throwing when there is nothing", async () => {
    expect(await log.list()).toEqual([]);
    expect(await log.list(newId())).toEqual([]);
  });

  it("does not let a caller mutate the store through the list it was handed", async () => {
    const added = await log.add(draft({ tags: ["original"] }));
    const listed = await log.list();
    listed[0]?.tags.push("mutated");

    expect((await log.get(added.id))?.tags).toEqual(["original"]);
  });
});

describe("it is only a seam consumer", () => {
  it("works against any StorageAdapter, not just the memory one", async () => {
    // The point of the seam: a consumer's own adapter drives the same logic. This one
    // records the calls, proving EventLog holds no state of its own.
    const calls: string[] = [];
    const inner = createMemoryStorageAdapter();
    const recording: StorageAdapter = {
      ...inner,
      saveEvent: (e) => {
        calls.push("saveEvent");
        return inner.saveEvent(e);
      },
      getEvent: (id) => {
        calls.push("getEvent");
        return inner.getEvent(id);
      },
      listEvents: (trackId) => {
        calls.push("listEvents");
        return inner.listEvents(trackId);
      },
      deleteEvent: (id) => {
        calls.push("deleteEvent");
        return inner.deleteEvent(id);
      },
    };

    const custom = createEventLog(recording);
    const added = await custom.add(draft());
    await custom.update({ ...added, comment: "edited" });
    await custom.list();
    await custom.remove(added.id);

    expect(calls).toEqual(["saveEvent", "getEvent", "saveEvent", "listEvents", "deleteEvent"]);
  });
});
