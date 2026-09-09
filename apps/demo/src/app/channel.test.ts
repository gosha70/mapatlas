// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { DEMO_CHANNEL, cadenceAt, createDemoChannel } from "./channel.js";

/**
 * The fake channel's two required properties, asserted separately because they pull apart.
 *
 * A round-trip scenario compares a chart rendered before an export with the chart rendered after
 * re-importing it. That needs the values to be **deterministic**, or a flake reads as a fidelity
 * defect in the round trip. It also needs them to be **regenerable from nothing else in the
 * document**, or the second chart could be reproduced from a file that dropped every channel array
 * and the comparison would pass for a reason unrelated to channels.
 *
 * `Math.random()` has the second and not the first. Anything derived from position, speed or the
 * clock has the first and not the second. Only a seeded sequence has both, and the two tests below
 * are one for each.
 */

describe("the demo's fake cadence channel", () => {
  it("produces the same values for the same ticks, however often it is asked", () => {
    // Determinism. Two runs of a scenario that compares a chart before an export with the chart
    // after re-importing it must be reading the same numbers, or a flake reads as a fidelity
    // defect in the round trip.
    expect([0, 1, 2, 3, 4].map(cadenceAt)).toStrictEqual([60, 66, 72, 78, 84]);
    expect([0, 1, 2, 3, 4].map(cadenceAt)).toStrictEqual([60, 66, 72, 78, 84]);
  });

  it("takes the tick and nothing else, so no other field can regenerate it", () => {
    /**
     * **Non-regenerability is a property of the signature, and this test says so rather than
     * pretending to falsify it.** If the value were a function of time or of where the trip went,
     * the exported document could reproduce it — and a chart could be reproduced from a file that
     * carried no channel data at all, passing a round-trip test for a reason unrelated to
     * channels. `cadenceAt` takes a tick; there is no clock and no position to reach for.
     *
     * What can be checked here is that the value does not move on its own between calls separated
     * by real elapsed time, which is the observable half. The half that matters — that a document
     * stripped of its channel arrays cannot reproduce the chart — is a **browser** mutation, and
     * it is required by the plan for exactly that reason.
     */
    const first = cadenceAt(3);
    const delay = Date.now() + 2;
    while (Date.now() < delay) {
      /* let the clock move, so a clock-derived value would have to change */
    }

    expect(cadenceAt(3)).toBe(first);
  });

  it("stays inside the bounds the descriptor declares", () => {
    // Display bounds only — the engine never rejects a sample against them (`ChannelDescriptor`),
    // so keeping inside them is this consumer's choice about what looks like an instrument rather
    // than a rule anything enforces. A value outside would chart as a line clipped at an edge.
    const values = Array.from({ length: 50 }, (_, tick) => cadenceAt(tick));

    expect(Math.min(...values)).toBeGreaterThanOrEqual(DEMO_CHANNEL.min ?? -Infinity);
    expect(Math.max(...values)).toBeLessThanOrEqual(DEMO_CHANNEL.max ?? Infinity);
  });

  it("keeps producing values rather than emitting one and stopping", async () => {
    /**
     * **The "not one-shot" claim, owned here because here it is deterministic.**
     *
     * The browser lane cannot make it: a point carries a channel exactly when a sample landed in
     * the window since the previous kept point, and under load both the sampling and the number of
     * kept fixes vary — a healthy run can legitimately store a value on one point. So the browser
     * asserts that a sample reached storage at all, and *this* asserts that the source is not a
     * one-shot, by driving the read the source is built from and taking the values in order.
     */
    const values: number[] = [];
    const source = createDemoChannel(0);
    const unsubscribe = source.onSample((sample) => {
      const value = sample.values[DEMO_CHANNEL.key];
      if (value !== undefined) values.push(value);
    });
    await source.start();
    // Six intervals of the source's own cadence, with room for the reads to settle.
    await new Promise((settle) => setTimeout(settle, 700));
    await source.stop();
    unsubscribe();

    expect(values.length, "the source emitted once and stopped").toBeGreaterThan(2);
    // Deterministic *and* moving: a constant would be reproducible and would chart as a flat line
    // that any dropped-channel document could reproduce by accident.
    expect(new Set(values).size, "every sample carried the same value").toBeGreaterThan(1);
    expect(values, "the values are not the sequence, in order").toStrictEqual(
      values.map((_, index) => cadenceAt(index)),
    );
  });

  it("repeats, so a long recording keeps producing samples", () => {
    // A sequence that ran out would leave later points unsampled, and `chartable()` would still
    // find the channel — a chart with a gap nobody declared.
    expect(cadenceAt(7)).toBe(cadenceAt(0));
    expect(cadenceAt(100)).toBe(cadenceAt(100 % 7));
  });

  it("declares the channel it samples, by the same key", () => {
    // `chartable()` starts from the descriptors and keeps only those something sampled (ADR-0029),
    // so a descriptor whose key does not match the samples renders nothing at all — a failure that
    // looks exactly like a sensor that never started.
    const source = createDemoChannel();

    expect(source.channels).toStrictEqual([DEMO_CHANNEL]);
    expect(source.channels[0]?.key).toBe("cadence");
  });
});
