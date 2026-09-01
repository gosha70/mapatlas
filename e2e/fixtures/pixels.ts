// SPDX-License-Identifier: Apache-2.0

import { inflateSync } from "node:zlib";

/**
 * Reading captures as pixels, so a differential can state a set relation instead of "these
 * screenshots differ".
 *
 * Two whole-image hashes can only say *that* something changed. The pause proof needs to say
 * *where* and *which ink*: that the pixels the two-segment render draws are the union of what
 * each segment draws alone, and that nothing new appears in the gap between them. That is set
 * algebra over masks, and masks need decoded pixels.
 *
 * Decoded here rather than with a dependency, for the same reason the fixture's PNG writer is
 * hand-rolled: Playwright's captures are one narrow shape — 8-bit, non-interlaced, truecolour
 * with or without alpha — and everything outside it is rejected rather than guessed at.
 */

export interface Raster {
  readonly width: number;
  readonly height: number;
  /** RGBA, four bytes per pixel, row-major. */
  readonly data: Uint8Array;
}

export class PngDecodeError extends Error {
  constructor(message: string) {
    super(`png: ${message}`);
    this.name = "PngDecodeError";
  }
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Decode a PNG capture to RGBA.
 *
 * Refuses anything it was not written for. A decoder that guessed at a bit depth or an
 * interlace scheme would return a plausible raster from the wrong bytes, and every assertion
 * built on it would be about noise — the exact failure this file exists to make impossible.
 */
export function decodePng(bytes: Buffer): Raster {
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(SIGNATURE)) {
    throw new PngDecodeError("not a PNG");
  }

  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Buffer[] = [];

  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length; // length + type + body + crc

    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const depth = body[8];
      const colourType = body[9];
      const interlace = body[12];
      if (depth !== 8) throw new PngDecodeError(`bit depth ${String(depth)} is not 8`);
      if (interlace !== 0) throw new PngDecodeError("interlaced captures are not supported");
      if (colourType === 2) channels = 3;
      else if (colourType === 6) channels = 4;
      else throw new PngDecodeError(`colour type ${String(colourType)} is not truecolour`);
    } else if (type === "IDAT") {
      // Concatenated before inflating: the compressed stream is split across chunks at
      // arbitrary points, so inflating each one separately fails on the second.
      idat.push(Buffer.from(body));
    } else if (type === "IEND") {
      break;
    }
  }

  if (width === 0 || height === 0) throw new PngDecodeError("no IHDR, or an empty image");
  if (idat.length === 0) throw new PngDecodeError("no image data");

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) {
    throw new PngDecodeError(
      `image data is ${String(raw.length)} bytes, short of the ` +
        `${String((stride + 1) * height)} a ${String(width)}×${String(height)} image needs`,
    );
  }

  const out = new Uint8Array(width * height * 4);
  const line = new Uint8Array(stride);
  const previous = new Uint8Array(stride);

  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const source = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i += 1) {
      const x = source[i] ?? 0;
      const a = i >= channels ? (line[i - channels] ?? 0) : 0;
      const b = previous[i] ?? 0;
      const c = i >= channels ? (previous[i - channels] ?? 0) : 0;
      let value: number;
      switch (filter) {
        case 0:
          value = x;
          break;
        case 1:
          value = x + a;
          break;
        case 2:
          value = x + b;
          break;
        case 3:
          value = x + ((a + b) >> 1);
          break;
        case 4:
          value = x + paeth(a, b, c);
          break;
        default:
          throw new PngDecodeError(`unknown row filter ${String(filter)}`);
      }
      line[i] = value & 0xff;
    }
    for (let x = 0; x < width; x += 1) {
      const from = x * channels;
      const to = (y * width + x) * 4;
      out[to] = line[from] ?? 0;
      out[to + 1] = line[from + 1] ?? 0;
      out[to + 2] = line[from + 2] ?? 0;
      out[to + 3] = channels === 4 ? (line[from + 3] ?? 255) : 255;
    }
    previous.set(line);
  }

  return { width, height, data: out };
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * How blue a pixel is, relative to its red — the track line's signature.
 *
 * **Not an exact colour match.** MapLibre antialiases the line, so its edge pixels are blends
 * of `#0969da` with whatever is beneath, and no exact value would find them. An exact rule
 * would also be platform-sensitive in the worst way: correct geometry, different coverage, and
 * a failure that says nothing about what was drawn.
 *
 * Blue-minus-red is the right measure because everything else on this map is neutral or warm.
 * The style background is `#eceff1` (excess 5), hillshade is grey over it (excess unchanged),
 * and the contour line is `#795548` — a *negative* excess of 49. The track line is
 * `#0969da`: an excess of 209 at full coverage, and still 46 at a fifth of it.
 */
export function blueExcess(raster: Raster, index: number): number {
  const at = index * 4;
  return (raster.data[at + 2] ?? 0) - (raster.data[at] ?? 0);
}

/**
 * The excess above which a pixel counts as track ink.
 *
 * Set at 40 so roughly the outer fifth of the antialiased edge is still counted, and nothing
 * neutral or warm ever is. Its exact value does not decide any assertion here: every claim is
 * a comparison between masks built with the *same* threshold, so a stricter or looser one
 * moves all of them together.
 */
export const TRACK_BLUE_EXCESS = 40;

/** Pixels carrying track ink, as a flat 0/1 mask. */
export function trackMask(raster: Raster): Uint8Array {
  const mask = new Uint8Array(raster.width * raster.height);
  for (let i = 0; i < mask.length; i += 1) {
    if (blueExcess(raster, i) >= TRACK_BLUE_EXCESS) mask[i] = 1;
  }
  return mask;
}

/** A rectangle in image pixels. */
export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export function countMask(mask: Uint8Array): number {
  let n = 0;
  for (const value of mask) n += value;
  return n;
}

/** How many set pixels a mask has inside a box. */
export function countIn(mask: Uint8Array, width: number, box: Box): number {
  let n = 0;
  for (let y = box.y; y < box.y + box.height; y += 1) {
    for (let x = box.x; x < box.x + box.width; x += 1) n += mask[y * width + x] ?? 0;
  }
  return n;
}

/** `a` minus `b`: set in `a` and not in `b`. */
export function difference(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i += 1) out[i] = a[i] === 1 && b[i] !== 1 ? 1 : 0;
  return out;
}

export function union(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i += 1) out[i] = a[i] === 1 || b[i] === 1 ? 1 : 0;
  return out;
}

export function intersection(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i += 1) out[i] = a[i] === 1 && b[i] === 1 ? 1 : 0;
  return out;
}

/** The smallest box containing every set pixel, or `null` for an empty mask. */
export function boundsOf(mask: Uint8Array, width: number): Box | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < mask.length; i += 1) {
    if (mask[i] !== 1) continue;
    const x = i % width;
    const y = Math.floor(i / width);
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** Pixels whose RGB differs between two rasters of the same size, as a mask. */
export function changedMask(a: Raster, b: Raster): Uint8Array {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error("rasters of different sizes cannot be compared pixel by pixel");
  }
  const mask = new Uint8Array(a.width * a.height);
  for (let i = 0; i < mask.length; i += 1) {
    const at = i * 4;
    if (
      a.data[at] !== b.data[at] ||
      a.data[at + 1] !== b.data[at + 1] ||
      a.data[at + 2] !== b.data[at + 2]
    ) {
      mask[i] = 1;
    }
  }
  return mask;
}
