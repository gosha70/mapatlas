// SPDX-License-Identifier: Apache-2.0
import { inflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { PngError, encodePng } from "./png.mjs";

/**
 * CRC-32 computed **bitwise**, with no lookup table.
 *
 * `png.mjs` is table-driven. This is the same polynomial expressed as the shift-and-xor loop the
 * table is precomputed from, so a mistake in building that table does not reproduce itself here.
 * The published constant for an empty `IEND` chunk anchors the pair, because two implementations
 * agreeing with each other can still both be wrong.
 */
function crc32Bitwise(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) {
    c ^= byte;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Parse a PNG from the bytes up, without reference to how it was written.
 *
 * Deliberately not `encodePng` run backwards: it walks the chunk structure, checks every CRC,
 * concatenates the `IDAT`s, inflates, and strips each row's filter byte. What it returns is the
 * RGB payload a decoder would recover, which is the only thing worth asserting — a library
 * merely *accepting* a file says nothing about whether the pixels survived.
 */
function parsePng(png) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  expect([...png.subarray(0, 8)]).toEqual(signature);

  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const chunks = [];
  let at = 8;
  while (at < png.length) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    const data = png.subarray(at + 8, at + 8 + length);
    const declared = view.getUint32(at + 8 + length);
    chunks.push({ type, data, declared, covered: png.subarray(at + 4, at + 8 + length) });
    at += 12 + length;
  }
  expect(at).toBe(png.length); // no trailing bytes, no chunk overrunning the file

  for (const { type, declared, covered } of chunks) {
    expect(crc32Bitwise(covered), `CRC of ${type}`).toBe(declared);
  }
  expect(chunks.map((c) => c.type).at(0)).toBe("IHDR");
  expect(chunks.map((c) => c.type).at(-1)).toBe("IEND");

  const ihdr = chunks[0].data;
  const head = new DataView(ihdr.buffer, ihdr.byteOffset, ihdr.byteLength);
  const meta = {
    width: head.getUint32(0),
    height: head.getUint32(4),
    bitDepth: ihdr[8],
    colorType: ihdr[9],
    compression: ihdr[10],
    filterMethod: ihdr[11],
    interlace: ihdr[12],
  };

  const idat = chunks.filter((c) => c.type === "IDAT").map((c) => c.data);
  const raw = new Uint8Array(inflateSync(Buffer.concat(idat.map((d) => Buffer.from(d)))));
  const stride = meta.width * 3;
  expect(raw.length).toBe((stride + 1) * meta.height);

  const rgb = new Uint8Array(stride * meta.height);
  for (let row = 0; row < meta.height; row += 1) {
    expect(raw[row * (stride + 1)], `filter byte of row ${String(row)}`).toBe(0);
    rgb.set(raw.subarray(row * (stride + 1) + 1, (row + 1) * (stride + 1)), row * stride);
  }
  return { meta, rgb, chunkTypes: chunks.map((c) => c.type) };
}

/**
 * A pattern in which nothing is symmetric.
 *
 * R varies with the column, G with the row and B with both, and no two channels share a value at
 * a pixel — so a channel swap, a row-stride mistake and a width/height transpose each change the
 * recovered bytes. A grey ramp or a solid fill would hide all three.
 */
function pattern(width, height) {
  const rgb = new Uint8Array(width * height * 3);
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      const i = (row * width + col) * 3;
      rgb[i] = (col * 7 + 1) % 256;
      rgb[i + 1] = (row * 11 + 130) % 256;
      rgb[i + 2] = ((col + row) * 13 + 61) % 256;
    }
  }
  return rgb;
}

describe("the CRC agrees with an independent formulation", () => {
  it("matches the published constant for an empty IEND chunk", () => {
    // 0xAE426082 is the CRC every conforming PNG in existence carries on its final chunk, so it
    // anchors both implementations to something neither of them produced.
    expect(crc32Bitwise(Uint8Array.from([0x49, 0x45, 0x4e, 0x44]))).toBe(0xae426082);
  });

  it("is the CRC the encoder actually wrote", () => {
    const png = encodePng(4, 3, pattern(4, 3));
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    expect(view.getUint32(png.length - 4)).toBe(0xae426082);
  });
});

describe("the serialised image", () => {
  it.each([
    { width: 5, height: 3, note: "wider than tall, so a transpose is structural" },
    { width: 3, height: 5, note: "taller than wide" },
    { width: 1, height: 1, note: "a single pixel" },
    { width: 256, height: 256, note: "a full tile" },
  ])("round-trips $width×$height — $note", ({ width, height }) => {
    // The oracle the bars name: byte identity of the recovered payload, not that a parser
    // tolerated the file.
    const rgb = pattern(width, height);
    const { meta, rgb: recovered, chunkTypes } = parsePng(encodePng(width, height, rgb));

    expect(meta).toEqual({
      width,
      height,
      bitDepth: 8,
      colorType: 2,
      compression: 0,
      filterMethod: 0,
      interlace: 0,
    });
    expect(chunkTypes).toEqual(["IHDR", "IDAT", "IEND"]);
    expect([...recovered]).toEqual([...rgb]);
  });

  it("keeps the three channels distinct, so a swap would be visible", () => {
    // Asserting the fixture's own discriminating power rather than trusting it: if the pattern
    // ever became channel-symmetric, every swap mutation below would quietly stop biting.
    const rgb = pattern(5, 3);
    let distinct = 0;
    for (let i = 0; i < rgb.length; i += 3) {
      if (rgb[i] !== rgb[i + 1] && rgb[i + 1] !== rgb[i + 2] && rgb[i] !== rgb[i + 2])
        distinct += 1;
    }
    expect(distinct).toBe(15);
  });
});

describe("it refuses what it cannot serialise", () => {
  it.each([
    {
      note: "a byte count that does not match the dimensions",
      args: [4, 3, new Uint8Array(11)],
      expected: /is 36 bytes, got 11/,
    },
    {
      note: "a zero width",
      args: [0, 3, new Uint8Array(0)],
      expected: /width must be a positive integer/,
    },
    {
      note: "a fractional height",
      args: [4, 1.5, new Uint8Array(18)],
      expected: /height must be a positive integer/,
    },
  ])("refuses $note", ({ args, expected }) => {
    expect(() => encodePng(...args)).toThrow(PngError);
    expect(() => encodePng(...args)).toThrow(expected);
  });
});
