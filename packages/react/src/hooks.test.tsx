// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { createMemoryStorageAdapter } from "@mapatlas/core";
import type {
  Id,
  OfflineRegion,
  OfflineRegionStore,
  Track,
  TrackPoint,
  TrackRecorder,
  TrackRecorderError,
  TrackStatus,
} from "@mapatlas/core";
import { useTrackRecorder } from "./use-track-recorder";
import { useEventLog } from "./use-event-log";
import { useOfflineRegions } from "./use-offline-regions";

afterEach(cleanup);

/** A scriptable in-memory TrackRecorder fake. */
function makeFakeRecorder() {
  let status: TrackStatus = "paused";
  const pointCbs = new Set<(p: TrackPoint) => void>();
  const errorCbs = new Set<(e: TrackRecorderError) => void>();
  const recorder: TrackRecorder = {
    get status() {
      return status;
    },
    async start() {
      status = "recording";
    },
    pause() {
      status = "paused";
    },
    resume() {
      status = "recording";
    },
    async stop(): Promise<Track> {
      status = "finalized";
      return {
        id: "t1",
        startedAt: 0,
        endedAt: 1000,
        status: "finalized",
        points: [{ lat: 1, lng: 2, t: 0 }],
        simplified: [{ lat: 1, lng: 2, t: 0 }],
        distanceM: 42,
      };
    },
    onPoint(cb) {
      pointCbs.add(cb);
      return () => pointCbs.delete(cb);
    },
    onError(cb) {
      errorCbs.add(cb);
      return () => errorCbs.delete(cb);
    },
  };
  return {
    recorder,
    emitPoint: (p: TrackPoint) => pointCbs.forEach((cb) => cb(p)),
    emitError: (e: TrackRecorderError) => errorCbs.forEach((cb) => cb(e)),
  };
}

describe("useTrackRecorder", () => {
  it("reflects lifecycle, live points, errors, and the finalized track", async () => {
    const fake = makeFakeRecorder();
    const { result } = renderHook(() =>
      useTrackRecorder({ recorder: fake.recorder }),
    );

    expect(result.current.status).toBe("paused");

    await act(async () => {
      await result.current.start();
    });
    expect(result.current.status).toBe("recording");

    act(() => fake.emitPoint({ lat: 3, lng: 4, t: 10 }));
    expect(result.current.livePoint).toEqual({ lat: 3, lng: 4, t: 10 });

    act(() => fake.emitError({ kind: "timeout", message: "slow" }));
    expect(result.current.error?.kind).toBe("timeout");

    let stopped: Track | undefined;
    await act(async () => {
      stopped = await result.current.stop();
    });
    expect(stopped?.distanceM).toBe(42);
    expect(result.current.status).toBe("finalized");
    expect(result.current.track?.id).toBe("t1");
    expect(result.current.livePoint).toBeUndefined();
  });
});

describe("useEventLog", () => {
  it("lists, adds, updates, and deletes events against a store", async () => {
    const store = createMemoryStorageAdapter();
    const { result } = renderHook(() => useEventLog(store));

    await waitFor(() => expect(result.current.events).toEqual([]));

    let createdId = "";
    await act(async () => {
      const created = await result.current.addEvent({
        position: { lat: 1, lng: 2 },
        occurredAt: 0,
        media: [],
        tags: ["a"],
      });
      createdId = created.id;
    });
    expect(result.current.events).toHaveLength(1);

    await act(async () => {
      await result.current.deleteEvent(createdId);
    });
    expect(result.current.events).toHaveLength(0);
  });

  it("scopes events to a trackId", async () => {
    const store = createMemoryStorageAdapter();
    const { result } = renderHook(() => useEventLog(store, "track-1"));
    await waitFor(() => expect(result.current.events).toEqual([]));
    await act(async () => {
      await result.current.addEvent({
        trackId: "track-1",
        position: { lat: 1, lng: 2 },
        occurredAt: 0,
        media: [],
        tags: [],
      });
    });
    expect(result.current.events.every((e) => e.trackId === "track-1")).toBe(
      true,
    );
    expect(result.current.events).toHaveLength(1);
  });
});

describe("useOfflineRegions", () => {
  function makeFakeRegionStore(): OfflineRegionStore {
    const regions: OfflineRegion[] = [];
    let seq = 0;
    return {
      async download(r) {
        const region: OfflineRegion = {
          ...r,
          id: `r${seq++}` as Id,
          sizeBytes: 100,
          downloadedAt: 0,
        };
        regions.push(region);
        return region;
      },
      async list() {
        return [...regions];
      },
      async delete(id) {
        const i = regions.findIndex((x) => x.id === id);
        if (i >= 0) regions.splice(i, 1);
      },
      async estimateSize() {
        return 100;
      },
    };
  }

  it("downloads and removes regions", async () => {
    const store = makeFakeRegionStore();
    const { result } = renderHook(() => useOfflineRegions(store));
    await waitFor(() => expect(result.current.regions).toEqual([]));

    await act(async () => {
      await result.current.download({
        name: "Bay",
        bbox: [-122.4, 47.5, -122.2, 47.7],
        minZoom: 10,
        maxZoom: 14,
      });
    });
    expect(result.current.regions).toHaveLength(1);

    await act(async () => {
      await result.current.remove(result.current.regions[0]!.id);
    });
    expect(result.current.regions).toHaveLength(0);
  });
});
