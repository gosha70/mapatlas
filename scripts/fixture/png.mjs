// SPDX-License-Identifier: Apache-2.0

/**
 * A minimal PNG serialiser for the fixture's raster tiles (T4.6).
 *
 * **It knows nothing about elevation, terrarium or Mercator.** It takes width, height and RGB
 * bytes, and returns a PNG. Whatever those bytes mean is entirely the caller's business, which
 * is what lets it be proven without a network, a projection or an archive anywhere near it.
 *
 * The output is deliberately plain: 8-bit truecolour (`colorType` 2, no alpha), non-interlaced,
 * one `IDAT`, and scanline filter **0** on every row. Filtering exists to help compression, and
 * compression efficiency is not a fixture requirement — a filter chosen per row would add a
 * heuristic whose only observable effect is archive size, and a bug in it would be invisible
 * except as slightly larger files. Terrarium pixels are also poor candidates for it: adjacent
 * elevations differ in the low byte constantly, so the usual predictors buy little.
 *
 * Hand-rolled rather than a dependency, on the same reasoning as the COG reader: the format
 * surface used here is four chunks and a CRC, where a general encoder would bring options this
 * build must never exercise. The CRC is table-driven; the suite checks it against a table-free
 * bitwise formulation and against the published constant for an empty `IEND`.
 */

import { deflateSync } from "node:zlib";

const SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const BIT_DEPTH = 8;
/** Truecolour RGB, no alpha. */
const COLOR_TYPE = 2;
const CHANNELS = 3;
/** The only filter this writes: none. */
const FILTER_NONE = 0;

export class PngError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "PngError";
  }
}

/** The standard CRC-32 table for the PNG polynomial, built once. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

/**
 * CRC-32 over a byte range, as PNG defines it.
 *
 * @param {Uint8Array} bytes
 * @returns {number} unsigned
 */
function crc32(bytes) {
  let c = -1;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/**
 * One PNG chunk: length, type, data, CRC over type **and** data.
 *
 * @param {string} type
 * @param {Uint8Array} data
 * @returns {Uint8Array}
 */
function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  // The CRC covers the type and the data, and *not* the length — a detail worth naming because
  // including the length produces a file every field of which looks right and which no decoder
  // will open.
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/**
 * Serialise RGB bytes as a PNG.
 *
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array} rgb `width · height · 3` bytes, row-major from the top-left.
 * @returns {Uint8Array}
 */
export function encodePng(width, height, rgb) {
  for (const [name, value] of [
    ["width", width],
    ["height", height],
  ]) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new PngError(`${name} must be a positive integer, got ${String(value)}`);
    }
  }
  const stride = width * CHANNELS;
  if (rgb.length !== stride * height) {
    throw new PngError(
      `a ${String(width)}x${String(height)} RGB image is ${String(stride * height)} bytes, got ${String(rgb.length)}`,
    );
  }

  // Each scanline is prefixed with its filter byte, so the raw stream is one byte wider per row
  // than the image. Dropping that byte shifts every row's colours by one channel relative to the
  // next — which decodes without complaint into a recognisable but wrong image.
  const raw = new Uint8Array((stride + 1) * height);
  for (let row = 0; row < height; row += 1) {
    raw[row * (stride + 1)] = FILTER_NONE;
    raw.set(rgb.subarray(row * stride, (row + 1) * stride), row * (stride + 1) + 1);
  }

  const ihdr = new Uint8Array(13);
  const header = new DataView(ihdr.buffer);
  header.setUint32(0, width);
  header.setUint32(4, height);
  ihdr[8] = BIT_DEPTH;
  ihdr[9] = COLOR_TYPE;
  ihdr[10] = 0; // compression method: deflate, the only one defined
  ihdr[11] = 0; // filter method: the only one defined
  ihdr[12] = 0; // non-interlaced

  const parts = [
    SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", new Uint8Array(deflateSync(raw))),
    chunk("IEND", new Uint8Array(0)),
  ];
  const png = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) {
    png.set(part, at);
    at += part.length;
  }
  return png;
}
