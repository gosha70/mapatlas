// SPDX-License-Identifier: Apache-2.0

import type { ChannelDescriptor } from "./channels.js";
import type { SensorSample, SensorSource, SensorSourceError } from "./sensors.js";

/**
 * `createPollingSensorSource` — the neutral primitive behind "take the heart rate every N
 * seconds".
 *
 * The consumer owns the device: it supplies `read`, which may talk to Web Bluetooth, a
 * native bridge, HealthKit, or anything else. The engine owns only the cadence, the
 * validation and the lifecycle, and never learns what a channel measures.
 */
export interface PollingSensorSourceOptions {
  id: string;
  channels: ChannelDescriptor[];
  intervalMs: number;
  /** Resolve with the current values, or `undefined` when there is nothing to report. */
  read(): Promise<Record<string, number> | undefined>;
}

/**
 * The clock and timer, injected so the source is deterministic under test.
 *
 * Deliberately **not** part of {@link PollingSensorSourceOptions}: a scheduler is
 * implementation machinery, and putting it in the public contract would mean owning its
 * shape indefinitely for the benefit of nobody who actually consumes the engine.
 *
 * `now()` belongs here alongside the timer calls. Without it the ticks would be
 * deterministic while `SensorSample.t` still came from the wall clock, which is the more
 * annoying half to have wrong in a test.
 */
export interface Scheduler {
  now(): number;
  setInterval(callback: () => void, intervalMs: number): unknown;
  clearInterval(handle: unknown): void;
}

const systemScheduler: Scheduler = {
  now: () => Date.now(),
  setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
  clearInterval: (handle) => {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
};

/** Exported for tests only — not re-exported from the package barrel. */
export function createPollingSensorSourceInternal(
  options: PollingSensorSourceOptions,
  scheduler: Scheduler,
): SensorSource {
  const { id, channels, intervalMs, read } = options;

  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new RangeError(`intervalMs must be a positive, finite number of ms: ${intervalMs}`);
  }

  const declared = new Set<string>();
  for (const descriptor of channels) {
    if (declared.has(descriptor.key)) {
      throw new Error(`duplicate channel descriptor key: ${descriptor.key}`);
    }
    declared.add(descriptor.key);
  }

  const sampleListeners = new Set<(s: SensorSample) => void>();
  const errorListeners = new Set<(e: SensorSourceError) => void>();

  let handle: unknown;
  let reading = false;
  /**
   * Bumped by every `stop()`. A read already in flight when the source stops belongs to the
   * old generation, so its result is discarded rather than injected into a later session —
   * without this, `read A starts; stop(); start(); read A resolves` contaminates B.
   */
  let generation = 0;

  const fail = (kind: SensorSourceError["kind"], message: string): void => {
    for (const listener of errorListeners) listener({ kind, message });
  };

  /**
   * Reject values the declared channels cannot describe. Silently accepting `hearRate` when
   * the descriptor says `heartRate` produces telemetry nothing can chart. A read supplying
   * only *some* declared channels is fine — sensors report at their own rates.
   */
  const validate = (values: Record<string, number>): string | undefined => {
    for (const [key, value] of Object.entries(values)) {
      if (!declared.has(key)) return `undeclared channel "${key}"`;
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return `channel "${key}" is not a finite number: ${String(value)}`;
      }
    }
    return undefined;
  };

  const tick = (): void => {
    // At most one read is ever in flight. A polling interval is a desired cadence, not a
    // promise that every scheduled invocation runs: queueing a slow BLE read would build an
    // unbounded backlog of stale telemetry whose timestamps no longer resemble when it was
    // observed.
    if (reading) return;

    const startedGeneration = generation;
    reading = true;

    void Promise.resolve()
      .then(read)
      .then((values) => {
        if (startedGeneration !== generation || values === undefined) return;

        const problem = validate(values);
        if (problem !== undefined) {
          fail("read-failed", `${id}: ${problem}`);
          return;
        }

        // Stamped at completion, which is the closest moment to the observation the engine
        // actually knows. A device with authoritative sample times should implement
        // SensorSource directly rather than use this helper.
        const sample: SensorSample = { t: scheduler.now(), values: { ...values } };
        for (const listener of sampleListeners) listener(sample);
      })
      .catch((error: unknown) => {
        if (startedGeneration !== generation) return;
        fail("read-failed", `${id}: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        reading = false;
      });
  };

  return {
    id,
    channels,

    start: () => {
      // Idempotent: starting an already-running source is a no-op, not a second timer.
      if (handle === undefined) handle = scheduler.setInterval(tick, intervalMs);
      return Promise.resolve();
    },

    stop: () => {
      if (handle !== undefined) {
        scheduler.clearInterval(handle);
        handle = undefined;
      }
      // Always advance, so a read in flight is disowned even if stop() is called twice.
      generation += 1;
      return Promise.resolve();
    },

    onSample: (cb) => {
      sampleListeners.add(cb);
      return () => sampleListeners.delete(cb);
    },

    onError: (cb) => {
      errorListeners.add(cb);
      return () => errorListeners.delete(cb);
    },
  };
}

/**
 * Sample a consumer-supplied `read` on a fixed interval.
 *
 * At most one read is in flight; a tick arriving while one is still running is **skipped,
 * never queued**. A rejected read raises `onError` with kind `read-failed` and polling
 * continues — losing a heart-rate strap must not lose the trip. (ADR-0009)
 */
export function createPollingSensorSource(options: PollingSensorSourceOptions): SensorSource {
  return createPollingSensorSourceInternal(options, systemScheduler);
}
