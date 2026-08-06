// SPDX-License-Identifier: Apache-2.0

/**
 * React hooks (tasks T5.1): thin, testable wrappers over the engine seams.
 *
 *  - {@link useTrackRecorder} drives a {@link TrackRecorder} (defaulting to the
 *    web recorder) and exposes reactive status / live point / finalized track.
 *  - {@link useEventLog} reads and mutates events through a {@link StorageAdapter}.
 *  - {@link useOfflineRegions} lists / downloads / removes offline regions.
 *
 * All three accept fakes so they can be unit-tested without hardware.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  Id,
  MapEvent,
  OfflineRegion,
  OfflineRegionStore,
  SamplingPolicy,
  StorageAdapter,
  Track,
  TrackPoint,
  TrackRecorder,
  TrackRecorderError,
  TrackStatus,
} from "@mapatlas/core";
import { EventLog, createWebTrackRecorder } from "@mapatlas/core";

export interface UseTrackRecorderOptions {
  recorder?: TrackRecorder;
  store?: StorageAdapter;
  sampling?: Partial<SamplingPolicy>;
}

export interface UseTrackRecorderResult {
  status: TrackStatus;
  livePoint: TrackPoint | undefined;
  track: Track | undefined;
  start(): Promise<void>;
  pause(): void;
  resume(): void;
  stop(): Promise<Track>;
  error: TrackRecorderError | undefined;
}

export function useTrackRecorder(
  opts: UseTrackRecorderOptions = {},
): UseTrackRecorderResult {
  const recorderRef = useRef<TrackRecorder | undefined>(undefined);
  if (!recorderRef.current) {
    recorderRef.current = opts.recorder ?? createWebTrackRecorder(opts.store);
  }
  const rec = recorderRef.current;

  const [status, setStatus] = useState<TrackStatus>(rec.status);
  const [livePoint, setLivePoint] = useState<TrackPoint | undefined>(undefined);
  const [track, setTrack] = useState<Track | undefined>(undefined);
  const [error, setError] = useState<TrackRecorderError | undefined>(undefined);

  useEffect(() => {
    const offPoint = rec.onPoint((p) => setLivePoint(p));
    const offError = rec.onError((e) => setError(e));
    return () => {
      offPoint();
      offError();
    };
  }, [rec]);

  const start = useCallback(async () => {
    setError(undefined);
    setTrack(undefined);
    await rec.start(opts.sampling);
    setStatus(rec.status);
  }, [rec, opts.sampling]);

  const pause = useCallback(() => {
    rec.pause();
    setStatus(rec.status);
  }, [rec]);

  const resume = useCallback(() => {
    rec.resume();
    setStatus(rec.status);
  }, [rec]);

  const stop = useCallback(async () => {
    const finalized = await rec.stop();
    setTrack(finalized);
    setStatus(rec.status);
    setLivePoint(undefined);
    return finalized;
  }, [rec]);

  return { status, livePoint, track, start, pause, resume, stop, error };
}

export interface UseEventLogResult {
  events: MapEvent[];
  addEvent(input: Omit<MapEvent, "id">): Promise<MapEvent>;
  updateEvent(e: MapEvent): Promise<void>;
  deleteEvent(id: Id): Promise<void>;
}

export function useEventLog(
  store: StorageAdapter,
  trackId?: Id,
): UseEventLogResult {
  const log = useMemo(() => new EventLog(store), [store]);
  const [events, setEvents] = useState<MapEvent[]>([]);

  const refresh = useCallback(async () => {
    setEvents(await log.list(trackId));
  }, [log, trackId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const addEvent = useCallback(
    async (input: Omit<MapEvent, "id">) => {
      const created = await log.create(input);
      await refresh();
      return created;
    },
    [log, refresh],
  );

  const updateEvent = useCallback(
    async (e: MapEvent) => {
      await log.update(e);
      await refresh();
    },
    [log, refresh],
  );

  const deleteEvent = useCallback(
    async (id: Id) => {
      await log.delete(id);
      await refresh();
    },
    [log, refresh],
  );

  return { events, addEvent, updateEvent, deleteEvent };
}

export interface UseOfflineRegionsResult {
  regions: OfflineRegion[];
  download(r: Parameters<OfflineRegionStore["download"]>[0]): Promise<void>;
  remove(id: Id): Promise<void>;
}

export function useOfflineRegions(
  store: OfflineRegionStore,
): UseOfflineRegionsResult {
  const [regions, setRegions] = useState<OfflineRegion[]>([]);

  const refresh = useCallback(async () => {
    setRegions(await store.list());
  }, [store]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const download = useCallback(
    async (r: Parameters<OfflineRegionStore["download"]>[0]) => {
      await store.download(r);
      await refresh();
    },
    [store, refresh],
  );

  const remove = useCallback(
    async (id: Id) => {
      await store.delete(id);
      await refresh();
    },
    [store, refresh],
  );

  return { regions, download, remove };
}
