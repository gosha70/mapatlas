// SPDX-License-Identifier: Apache-2.0

import type { ChannelDescriptor } from "./channels.js";

export interface SensorSample {
  t: number;
  /** Channel key to value. Keys are consumer-defined; the engine never interprets them. */
  values: Record<string, number>;
}

export interface SensorSourceError {
  kind: "unsupported" | "permission-denied" | "disconnected" | "read-failed";
  message: string;
}

/**
 * Non-GPS telemetry: heart rate, cadence, power, temperature, water depth.
 *
 * The engine ships the interface, a polling adapter and a fake — **never a device driver**.
 * A consumer owns the device; the engine owns the cadence and the merge. A sensor failure
 * raises `onError` and never aborts a recording: losing a heart-rate strap must not lose
 * the trip. (ADR-0009)
 */
export interface SensorSource {
  readonly id: string;
  readonly channels: ChannelDescriptor[];
  start(): Promise<void>;
  stop(): Promise<void>;
  onSample(cb: (s: SensorSample) => void): () => void;
  onError(cb: (e: SensorSourceError) => void): () => void;
}

export interface SensorMergePolicy {
  /** A sample older than this is not merged into a point. */
  maxAgeMs: number;
  /** How to combine samples that arrived since the previous kept point. */
  reduce: "last" | "avg" | "max" | "min";
}
