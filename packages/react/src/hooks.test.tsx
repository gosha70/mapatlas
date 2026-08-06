// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

/**
 * T5.1 acceptance: the hooks work against fakes (a fake recorder, the in-memory
 * StorageAdapter, and a fake OfflineRegionStore) with no hardware.
 */
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type {
  MapEvent,
  OfflineRegion,
  OfflineRegionStore,
  Track,
  TrackPoint,
  TrackRecorder,
  TrackRecorderError,
  TrackStatus,
} from "@mapatlas/core";
import { InMemoryStorageAdapter } from "@mapatlas/core";
import { useEventLog, useOfflineRegions, useTrackRecorder } from "./hooks.js";

class FakeRecorder implements TrackRecorder {
  status: TrackStatus = "paused";
  private pointCbs = new Set<(p: TrackPoint) => void>();
  private errorCbs = new Set<(e: TrackRecorderError) => void>();
  finalTrack: Track = {
    id: "t1",
    startedAt: 0,
    endedAt: 10,
    status: "finalized",
    points: [{ lat: 1, lng: 1, t: 1 }],
    simplified: [{ lat: 1, lng: 1, t: 1 }],
    distanceM: 0,
  };
  start = async (): Promise<void> => {
    this.status = "recording";
  };
  pause = (): void => {
    this.status = "paused";
  };
  resume = (): void => {
    this.status = "recording";
  };
  stop = async (): Promise<Track> => {
    this.status = "finalized";
    return this.finalTrack;
  };
  onPoint(cb: (p: TrackPoint) => void): () => void {
    this.pointCbs.add(cb);
    return () => this.pointCbs.delete(cb);
  }
  onError(cb: (e: TrackRecorderError) => void): () => void {
    this.errorCbs.add(cb);
    return () => this.errorCbs.delete(cb);
  }
  emitPoint(p: TrackPoint): void {
    for (const cb of this.pointCbs) cb(p);
  }
  emitError(e: TrackRecorderError): void {
    for (const cb of this.errorCbs) cb(e);
  }
}

class FakeOfflineStore implements OfflineRegionStore {
  private regions: OfflineRegion[] = [];
  private n = 0;
  async download(
    r: Omit<OfflineRegion, "id" | "sizeBytes" | "downloadedAt">,
  ): Promise<OfflineRegion> {
    const region: OfflineRegion = {
      ...r,
      id: `r${this.n++}`,
      sizeBytes: 1000,
      downloadedAt: Date.now(),
    };
    this.regions.push(region);
    return region;
  }
  async list(): Promise<OfflineRegion[]> {
    return this.regions.slice();
  }
  async delete(id: string): Promise<void> {
    this.regions = this.regions.filter((x) => x.id !== id);
  }
  async estimateSize(): Promise<number> {
    return 1000;
  }
}

afterEach(cleanup);

describe("useTrackRecorder", () => {
  it("reflects status, live points, and the finalized track", async () => {
    const rec = new FakeRecorder();
    const { result } = renderHook(() => useTrackRecorder({ recorder: rec }));

    expect(result.current.status).toBe("paused");

    await act(async () => {
      await result.current.start();
    });
    expect(result.current.status).toBe("recording");

    act(() => rec.emitPoint({ lat: 2, lng: 3, t: 5 }));
    expect(result.current.livePoint).toEqual({ lat: 2, lng: 3, t: 5 });

    let stopped: Track | undefined;
    await act(async () => {
      stopped = await result.current.stop();
    });
    expect(stopped?.id).toBe("t1");
    expect(result.current.status).toBe("finalized");
    expect(result.current.track?.id).toBe("t1");
    expect(result.current.livePoint).toBeUndefined();
  });

  it("surfaces recorder errors", async () => {
    const rec = new FakeRecorder();
    const { result } = renderHook(() => useTrackRecorder({ recorder: rec }));
    act(() => rec.emitError({ kind: "permission-denied", message: "no" }));
    expect(result.current.error?.kind).toBe("permission-denied");
  });
});

describe("useEventLog", () => {
  it("lists, adds, updates and deletes events via the store", async () => {
    const store = new InMemoryStorageAdapter();
    const { result } = renderHook(() => useEventLog(store));

    const draft: Omit<MapEvent, "id"> = {
      position: { lat: 1, lng: 2 },
      occurredAt: 1,
      media: [],
      tags: [],
      comment: "first",
    };

    let created: MapEvent | undefined;
    await act(async () => {
      created = await result.current.addEvent(draft);
    });
    expect(result.current.events).toHaveLength(1);

    await act(async () => {
      await result.current.updateEvent({ ...created!, comment: "edited" });
    });
    expect(result.current.events[0]?.comment).toBe("edited");

    await act(async () => {
      await result.current.deleteEvent(created!.id);
    });
    expect(result.current.events).toHaveLength(0);
  });
});

describe("useOfflineRegions", () => {
  it("downloads and removes regions via the store", async () => {
    const store = new FakeOfflineStore();
    const { result } = renderHook(() => useOfflineRegions(store));

    await act(async () => {
      await result.current.download({
        name: "bay",
        bbox: [-1, -1, 1, 1],
        minZoom: 8,
        maxZoom: 12,
      });
    });
    expect(result.current.regions).toHaveLength(1);
    const id = result.current.regions[0]!.id;

    await act(async () => {
      await result.current.remove(id);
    });
    expect(result.current.regions).toHaveLength(0);
  });
});
