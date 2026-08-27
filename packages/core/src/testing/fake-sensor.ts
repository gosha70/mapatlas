// SPDX-License-Identifier: Apache-2.0

import type { ChannelDescriptor } from "../channels.js";
import type { SensorSample, SensorSource, SensorSourceError } from "../sensors.js";

/**
 * A {@link SensorSource} driven by a script, so the channel path can be exercised without
 * hardware.
 *
 * It lives on the testing entry point beside `createMemoryStorageAdapter`, for the same
 * reason: a first-party fake for a seam is worth shipping, but it is not production API.
 */
export interface FakeSensorSourceOptions {
  id: string;
  channels: ChannelDescriptor[];
  /** Replayed in order on `start()`. */
  samples?: SensorSample[];
}

export interface FakeSensorSource extends SensorSource {
  /** Emit a sample on demand, for a test that wants to drive timing itself. */
  emit(sample: SensorSample): void;
  /** Raise an error on demand, to prove a failing sensor does not stop a recording. */
  fail(error: SensorSourceError): void;
  readonly started: boolean;
}

export function createFakeSensorSource(options: FakeSensorSourceOptions): FakeSensorSource {
  const { id, channels, samples = [] } = options;

  const sampleListeners = new Set<(s: SensorSample) => void>();
  const errorListeners = new Set<(e: SensorSourceError) => void>();
  let started = false;

  const emit = (sample: SensorSample): void => {
    for (const listener of sampleListeners) listener(sample);
  };

  return {
    id,
    channels,

    get started() {
      return started;
    },

    start: () => {
      if (!started) {
        started = true;
        for (const sample of samples) emit(sample);
      }
      return Promise.resolve();
    },

    stop: () => {
      started = false;
      return Promise.resolve();
    },

    emit,

    fail: (error) => {
      for (const listener of errorListeners) listener(error);
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
