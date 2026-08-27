// SPDX-License-Identifier: Apache-2.0

/**
 * A named numeric telemetry stream carried per track point. Keys are consumer-defined
 * ("heartRateBpm", "cadenceRpm", "depthM", "waterTempC"); the engine never interprets them.
 */
export interface ChannelDescriptor {
  /** Matches a key in {@link TrackPoint.channels}. */
  key: string;
  /** Rendered verbatim; the consumer owns the wording. */
  label: string;
  /** Rendered verbatim ("bpm", "rpm", "m", "°C"). */
  unit: string;
  /** Display bounds only — never used to reject samples. */
  min?: number;
  max?: number;
  /** Roll-up used by computeStats. Defaults to "avg". */
  aggregate?: ChannelAggregate;
  /** Decimal places for display. */
  precision?: number;
}

export type ChannelAggregate = "avg" | "sum" | "min" | "max" | "last";

/** Per-channel roll-up over a track or lap. */
export interface ChannelStats {
  min: number;
  max: number;
  avg: number;
  sum: number;
  last?: number;
  count: number;
}
