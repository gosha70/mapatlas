// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef, useState } from "react";

import type {
  SamplingPolicy,
  SensorSource,
  StorageAdapter,
  Track,
  TrackPoint,
  TrackRecorder,
  TrackRecorderError,
  TrackStatus,
} from "@mapatlas/core";

import type { TrackRecorderHookEnvironment } from "./environment.js";
import { browserRecorderEnvironment } from "./environment.js";

/**
 * Bind a {@link TrackRecorder} to React state (`api.md` §9, ADR-0026).
 *
 * **`start()` never consumes `recovered`.** Recovery is two explicit operations, because
 * `resume()` returns the *current, in-memory* paused session to recording while
 * `resumeRecovered()` restores an *interrupted prior session* from durable storage. They are
 * different operations on different subjects, and the second cannot be expressed as the first:
 * `resumeFrom` is constructor state on the web recorder, not a method on the `TrackRecorder`
 * seam, so a recorder that already exists cannot be told to resume a track.
 *
 * **Recovery belongs only to the hook-owned recorder.** Supply `recorder` and `recovered` stays
 * `undefined` with no scan run — a consequence of that same seam. `resumeFrom` is deliberately
 * absent from `TrackRecorder`, so honouring `resumeRecovered()` against an injected native
 * recorder would mean constructing a web one behind the consumer's back.
 */
export interface UseTrackRecorderOptions {
  /** Injecting one makes the consumer the owner: no default is built and no recovery is scanned. */
  recorder?: TrackRecorder;
  store?: StorageAdapter;
  sampling?: Partial<SamplingPolicy>;
  sensors?: SensorSource[];
}

export interface TrackRecorderBinding {
  status: TrackStatus;
  livePoint?: TrackPoint;
  track?: Track;
  /**
   * The channels of the **latest kept point**, and nothing carried over from earlier ones.
   *
   * A snapshot, not an accumulation. Each `TrackPoint.channels` is already the recorder's merge
   * result for that point, so retaining keys a later point omitted would invent a *second*
   * temporal aggregation policy — one living in React, above the one the recorder documents. A
   * consumer wanting last-known-per-key builds it from this; a consumer wanting to know a sensor
   * stopped reporting could not recover that from an accumulating version.
   */
  channels: Record<string, number>;
  start(): Promise<void>;
  pause(): void;
  resume(): void;
  markLap(label?: string): void;
  stop(): Promise<Track>;
  recovered?: Track;
  resumeRecovered(): Promise<void>;
  discardRecovered(): Promise<void>;
  error?: TrackRecorderError;
}

/**
 * The public entry point, with **exactly** the parameters `api.md` §9 publishes.
 *
 * Separate from {@link useTrackRecorderInternal} on purpose. Folding the environment seam into
 * an optional field of this signature type-checked and still leaked: the generated declaration
 * read `useTrackRecorder(options?: UseTrackRecorderOptions & UseTrackRecorderInternals)`, so a
 * consumer could pass `environment` and a conformance check built on one-way assignability could
 * not see it — extra optional parameters are assignable to a narrower type, which certifies
 * compatibility rather than conformance.
 */
export function useTrackRecorder(options: UseTrackRecorderOptions = {}): TrackRecorderBinding {
  return useTrackRecorderInternal(options, browserRecorderEnvironment);
}

/**
 * The implementation, taking its environment explicitly.
 *
 * `@internal`, and kept off the barrel: it exists so ADR-0026's ownership rules can be proven by
 * counting constructions and scans, which is a claim about calls that must *not* happen.
 */
export function useTrackRecorderInternal(
  options: UseTrackRecorderOptions,
  env: TrackRecorderHookEnvironment,
): TrackRecorderBinding {
  const { recorder: injected, store, sampling, sensors } = options;

  const [status, setStatus] = useState<TrackStatus>(injected?.status ?? "finalized");
  const [livePoint, setLivePoint] = useState<TrackPoint | undefined>(undefined);
  const [channels, setChannels] = useState<Record<string, number>>({});
  const [track, setTrack] = useState<Track | undefined>(undefined);
  const [recovered, setRecovered] = useState<Track | undefined>(undefined);
  const [error, setError] = useState<TrackRecorderError | undefined>(undefined);

  /**
   * The live recorder.
   *
   * A ref, and **never constructed in the render body**. A default recorder built during render
   * would be rebuilt whenever an options object or sensors array changed identity — which for an
   * inline `{ store }` is every render — silently replacing a recording in progress with a fresh
   * one. Construction happens in a command, where it is a decision rather than a side effect of
   * re-rendering.
   */
  const recorderRef = useRef<TrackRecorder | undefined>(undefined);
  /** Live values the subscriptions need without re-subscribing when they change. */
  const latest = useRef({ store, sampling, sensors, env });
  latest.current = { store, sampling, sensors, env };

  /** Subscribe before anything can emit, and hand back a single unsubscribe. */
  const subscribe = useCallback((target: TrackRecorder): (() => void) => {
    const offPoint = target.onPoint((point) => {
      setLivePoint(point);
      setChannels({ ...(point.channels ?? {}) });
    });
    // A later point does not clear an error: the contract is "the latest recorder error", and a
    // fix nobody performed is not something a subsequent fix would report.
    const offError = target.onError((recorderError) => {
      setError(recorderError);
    });
    return () => {
      offPoint();
      offError();
    };
  }, []);

  // An injected recorder is live from mount: its points must reach state without a `start()`
  // the consumer may already have called.
  useEffect(() => {
    if (injected === undefined) return undefined;
    recorderRef.current = injected;
    setStatus(injected.status);
    return subscribe(injected);
  }, [injected, subscribe]);

  // The recovery scan. Only when the hook owns the recorder **and** has a store (ADR-0026).
  useEffect(() => {
    if (injected !== undefined || store === undefined) {
      setRecovered(undefined);
      return undefined;
    }
    // Stale-safe: a slow scan against a replaced store, or one resolving after unmount, must not
    // publish. Without this a store swap can be overwritten by the previous store's answer.
    let live = true;
    void env.recover(store).then(
      (found) => {
        if (live) setRecovered(found);
      },
      (reason: unknown) => {
        if (live) setError(reason as TrackRecorderError);
      },
    );
    return () => {
      live = false;
    };
  }, [injected, store, env]);

  /** Unsubscribe exactly once, whatever ended the session. */
  const releaseRef = useRef<(() => void) | undefined>(undefined);
  useEffect(
    () => () => {
      releaseRef.current?.();
      releaseRef.current = undefined;
    },
    [],
  );

  /** Build a recorder, subscribe to it **before** starting, and start it. */
  const startWith = useCallback(
    async (resumeFrom?: Track): Promise<TrackRecorder> => {
      const {
        store: liveStore,
        sampling: livePolicy,
        sensors: liveSensors,
        env: liveEnv,
      } = latest.current;
      const built = liveEnv.createRecorder({
        ...(liveStore === undefined ? {} : { store: liveStore }),
        ...(livePolicy === undefined ? {} : { sampling: livePolicy }),
        ...(liveSensors === undefined ? {} : { sensors: liveSensors }),
        ...(resumeFrom === undefined ? {} : { resumeFrom }),
      });
      // Before `start`, so a point emitted during startup is not dropped on the floor.
      const release = subscribe(built);
      try {
        await built.start();
      } catch (reason) {
        release();
        throw reason;
      }
      releaseRef.current?.();
      releaseRef.current = release;
      recorderRef.current = built;
      setStatus(built.status);
      setTrack(undefined);
      return built;
    },
    [subscribe],
  );

  const requireRecorder = (operation: string): TrackRecorder => {
    const live = recorderRef.current;
    if (live === undefined) throw new Error(`useTrackRecorder: ${operation} before start()`);
    return live;
  };

  const start = useCallback(async (): Promise<void> => {
    if (injected !== undefined) {
      await injected.start(...(sampling === undefined ? [] : [sampling]));
      setStatus(injected.status);
      setTrack(undefined);
      return;
    }
    // Always fresh: `recovered` is left exactly where it was, for `resumeRecovered()` or
    // `discardRecovered()` to act on.
    await startWith();
  }, [injected, sampling, startWith]);

  const resumeRecovered = useCallback(async (): Promise<void> => {
    if (injected !== undefined) return;
    const candidate = recovered;
    if (candidate === undefined) return;
    // Cleared only after a successful start, so a construction, validation or start failure
    // leaves the candidate available to retry.
    await startWith(candidate);
    setRecovered(undefined);
  }, [injected, recovered, startWith]);

  const discardRecovered = useCallback(async (): Promise<void> => {
    if (injected !== undefined) return;
    const candidate = recovered;
    if (candidate === undefined || store === undefined) return;
    await store.deleteTrack(candidate.id);
    setRecovered(undefined);
  }, [injected, recovered, store]);

  const pause = useCallback((): void => {
    const live = requireRecorder("pause()");
    live.pause();
    setStatus(live.status);
  }, []);

  const resume = useCallback((): void => {
    const live = requireRecorder("resume()");
    live.resume();
    setStatus(live.status);
  }, []);

  const markLap = useCallback((label?: string): void => {
    requireRecorder("markLap()").markLap(label);
  }, []);

  const stop = useCallback(async (): Promise<Track> => {
    const live = requireRecorder("stop()");
    const finalized = await live.stop();
    releaseRef.current?.();
    releaseRef.current = undefined;
    setTrack(finalized);
    setStatus(live.status);
    setLivePoint(undefined);
    return finalized;
  }, []);

  return {
    status,
    ...(livePoint === undefined ? {} : { livePoint }),
    ...(track === undefined ? {} : { track }),
    channels,
    start,
    pause,
    resume,
    markLap,
    stop,
    ...(recovered === undefined ? {} : { recovered }),
    resumeRecovered,
    discardRecovered,
    ...(error === undefined ? {} : { error }),
  };
}
