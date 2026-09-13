// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { cropTrace, observeCrop, traceReport } from "./crop-trace.mjs";
import { stitchSurface } from "./surface.mjs";
import { encodeElevation } from "./terrarium.mjs";

const SCALE = 1 / 3600;

/** A crop carrying a real payload, so `payloadBytes` is a witness rather than a copied field. */
function crop({ west, north, width, height }) {
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i += 1) {
    const [r, g, b] = encodeElevation(3000);
    rgb[i * 3] = r;
    rgb[i * 3 + 1] = g;
    rgb[i * 3 + 2] = b;
  }
  return { width, height, west, north, pixelScaleDeg: SCALE, rgb };
}

describe("an observation is a copy, not a view", () => {
  /**
   * **The property the whole instrument rests on**, and the one the failure needs: the crop in
   * issue #30 arrives at `stitchSurface` with an origin that cannot belong to its own width, and
   * reading it again at the throw cannot say whether it was ever anything else. So a snapshot
   * taken earlier has to survive a later write to the same field — otherwise both lines of the
   * report would show the final value and agree with each other about nothing.
   */
  it("keeps the construction value after the origin is overwritten", () => {
    const c = crop({ west: 6.987222222222222, north: 45.5, width: 46, height: 113 });

    observeCrop(c, "construction", { tileId: "N45E006", col0: 25154 });
    c.west = 7;
    observeCrop(c, "stitchSurface entry", { index: 0 });

    const trace = cropTrace(c);
    expect(trace).toHaveLength(2);
    expect(trace[0]).toMatchObject({ stage: "construction", west: 6.987222222222222, width: 46 });
    expect(trace[1]).toMatchObject({ stage: "stitchSurface entry", west: 7, width: 46 });
  });

  it("shows both values in the report, and names where they first differ", () => {
    const c = crop({ west: 6.987222222222222, north: 45.5, width: 46, height: 113 });
    observeCrop(c, "construction", {
      tileId: "N45E006",
      clippedTo: [6.98, 45.4, 7, 45.5],
      col0: 25154,
    });
    observeCrop(c, "after readTile", { tileId: "N45E006" });
    c.west = 7;
    observeCrop(c, "stitchSurface entry", { index: 0 });

    const report = traceReport([c]);

    expect(report).toContain(
      "tileId N45E006, clippedTo [6.98, 45.4, 7, 45.5], col0 25154, 46x113, " +
        "origin (6.987222222222222, 45.5)",
    );
    expect(report).toContain("stitchSurface entry: index 0, 46x113, origin (7, 45.5)");
    expect(report).toContain(
      'first divergence between "after readTile" and "stitchSurface entry": ' +
        "west 6.987222222222222 -> 7",
    );
  });

  /**
   * The other direction, and not a formality: a report that announced a divergence whenever it
   * had more than one snapshot would "find" one in every failure, including the ones where the
   * crop was wrong from the moment it was built — which is the hypothesis this has to be able to
   * leave standing.
   */
  it("says plainly when nothing changed between observations", () => {
    const c = crop({ west: 7, north: 45.5, width: 8, height: 8 });
    observeCrop(c, "construction", { tileId: "N45E007" });
    observeCrop(c, "stitchSurface entry", { index: 1 });

    expect(traceReport([c])).toContain("no field changed between observations");
  });

  /**
   * The same independence, for what the *caller* supplied rather than what the crop held. The
   * clipped bounds arrive as an array, and an array held by reference would be rewritten by
   * whoever reuses it — so the observation would report the bounds of some later call as though
   * they were the ones this crop was cut to.
   */
  it("copies a bounds array, so mutating the caller's array cannot rewrite the record", () => {
    const c = crop({ west: 7, north: 45.5, width: 4, height: 4 });
    const clippedTo = [7, 45.4, 7.01, 45.5];

    observeCrop(c, "construction", { tileId: "N45E007", clippedTo });
    clippedTo[0] = -999;

    expect(cropTrace(c)[0].clippedTo).toStrictEqual([7, 45.4, 7.01, 45.5]);
    expect(traceReport([c])).toContain("clippedTo [7, 45.4, 7.01, 45.5]");
  });

  it("compares the payload's length, so a width that changed alone is still caught", () => {
    const c = crop({ west: 7, north: 45.5, width: 8, height: 8 });
    observeCrop(c, "construction", {});
    c.width = 9;
    observeCrop(c, "stitchSurface entry", {});

    expect(traceReport([c])).toContain("width 8 -> 9");
    expect(cropTrace(c)[1].payloadBytes).toBe(192);
  });
});

describe("the instrument does not change what it watches", () => {
  it("leaves the crop's identity, shape and extensibility alone", () => {
    const c = crop({ west: 7, north: 45.5, width: 4, height: 4 });
    const before = { ...c };
    const keys = Object.keys(c);

    observeCrop(c, "construction", { tileId: "N45E007" });

    expect(Object.keys(c)).toStrictEqual(keys);
    expect(Object.isFrozen(c)).toBe(false);
    expect(Object.isSealed(c)).toBe(false);
    expect(Object.isExtensible(c)).toBe(true);
    for (const key of keys) expect(c[key]).toBe(before[key]);
  });

  it("returns nothing, so it cannot be wired in as something that replaces a crop", () => {
    const c = crop({ west: 7, north: 45.5, width: 4, height: 4 });
    expect(observeCrop(c, "construction", {})).toBeUndefined();
  });

  it("ignores a value that is not an object rather than throwing into the build", () => {
    expect(() => {
      observeCrop(undefined, "construction", {});
      observeCrop(7, "construction", {});
    }).not.toThrow();
    expect(cropTrace(undefined)).toStrictEqual([]);
  });
});

describe("what the report does with what it does not have", () => {
  /**
   * A crop nothing observed is listed, not skipped. The instrument reaches two construction sites
   * and one of each downstream stage; a crop built anywhere else would otherwise leave a silent
   * gap that reads exactly like a stage that ran and found nothing.
   */
  it("names a crop with no observations instead of omitting it", () => {
    const seen = crop({ west: 7, north: 45.5, width: 4, height: 4 });
    const unseen = crop({ west: 7, north: 45.5, width: 4, height: 4 });
    observeCrop(seen, "construction", {});

    const report = traceReport([seen, unseen]);

    expect(report).toContain("[1] no observations recorded");
  });

  /**
   * **Silence is not evidence.** If reading a field threw and the instrument said nothing, the
   * missing line would be indistinguishable from a stage that was never reached, and a reader
   * would conclude something about the build from a hole the instrument dug.
   */
  it("records a field it could not read rather than dropping the observation", () => {
    const hostile = {
      width: 4,
      height: 4,
      north: 45.5,
      pixelScaleDeg: SCALE,
      rgb: new Uint8Array(48),
      get west() {
        throw new Error("west is unreadable");
      },
    };

    expect(() => observeCrop(hostile, "construction", {})).not.toThrow();
    expect(traceReport([hostile])).toContain("could not be read — west is unreadable");
  });

  /**
   * **And it does not then claim the fields held still.** `firstDivergence` steps over any pair
   * involving an observation it could not read, so a trace that failed to read reaches the end
   * having compared nothing. Printing "no field changed between observations" there would put a
   * claim the instrument never checked directly beneath the line admitting it could not look —
   * two lines that cannot both be true, in the report a reader would be reasoning from.
   */
  it("does not report stability across an observation it could not read", () => {
    const good = crop({ west: 7, north: 45.5, width: 4, height: 4 });
    const hostile = {
      ...good,
      get west() {
        throw new Error("west is unreadable");
      },
    };
    observeCrop(hostile, "construction", {});
    observeCrop(hostile, "after readTile", {});

    const report = traceReport([hostile]);

    expect(report).toContain(
      "comparison unavailable across 2 observation(s) that could not be read",
    );
    expect(report).not.toContain("no field changed between observations");
  });
});

describe("the trace is appended to the failure, not substituted for it", () => {
  /** Two crops sharing an origin: the shape issue #30 reports, reproduced deliberately. */
  function stackedOnOneOrigin() {
    const wide = crop({ west: 7, north: 45.5, width: 6, height: 4 });
    const narrow = crop({ west: 7, north: 45.5, width: 4, height: 4 });
    observeCrop(wide, "construction", { tileId: "N45E006", col0: 25154 });
    observeCrop(narrow, "construction", { tileId: "N45E007", col0: 25200 });
    return [wide, narrow];
  }

  const messageOf = (crops) => {
    try {
      stitchSurface(crops);
    } catch (error) {
      return error.message;
    }
    throw new Error("stitchSurface did not refuse crops that overlap");
  };

  /** The identity of the failure, unchanged by anything appended after it. */
  it("keeps the signature line byte for byte", () => {
    const [first] = messageOf(stackedOnOneOrigin()).split("\n");
    expect(first).toBe(
      "the crops do not tile their union: 0 sample(s) covered by none and 16 by more than one, " +
        "over 6x4",
    );
  });

  it("keeps the placement report, and puts the trace after it", () => {
    const message = messageOf(stackedOnOneOrigin());
    const placement = message.indexOf("crops as placed");
    const trace = message.indexOf("what each crop held at each point it was observed");
    expect(placement).toBeGreaterThan(0);
    expect(trace).toBeGreaterThan(placement);
  });

  /**
   * The stage `stitchSurface` adds itself. Without it the trace would end wherever the last
   * upstream observation happened, and the value the failing comparison actually read would be
   * the one value never recorded.
   */
  it("records every crop on the way in, under the index the placement report uses", () => {
    const message = messageOf(stackedOnOneOrigin());
    expect(message).toContain("stitchSurface entry: index 0, 6x4, origin (7, 45.5)");
    expect(message).toContain("stitchSurface entry: index 1, 4x4, origin (7, 45.5)");
  });

  /**
   * And it says what a divergence is worth. Locating the first point at which the observed value
   * differed is a position; it does not distinguish a write to the object from a read that
   * returned something else, and a report that let a reader believe otherwise would be worse than
   * one that reported nothing.
   */
  it("states that a divergence is a position rather than a mechanism", () => {
    expect(messageOf(stackedOnOneOrigin())).toContain(
      "which is a position and not a mechanism — it does not distinguish a write to the",
    );
  });
});
