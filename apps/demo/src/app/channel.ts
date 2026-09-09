// SPDX-License-Identifier: Apache-2.0

/**
 * The demo's fake telemetry channel — T7.1c increment 1.
 *
 * **A `SensorSource` is the seam, and this is a consumer's implementation of it.** Nothing under
 * `packages/` knows this exists: `useTrackRecorder` takes `sensors`, `createPollingSensorSource`
 * turns a `read` into a source, and the engine merges whatever the source reports onto the points
 * it keeps. Swapping this for a real heart-rate strap is one constructor call in
 * `loop.tsx` — which is the claim `PRD.md` §6 makes about `SensorSource`, and the reason the demo
 * uses the published factory rather than hand-rolling a source.
 *
 * **Why the values are a seeded sequence, and why that is two requirements rather than one.**
 *
 * *Nothing else in the document may be able to regenerate them.* A channel whose value is derived
 * from position, speed or the clock is a function of data the exported track already carries — so
 * a round-trip test could reproduce the chart perfectly from a document that dropped every channel
 * array, and would pass for a reason that has nothing to do with channels. These values are
 * independent of where the trip went and when.
 *
 * *And a run must reproduce.* `Math.random()` satisfies the first requirement and destroys the
 * second: a scenario comparing a chart before an export with the chart after it needs both renders
 * to come from the same numbers, and a flake here would look exactly like a fidelity defect in the
 * round trip. A counter-driven sequence is deterministic per recording and independent of
 * everything else in the track.
 */

import { createPollingSensorSource } from "@mapatlas/core";
import type { ChannelDescriptor, SensorSource } from "@mapatlas/core";

/**
 * The channel this demo declares.
 *
 * `label`, `unit` and `precision` are rendered verbatim by `TripReview` — the engine never derives
 * any of them, because doing so would be learning what the number means (ADR-0009). They are a
 * consumer's words, which is what makes this the right place for them.
 */
export const DEMO_CHANNEL: ChannelDescriptor = {
  key: "cadence",
  label: "Cadence",
  unit: "rpm",
  min: 40,
  max: 110,
  precision: 0,
};

/**
 * How often the fake instrument reports.
 *
 * Fast enough that a short demo trip carries several samples, and no faster: the cadence is a
 * property of the instrument, not a knob a test tunes. **Nothing asserts a sample per point.**
 * `createPollingSensorSource.start()` schedules an interval and does not read at zero, and
 * `recorder.ts` drains the pending samples at each kept point, so a point carries a value exactly
 * when one arrived in the window since the previous one — which the engine permits to be none
 * (ADR-0009, and `PRD.md` §6 as corrected on 2026-09-09).
 */
const INTERVAL_MS = 100;

/**
 * A bounded, repeating sequence — deterministic, and a function of nothing but its own position.
 *
 * Bounded within the descriptor's declared `min`/`max` so the chart is a shape rather than a line
 * clipped at an edge; those bounds are display-only and the engine never rejects a sample against
 * them, so keeping inside them is this consumer's choice about what looks like an instrument.
 */
export function cadenceAt(tick: number): number {
  const span = 7; // coprime with nothing in particular: a short, obviously periodic walk
  const step = tick % span;
  return 60 + step * 6;
}

/**
 * Build the source.
 *
 * @param from the tick to start at, so a test can pin the sequence it will assert on. The demo
 *   itself always starts at zero — a recording's samples are read in order from the first.
 */
export function createDemoChannel(from = 0): SensorSource {
  let tick = from;
  return createPollingSensorSource({
    id: "demo-cadence",
    channels: [DEMO_CHANNEL],
    intervalMs: INTERVAL_MS,
    read: async () => {
      const value = cadenceAt(tick);
      tick += 1;
      return Promise.resolve({ [DEMO_CHANNEL.key]: value });
    },
  });
}
