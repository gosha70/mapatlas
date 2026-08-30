// SPDX-License-Identifier: Apache-2.0

/**
 * Terrarium elevation encoding, for the fixture archive (ADR-0024, criterion 5).
 *
 * Copernicus ships COG GeoTIFF, so an encode step exists whatever else is chosen; encoding it
 * ourselves is what lets the runtime depend on no third party at all. The scheme packs metres
 * into an RGB triple:
 *
 *     elevation = (R * 256 + G + B / 256) - 32768
 *
 * Two properties of that formula decide everything below. It has a **fixed offset**, so every
 * representable elevation is a real number of metres and there is no bit pattern left over to
 * mean "no data" — which is why a missing tile must fail the build rather than be filled, and
 * why a zero fill would decode to the bottom of the range rather than to nothing
 * (`specs/tasks.md` T4.6, obligation 3). And its resolution is 1/256 m, so a round trip is
 * lossy in a bounded, testable way rather than exact.
 */

/** The encoding's offset in metres: the elevation a black pixel represents. */
const OFFSET_M = 32768;
/** Metres per unit of the blue channel — the quantisation step. */
export const RESOLUTION_M = 1 / 256;
/** Inclusive bounds of what the three channels can represent, in metres. */
export const MIN_ENCODABLE_M = -OFFSET_M;
export const MAX_ENCODABLE_M = 256 * 256 - 1 + 255 + 255 / 256 - OFFSET_M;

export class TerrariumRangeError extends Error {
  /** @param {number} elevationM */
  constructor(elevationM) {
    super(
      `terrarium: ${String(elevationM)} m is outside the encodable range ` +
        `${String(MIN_ENCODABLE_M)}..${MAX_ENCODABLE_M.toFixed(4)} m`,
    );
    this.name = "TerrariumRangeError";
  }
}

/**
 * Metres to an `[r, g, b]` triple.
 *
 * Throws rather than clamping. A clamp would turn a projection or unit mistake — feet read as
 * metres, an ellipsoidal height mistaken for a geoid one — into a plausible-looking surface at
 * the range limit, which is the silent-wrong-answer shape this fixture's obligations exist to
 * refuse. There is no encoding for "absent", so there is no encoding for "out of range" either.
 *
 * @param {number} elevationM
 * @returns {[number, number, number]}
 */
export function encodeElevation(elevationM) {
  if (!Number.isFinite(elevationM)) throw new TerrariumRangeError(elevationM);
  if (elevationM < MIN_ENCODABLE_M || elevationM > MAX_ENCODABLE_M) {
    throw new TerrariumRangeError(elevationM);
  }
  // Rounded, not truncated: truncation biases every sample downward by up to a step, which
  // accumulates into a systematic offset across a whole archive rather than cancelling.
  const units = Math.round((elevationM + OFFSET_M) * 256);
  return [Math.floor(units / 65536), Math.floor(units / 256) % 256, units % 256];
}

/**
 * An `[r, g, b]` triple back to metres.
 *
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @returns {number}
 */
export function decodeElevation(r, g, b) {
  return r * 256 + g + b / 256 - OFFSET_M;
}
