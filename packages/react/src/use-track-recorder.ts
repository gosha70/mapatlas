// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  SamplingPolicy,
  StorageAdapter,
  Track,
  TrackPoint,
  TrackRecorder,
  TrackRecorderError,
  TrackStatus,
} from "@mapatlas/core";
import { createWebTrackRecorder } from "@mapatlas/recorder-web";

export interface UseTrackRecorderOptions {
  recorder?: TrackRecorder;
  store?: StorageAdapter;
  sampling?: Partial<SamplingPolicy>;
}

export interface TrackRecorderControls {
  status: TrackStatus;
  livePoint: TrackPoint | undefined;
  track: Track | undefined;
  error: TrackRecorderError | undefined;
  start(): Promise<void>;
  pause(): void;
  resume(): void;
  stop(): Promise<Track>;
}

/**
 * Drive a {@link TrackRecorder} from React. Defaults to the web recorder
 * (`@mapatlas/recorder-web`) but accepts any injected recorder — including a
 * fake in tests. Live points and errors flow into state as the recorder emits
 * them; `stop()` resolves with the finalized track and exposes it as `track`.
 */
export function useTrackRecorder(
  opts: UseTrackRecorderOptions = {},
): TrackRecorderControls {
  const { recorder, store, sampling } = opts;

  const recorderRef = useRef<TrackRecorder | null>(null);
  if (recorderRef.current === null) {
    recorderRef.current = recorder ?? createWebTrackRecorder(store);
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
    await rec.start(sampling);
    setStatus(rec.status);
  }, [rec, sampling]);

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
    setStatus(rec.status);
    setLivePoint(undefined);
    setTrack(finalized);
    return finalized;
  }, [rec]);

  return { status, livePoint, track, error, start, pause, resume, stop };
}
