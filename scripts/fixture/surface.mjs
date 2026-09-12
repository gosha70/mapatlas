// SPDX-License-Identifier: Apache-2.0

/**
 * The logical source surface: many per-cell crops, one continuous sample lattice (T4.6).
 *
 * **Why this exists.** An output pixel near 7°E has a bilinear stencil that straddles two source
 * cells — two of its four samples come from `N45E006` and two from `N45E007`. Anything that
 * picks a cell first and interpolates inside it must then clamp or fail at the boundary, which
 * is the shape the edge rule forbids. So the cells are joined into one grid *before* anything
 * samples it, and `resample.mjs` never learns that source cells exist.
 *
 * **The cells abut; they do not overlap.** Measured on the release rather than assumed: GLO-30
 * ships 3600×3600 samples per 1° cell, so `N45E006`'s easternmost sample is at 6.99972222° and
 * `N45E007`'s westernmost is at 7.0° — exactly one spacing apart, continuing the same global
 * lattice. There is therefore no duplicated boundary sample to arbitrate between, and no
 * ownership rule is needed *here*: `cropWindow`'s half-open edges already gave each sample to
 * exactly one crop. What remains is the harder half — the two lattices must **interleave**, and
 * an off-by-one at the join produces a surface that is continuous, plausible and wrong.
 *
 * That is why alignment is asserted on the global lattice rather than trusted: every crop's
 * origin must sit an integer number of samples from every other's, and every cell of the result
 * must be written exactly once. A gap and a double-write are both detected by the same pass.
 */

import { decodeGrid } from "./resample.mjs";

/** How far a crop origin may sit from the global lattice, in samples, before it is misaligned. */
export const LATTICE_EPSILON_SAMPLES = 1e-6;

export class SurfaceError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "SurfaceError";
  }
}

/**
 * Where every crop was actually placed, and which pairs of them overlap.
 *
 * **Appended to the failure because four identical sentences taught nothing** (T8.1 increment 1,
 * issue #30). The counting pass says a union was double-written and by how much; it cannot say
 * *which* crop landed where, so each occurrence has had the arithmetic reconstructed by hand — from
 * the union's dimensions, the crops' known sizes, and a guess at which one moved. All of that is in
 * scope right here, at the throw.
 *
 * **Pairs are computed, not enumerated.** Reporting every pair as overlapping would be right
 * whenever exactly two crops are joined and wrong the moment there are three, and it would make the
 * report unable to distinguish the crop that moved from the one it landed on. A pair is listed only
 * when its rectangles genuinely intersect, and the intersection is named.
 *
 * Crops carry no tile id at this seam — `readTile` returns a grid, not a labelled cell — so a crop
 * is identified by its index in the array it was supplied in, which is `sourceCells` order, and by
 * its origin, which is what makes it recognisable. Numbers are printed at full round-trip
 * precision: the failure this exists for turns on an origin being wrong by a few samples, and a
 * rounded coordinate would hide exactly that.
 *
 * @param {{ crop: { west: number, north: number, width: number, height: number }, col: number,
 *   row: number }[]} placed
 * @param {number} minCol
 * @param {number} minRow
 * @returns {string}
 */
function placementReport(placed, minCol, minRow) {
  const at = (p) => ({ col: p.col - minCol, row: p.row - minRow });
  const lines = placed.map((p, index) => {
    const { col, row } = at(p);
    return (
      `  [${String(index)}] ${String(p.crop.width)}x${String(p.crop.height)} at ` +
      `col ${String(col)}..${String(col + p.crop.width - 1)}, ` +
      `row ${String(row)}..${String(row + p.crop.height - 1)}, ` +
      `origin (${String(p.crop.west)}, ${String(p.crop.north)})`
    );
  });

  const pairs = [];
  for (let i = 0; i < placed.length; i += 1) {
    for (let j = i + 1; j < placed.length; j += 1) {
      const a = at(placed[i]);
      const b = at(placed[j]);
      const colFrom = Math.max(a.col, b.col);
      const colTo = Math.min(a.col + placed[i].crop.width, b.col + placed[j].crop.width) - 1;
      const rowFrom = Math.max(a.row, b.row);
      const rowTo = Math.min(a.row + placed[i].crop.height, b.row + placed[j].crop.height) - 1;
      if (colFrom > colTo || rowFrom > rowTo) continue;
      pairs.push(
        `  [${String(i)}] and [${String(j)}] overlap over ` +
          `col ${String(colFrom)}..${String(colTo)}, row ${String(rowFrom)}..${String(rowTo)}`,
      );
    }
  }

  return [
    "",
    "",
    "crops as placed (columns and rows relative to the union's origin):",
    ...lines,
    "",
    // A gap with no overlap is a real outcome — a hole rather than a double-write — and saying so
    // is more useful than an empty heading a reader has to interpret.
    pairs.length === 0 ? "no two crops overlap; the union is not covered" : "overlapping pairs:",
    ...pairs,
  ].join("\n");
}

/**
 * Join per-cell crops into one decoded elevation grid.
 *
 * @param {Array<{ width: number, height: number, west: number, north: number, pixelScaleDeg: number, rgb: Uint8Array }>} crops
 * @returns {import("./resample.mjs").ElevationGrid}
 */
export function stitchSurface(crops) {
  if (!Array.isArray(crops) || crops.length === 0) {
    throw new SurfaceError("cannot build a source surface from no crops");
  }
  const scale = crops[0].pixelScaleDeg;
  for (const crop of crops) {
    if (crop.pixelScaleDeg !== scale) {
      throw new SurfaceError(
        `crops disagree on sample spacing: ${String(scale)} and ${String(crop.pixelScaleDeg)}`,
      );
    }
  }

  // Positions on the global lattice, measured from the first crop's origin. Integers, or the
  // crops are sampling different grids and joining them would interleave two surfaces that
  // never line up — a defect that renders as a continuous, plausible, wrong terrain.
  const origin = crops[0];
  const placed = crops.map((crop) => {
    const dx = (crop.west - origin.west) / scale;
    const dy = (origin.north - crop.north) / scale;
    for (const [axis, value] of [
      ["west", dx],
      ["north", dy],
    ]) {
      if (Math.abs(value - Math.round(value)) > LATTICE_EPSILON_SAMPLES) {
        throw new SurfaceError(
          `crop at (${String(crop.west)}, ${String(crop.north)}) sits ${value.toFixed(6)} samples ` +
            `from the lattice on ${axis}; crops must share one global sample grid`,
        );
      }
    }
    return { crop, col: Math.round(dx), row: Math.round(dy) };
  });

  const minCol = Math.min(...placed.map((p) => p.col));
  const minRow = Math.min(...placed.map((p) => p.row));
  const maxCol = Math.max(...placed.map((p) => p.col + p.crop.width));
  const maxRow = Math.max(...placed.map((p) => p.row + p.crop.height));
  const width = maxCol - minCol;
  const height = maxRow - minRow;

  const elevationsM = new Float32Array(width * height);
  // One pass detects both failures the join can have: a cell nobody wrote is a gap, a cell
  // written twice is an overlap. Counting rather than flagging, so the error can say which.
  const writes = new Uint8Array(width * height);

  for (const { crop, col, row } of placed) {
    const decoded = decodeGrid(crop);
    for (let r = 0; r < crop.height; r += 1) {
      const target = (row - minRow + r) * width + (col - minCol);
      elevationsM.set(decoded.elevationsM.subarray(r * crop.width, (r + 1) * crop.width), target);
      for (let c = 0; c < crop.width; c += 1) writes[target + c] += 1;
    }
  }

  let gaps = 0;
  let overlaps = 0;
  for (const count of writes) {
    if (count === 0) gaps += 1;
    else if (count > 1) overlaps += 1;
  }
  if (gaps > 0 || overlaps > 0) {
    throw new SurfaceError(
      // **This first line is preserved byte for byte** (T8.1 increment 1). Four occurrences of the
      // intermittent failure in issue #30 were matched to each other by exactly this sentence, and
      // improving it would orphan that history and every search built on it. Everything the
      // diagnosis needs is **appended** below it instead.
      `the crops do not tile their union: ${String(gaps)} sample(s) covered by none and ` +
        `${String(overlaps)} by more than one, over ${String(width)}x${String(height)}` +
        placementReport(placed, minCol, minRow),
    );
  }

  return {
    width,
    height,
    west: origin.west + minCol * scale,
    north: origin.north - minRow * scale,
    pixelScaleDeg: scale,
    elevationsM,
  };
}
