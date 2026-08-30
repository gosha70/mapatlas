// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import {
  MAX_ENCODABLE_M,
  MIN_ENCODABLE_M,
  RESOLUTION_M,
  TerrariumRangeError,
  decodeElevation,
  encodeElevation,
} from "./terrarium.mjs";

describe("known values, synthesised by hand", () => {
  // ADR-0024 chose terrarium partly because the formula is simple enough to check this way:
  // these triples are computed from `(R * 256 + G + B / 256) - 32768` on paper, not read back
  // out of the implementation, so they would catch a transcription error in the formula itself.
  it.each([
    { rgb: [0, 0, 0], m: -32768, note: "the floor of the range" },
    { rgb: [128, 0, 0], m: 0, note: "sea level — not zero bytes, because of the offset" },
    { rgb: [128, 1, 0], m: 1, note: "one metre" },
    { rgb: [128, 0, 128], m: 0.5, note: "half a metre lives entirely in blue" },
    { rgb: [127, 255, 0], m: -1, note: "one metre below, borrowing across the boundary" },
  ])("$m m is $rgb — $note", ({ rgb, m }) => {
    expect(decodeElevation(...rgb)).toBe(m);
    expect(encodeElevation(m)).toEqual(rgb);
  });
});

describe("there is no encoding for absence", () => {
  it("decodes every triple to a finite elevation, leaving no spare bit pattern", () => {
    // The property obligation 3 rests on, asserted rather than asserted-about. Strided rather
    // than exhaustive over 2^24 so the suite stays fast; the stride is coprime with 256 so it
    // does not sample one slice of any channel.
    let checked = 0;
    for (let r = 0; r < 256; r += 7) {
      for (let g = 0; g < 256; g += 11) {
        for (let b = 0; b < 256; b += 13) {
          const m = decodeElevation(r, g, b);
          expect(Number.isFinite(m)).toBe(true);
          expect(m).toBeGreaterThanOrEqual(MIN_ENCODABLE_M);
          expect(m).toBeLessThanOrEqual(MAX_ENCODABLE_M);
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(6000);
  });

  it("reads a zero-byte fill as the bottom of the range, not as sea level", () => {
    // The specs said "a zero fill decodes as sea level" until this test was written. It does
    // not: the formula's offset puts sea level at RGB(128, 0, 0), and all-zero bytes are
    // -32768 m. Kept as a test because the wrong version is the intuitive one and would be
    // written again — and because either way the conclusion holds, which is what let the
    // wrong reason survive three documents.
    expect(decodeElevation(0, 0, 0)).toBe(-32768);
    expect(decodeElevation(128, 0, 0)).toBe(0);
    expect(decodeElevation(0, 0, 0)).not.toBe(decodeElevation(128, 0, 0));
  });
});

describe("round trips within the encoding's own resolution", () => {
  it("returns every sampled elevation to within one quantisation step", () => {
    for (let m = -500; m <= 9000; m += 37.3) {
      const back = decodeElevation(...encodeElevation(m));
      expect(Math.abs(back - m)).toBeLessThanOrEqual(RESOLUTION_M / 2);
    }
  });

  it("rounds rather than truncates, so error cancels instead of accumulating", () => {
    // 0.003 m sits just past half a step. Truncation would put it at RGB(128, 0, 0) and bias
    // every sample in the archive downward by up to a step — a systematic offset in the
    // surface, not noise.
    expect(encodeElevation(0.003)).toEqual([128, 0, 1]);
    expect(encodeElevation(0.001)).toEqual([128, 0, 0]);
  });
});

describe("out of range fails rather than clamps", () => {
  it.each([
    { value: MIN_ENCODABLE_M - 1, note: "below the floor" },
    { value: MAX_ENCODABLE_M + 1, note: "above the ceiling" },
    { value: Number.NaN, note: "not a number" },
    { value: Number.POSITIVE_INFINITY, note: "infinite" },
  ])("refuses $value — $note", ({ value }) => {
    // Clamping would turn a unit or datum mistake — feet read as metres, an ellipsoidal height
    // taken for a geoid one — into a plausible surface pinned at the range limit. That is the
    // silent-wrong-answer shape this fixture's obligations exist to refuse, so the encoder has
    // no clamp to relax, exactly as the encoder has no fill path.
    expect(() => encodeElevation(value)).toThrow(TerrariumRangeError);
  });

  it("accepts both ends of the range it advertises", () => {
    expect(() => encodeElevation(MIN_ENCODABLE_M)).not.toThrow();
    expect(() => encodeElevation(MAX_ENCODABLE_M)).not.toThrow();
  });
});
