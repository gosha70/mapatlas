// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import type { SensorSample, SensorSourceError } from "../sensors.js";
import { createFakeSensorSource } from "./fake-sensor.js";

const CHANNELS = [{ key: "heartRateBpm", label: "Heart rate", unit: "bpm" }];

describe("createFakeSensorSource", () => {
  it("replays its scripted samples on start", async () => {
    const samples: SensorSample[] = [];
    const source = createFakeSensorSource({
      id: "fake",
      channels: CHANNELS,
      samples: [
        { t: 1, values: { heartRateBpm: 120 } },
        { t: 2, values: { heartRateBpm: 130 } },
      ],
    });
    source.onSample((s) => samples.push(s));
    await source.start();

    expect(samples).toHaveLength(2);
    expect(samples[1]?.values).toEqual({ heartRateBpm: 130 });
  });

  it("does not replay twice when start is called again", async () => {
    const samples: SensorSample[] = [];
    const source = createFakeSensorSource({
      id: "fake",
      channels: CHANNELS,
      samples: [{ t: 1, values: { heartRateBpm: 120 } }],
    });
    source.onSample((s) => samples.push(s));
    await source.start();
    await source.start();

    expect(samples).toHaveLength(1);
  });

  it("emits on demand, so a test can drive timing itself", async () => {
    const samples: SensorSample[] = [];
    const source = createFakeSensorSource({ id: "fake", channels: CHANNELS });
    source.onSample((s) => samples.push(s));
    await source.start();

    source.emit({ t: 500, values: { heartRateBpm: 148 } });

    expect(samples).toEqual([{ t: 500, values: { heartRateBpm: 148 } }]);
  });

  it("raises errors on demand, to prove a failing sensor does not stop a recording", async () => {
    const errors: SensorSourceError[] = [];
    const source = createFakeSensorSource({ id: "fake", channels: CHANNELS });
    source.onError((e) => errors.push(e));
    await source.start();

    source.fail({ kind: "disconnected", message: "strap lost" });

    expect(errors).toEqual([{ kind: "disconnected", message: "strap lost" }]);
  });

  it("reports whether it is started", async () => {
    const source = createFakeSensorSource({ id: "fake", channels: CHANNELS });
    expect(source.started).toBe(false);
    await source.start();
    expect(source.started).toBe(true);
    await source.stop();
    expect(source.started).toBe(false);
  });
});
