// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { createPollingSensorSource } from "./sensors-polling.js";
import type { SensorSample } from "./sensors.js";

/**
 * The public factory, on the real clock and real timers.
 *
 * Everything about the polling *logic* is covered deterministically through the injected
 * scheduler; this exists solely to prove the default wiring — `Date.now`, `setInterval`,
 * `clearInterval` — is actually connected, which an injected scheduler can never show.
 */
describe("createPollingSensorSource on the system scheduler", () => {
  it("polls, stamps from the real clock, and stops", async () => {
    const samples: SensorSample[] = [];
    const before = Date.now();

    const source = createPollingSensorSource({
      id: "system",
      channels: [{ key: "n", label: "N", unit: "" }],
      intervalMs: 5,
      read: () => Promise.resolve({ n: 1 }),
    });
    source.onSample((s) => samples.push(s));

    await source.start();
    await new Promise((resolve) => setTimeout(resolve, 60));
    await source.stop();

    const collected = samples.length;
    expect(collected).toBeGreaterThan(0);
    expect(samples[0]?.t).toBeGreaterThanOrEqual(before);
    expect(samples[0]?.values).toEqual({ n: 1 });

    // stop() really cleared the interval: nothing arrives afterwards.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(samples.length).toBe(collected);
  });
});
