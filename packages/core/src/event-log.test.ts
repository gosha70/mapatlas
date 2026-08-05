// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import type { MapEvent } from "./types.js";
import { EventLog } from "./event-log.js";
import { InMemoryStorageAdapter } from "./fake-storage.js";

function draft(over: Partial<Omit<MapEvent, "id">> = {}): Omit<MapEvent, "id"> {
  return {
    position: { lat: 10, lng: 20 },
    occurredAt: 1000,
    media: [],
    tags: [],
    ...over,
  };
}

describe("EventLog against a fake StorageAdapter", () => {
  it("creates an event with a fresh id and persists it", async () => {
    const store = new InMemoryStorageAdapter();
    const log = new EventLog(store);

    const created = await log.create(draft({ comment: "hello" }));
    expect(created.id).toBeTruthy();
    expect(created.comment).toBe("hello");

    const fetched = await store.getEvent(created.id);
    expect(fetched).toEqual(created);
  });

  it("assigns distinct ids to successive creates", async () => {
    const log = new EventLog(new InMemoryStorageAdapter());
    const a = await log.create(draft());
    const b = await log.create(draft());
    expect(a.id).not.toBe(b.id);
  });

  it("updates an existing event", async () => {
    const store = new InMemoryStorageAdapter();
    const log = new EventLog(store);
    const created = await log.create(draft({ comment: "before" }));

    await log.update({ ...created, comment: "after", tags: ["x"] });

    const fetched = await store.getEvent(created.id);
    expect(fetched?.comment).toBe("after");
    expect(fetched?.tags).toEqual(["x"]);
  });

  it("deletes an event", async () => {
    const store = new InMemoryStorageAdapter();
    const log = new EventLog(store);
    const created = await log.create(draft());

    await log.delete(created.id);

    expect(await store.getEvent(created.id)).toBeUndefined();
    expect(await log.get(created.id)).toBeUndefined();
  });

  it("lists events, optionally filtered by track", async () => {
    const log = new EventLog(new InMemoryStorageAdapter());
    await log.create(draft({ trackId: "t1" }));
    await log.create(draft({ trackId: "t1" }));
    await log.create(draft({ trackId: "t2" }));

    expect(await log.list()).toHaveLength(3);
    expect(await log.list("t1")).toHaveLength(2);
    expect(await log.list("t2")).toHaveLength(1);
    expect(await log.list("nope")).toHaveLength(0);
  });
});
