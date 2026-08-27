// SPDX-License-Identifier: Apache-2.0

import type { MapEvent } from "../event.js";
import { newId } from "../ids.js";
import type { StorageAdapter } from "../storage.js";
import type { Track } from "../track.js";

/**
 * The executable `StorageAdapter` contract.
 *
 * `StorageAdapter` is deliberately third-party implementable, so the engine ships the same
 * conformance cases it holds its own adapters to. An implementer runs these and knows
 * whether their adapter is one, rather than discovering a divergence in production.
 *
 * **Framework-neutral by construction.** Each case is a name and an async function that
 * throws on failure; nothing here imports a test runner, and adopting the contract does not
 * drag a project onto ours. Map the cases into Vitest, Jest, `node:test` or anything else:
 *
 * ```ts
 * for (const { name, run } of storageAdapterContract(() => createMyAdapter())) {
 *   it(name, run);
 * }
 * ```
 *
 * Every case takes a **fresh adapter** from the factory, so cases cannot leak state into
 * one another and may be run in any order, or alone.
 */
export interface StorageContractCase {
  name: string;
  run(): Promise<void>;
}

export type StorageAdapterFactory = () => StorageAdapter | Promise<StorageAdapter>;

/** Deliberately plain: an implementer should not need our matchers to read a failure. */
function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`StorageAdapter contract: ${message}`);
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  assert(a === b, `${message}\n  expected: ${b}\n  actual:   ${a}`);
}

const T0 = 1_700_000_000_000;

function makeTrack(overrides: Partial<Track> = {}): Track {
  const points = [
    { lat: 59.33, lng: 18.06, t: T0 },
    { lat: 59.34, lng: 18.07, t: T0 + 60_000 },
  ];
  return {
    id: newId(),
    startedAt: T0,
    endedAt: T0 + 60_000,
    status: "finalized",
    origin: "recorded",
    points,
    segments: [{ id: newId(), startIndex: 0, endIndex: 1, startedAt: T0 }],
    ...overrides,
  };
}

function makeEvent(overrides: Partial<MapEvent> = {}): MapEvent {
  return {
    id: newId(),
    position: { lat: 59.33, lng: 18.06 },
    occurredAt: T0,
    media: [],
    tags: [],
    ...overrides,
  };
}

const blob = (text: string): Blob => new Blob([text], { type: "text/plain" });

export function storageAdapterContract(
  createAdapter: StorageAdapterFactory,
): readonly StorageContractCase[] {
  const withAdapter =
    (run: (store: StorageAdapter) => Promise<void>) => async (): Promise<void> => {
      await run(await createAdapter());
    };

  return [
    {
      name: "saveTrack then getTrack returns an equal track",
      run: withAdapter(async (store) => {
        const track = makeTrack();
        await store.saveTrack(track);
        assertEqual(await store.getTrack(track.id), track, "the retrieved track differs");
      }),
    },
    {
      name: "getTrack returns undefined for an unknown id",
      run: withAdapter(async (store) => {
        assert((await store.getTrack(newId())) === undefined, "expected undefined");
      }),
    },
    {
      name: "saving the same id twice overwrites rather than duplicating",
      run: withAdapter(async (store) => {
        const track = makeTrack({ tags: ["first"] });
        await store.saveTrack(track);
        await store.saveTrack({ ...track, tags: ["second"] });

        assertEqual((await store.getTrack(track.id))?.tags, ["second"], "not overwritten");
        assert((await store.listTrackSummaries()).length === 1, "duplicated instead of replacing");
      }),
    },
    {
      name: "a retrieved track is a copy — mutating it does not change the store",
      run: withAdapter(async (store) => {
        // Real persistence serialises, so it hands back a copy. An adapter that returns its
        // own object lets callers corrupt it invisibly, and code written against it breaks
        // the moment it meets a serialising implementation.
        const track = makeTrack();
        await store.saveTrack(track);

        const retrieved = await store.getTrack(track.id);
        retrieved?.points.push({ lat: 0, lng: 0, t: 0 });

        assert(
          (await store.getTrack(track.id))?.points.length === 2,
          "mutation leaked into the store",
        );
      }),
    },
    {
      name: "a saved track is decoupled from the object that was passed in",
      run: withAdapter(async (store) => {
        const track = makeTrack();
        await store.saveTrack(track);
        track.points.push({ lat: 0, lng: 0, t: 0 });

        assert(
          (await store.getTrack(track.id))?.points.length === 2,
          "the store aliased the argument",
        );
      }),
    },
    {
      name: "listTrackSummaries carries no point array",
      run: withAdapter(async (store) => {
        await store.saveTrack(makeTrack());
        const [summary] = await store.listTrackSummaries();

        assert(summary !== undefined, "no summary returned");
        assert(!("points" in (summary as object)), "the summary hydrated points");
        assert(!("segments" in (summary as object)), "the summary hydrated segments");
      }),
    },
    {
      name: "a summary reports counts and bounds matching the stored track",
      run: withAdapter(async (store) => {
        const track = makeTrack();
        await store.saveTrack(track);
        await store.saveEvent(makeEvent({ trackId: track.id }));

        const [summary] = await store.listTrackSummaries();
        assert(summary?.pointCount === 2, `pointCount was ${String(summary?.pointCount)}`);
        assert(summary?.eventCount === 1, `eventCount was ${String(summary?.eventCount)}`);
        assertEqual(summary?.bbox, [18.06, 59.33, 18.07, 59.34], "bbox differs");
        assert(summary?.status === track.status, "status differs");
        assert(summary?.origin === track.origin, "origin differs");
      }),
    },
    {
      name: "chronological order comes from startedAt, never from the id",
      run: withAdapter(async (store) => {
        // An imported trip is minted today while its startedAt is years old, so it sorts
        // last by id and first by time. Conflating the two is the trap. (ADR-0014)
        const recent = makeTrack({ startedAt: T0 });
        const importedOld = makeTrack({ startedAt: T0 - 200_000_000_000, origin: "imported" });
        await store.saveTrack(recent);
        await store.saveTrack(importedOld);

        const summaries = await store.listTrackSummaries();
        const byStart = [...summaries].sort((a, b) => a.startedAt - b.startedAt);
        assert(
          byStart[0]?.id === importedOld.id,
          "the oldest trip did not sort first by startedAt",
        );
      }),
    },
    {
      name: "listTrackSummaries is empty for an empty store",
      run: withAdapter(async (store) => {
        assertEqual(await store.listTrackSummaries(), [], "expected no summaries");
      }),
    },
    {
      name: "saveEvent then getEvent returns an equal event",
      run: withAdapter(async (store) => {
        const event = makeEvent({ comment: "a note", tags: ["x"], fields: { n: 1 } });
        await store.saveEvent(event);
        assertEqual(await store.getEvent(event.id), event, "the retrieved event differs");
      }),
    },
    {
      name: "a retrieved event is a copy",
      run: withAdapter(async (store) => {
        const event = makeEvent({ tags: ["original"] });
        await store.saveEvent(event);

        (await store.getEvent(event.id))?.tags.push("mutated");
        assertEqual((await store.getEvent(event.id))?.tags, ["original"], "mutation leaked");
      }),
    },
    {
      name: "listEvents filters by track, and returns everything unfiltered",
      run: withAdapter(async (store) => {
        const a = newId();
        const b = newId();
        await store.saveEvent(makeEvent({ trackId: a }));
        await store.saveEvent(makeEvent({ trackId: a }));
        await store.saveEvent(makeEvent({ trackId: b }));
        await store.saveEvent(makeEvent());

        assert((await store.listEvents(a)).length === 2, "wrong count for track a");
        assert((await store.listEvents(b)).length === 1, "wrong count for track b");
        assert((await store.listEvents()).length === 4, "wrong unfiltered count");
      }),
    },
    {
      name: "deleteEvent removes only its target",
      run: withAdapter(async (store) => {
        const doomed = makeEvent();
        await store.saveEvent(doomed);
        await store.saveEvent(makeEvent());

        await store.deleteEvent(doomed.id);

        assert((await store.getEvent(doomed.id)) === undefined, "the event survived");
        assert((await store.listEvents()).length === 1, "a neighbour was removed too");
      }),
    },
    {
      name: "putBlob then getBlob round-trips the bytes",
      run: withAdapter(async (store) => {
        const key = await store.putBlob(blob("photo bytes"));
        const stored = await store.getBlob(key);
        if (stored === undefined)
          throw new Error("StorageAdapter contract: the blob was not stored");
        assert((await stored.text()) === "photo bytes", "the bytes differ");
      }),
    },
    {
      name: "getBlob returns undefined for an unknown key",
      run: withAdapter(async (store) => {
        assert((await store.getBlob("no-such-key")) === undefined, "expected undefined");
      }),
    },
    {
      name: "putBlob gives distinct keys to distinct blobs",
      run: withAdapter(async (store) => {
        const first = await store.putBlob(blob("a"));
        const second = await store.putBlob(blob("b"));
        assert(first !== second, "the same key was reused");
        assert((await (await store.getBlob(first))?.text()) === "a", "the first blob changed");
      }),
    },
    {
      name: "deleteTrack cascades to its events and to blobs only they referenced",
      run: withAdapter(async (store) => {
        const track = makeTrack();
        const key = await store.putBlob(blob("photo"));
        await store.saveTrack(track);
        await store.saveEvent(
          makeEvent({
            trackId: track.id,
            media: [{ id: newId(), mime: "image/jpeg", blobKey: key }],
          }),
        );

        await store.deleteTrack(track.id);

        assert((await store.getTrack(track.id)) === undefined, "the track survived");
        assert((await store.listEvents()).length === 0, "its events survived");
        assert((await store.getBlob(key)) === undefined, "an orphaned blob survived");
      }),
    },
    {
      name: "deleteTrack keeps a blob another event still references",
      run: withAdapter(async (store) => {
        const track = makeTrack();
        const key = await store.putBlob(blob("shared"));
        const media = [{ id: newId(), mime: "image/jpeg", blobKey: key }];

        await store.saveTrack(track);
        await store.saveEvent(makeEvent({ trackId: track.id, media }));
        await store.saveEvent(makeEvent({ media })); // belongs to no track

        await store.deleteTrack(track.id);

        assert((await store.getBlob(key)) !== undefined, "a referenced blob was deleted");
        assert((await store.listEvents()).length === 1, "an unrelated event was removed");
      }),
    },
    {
      name: "deleteTrack leaves other tracks and their events alone",
      run: withAdapter(async (store) => {
        const doomed = makeTrack();
        const survivor = makeTrack();
        await store.saveTrack(doomed);
        await store.saveTrack(survivor);
        await store.saveEvent(makeEvent({ trackId: doomed.id }));
        await store.saveEvent(makeEvent({ trackId: survivor.id }));

        await store.deleteTrack(doomed.id);

        assert((await store.getTrack(survivor.id)) !== undefined, "the wrong track was deleted");
        assert((await store.listEvents()).length === 1, "the wrong events were deleted");
      }),
    },
    {
      name: "deleting something already gone is silent",
      run: withAdapter(async (store) => {
        await store.deleteTrack(newId());
        await store.deleteEvent(newId());
        await store.deleteBlob("no-such-key");
      }),
    },
    {
      name: "clearAll removes every track, event and blob",
      run: withAdapter(async (store) => {
        const track = makeTrack();
        const key = await store.putBlob(blob("x"));
        await store.saveTrack(track);
        await store.saveEvent(makeEvent({ trackId: track.id }));

        await store.clearAll();

        assertEqual(await store.listTrackSummaries(), [], "tracks survived");
        assertEqual(await store.listEvents(), [], "events survived");
        assert((await store.getBlob(key)) === undefined, "a blob survived");
      }),
    },
    {
      name: "the store is usable again after clearAll",
      run: withAdapter(async (store) => {
        await store.saveTrack(makeTrack());
        await store.clearAll();

        const track = makeTrack();
        await store.saveTrack(track);
        assert((await store.getTrack(track.id)) !== undefined, "the store did not recover");
      }),
    },
  ];
}
