// SPDX-License-Identifier: Apache-2.0

/**
 * A synthetic COG and an in-memory range reader, shared by the suites that need one.
 *
 * Not a `.test.mjs` file, so the runner does not pick it up as a suite. It lives beside the
 * modules it serves because two suites need the same fixture: `source.test.mjs` decodes it, and
 * `deps.test.mjs` serves two of them from different URLs to check that each tile is read from
 * its own object.
 */

import { deflateSync } from "node:zlib";

/**
 * Build a COG shaped like the source, so every structural assertion has an input that reaches
 * it and every one can be mutated singly.
 *
 * The builder writes the format rather than describing it: it applies TIFF predictor 3 forward
 * — de-plane, then difference — and deflates. That matters beyond convenience. A fixture
 * produced by inverting the decoder would agree with the decoder by construction and could not
 * catch a decoder that inverts the two steps or gets the plane order backwards, which is
 * precisely the mistake that yields a plausible-looking wrong surface.
 */
export function buildCog({
  width = 8,
  height = 8,
  tileWidth = 4,
  tileHeight = 4,
  originLon = 6,
  originLat = 46,
  pixelScale = 0.25,
  samples,
  overrides = {},
  omit = [],
  geoKeyOverrides = {},
  tilePayloadDelta = 0,
} = {}) {
  const elevation = samples ?? ((c, r) => 3000 + c * 10 + r);
  const tilesAcross = Math.ceil(width / tileWidth);
  const tilesDown = Math.ceil(height / tileHeight);
  const rowBytes = tileWidth * 4;

  /** @type {Buffer[]} */
  const tileBlobs = [];
  for (let ty = 0; ty < tilesDown; ty += 1) {
    for (let tx = 0; tx < tilesAcross; tx += 1) {
      const plain = Buffer.alloc(rowBytes * tileHeight);
      for (let r = 0; r < tileHeight; r += 1) {
        for (let c = 0; c < tileWidth; c += 1) {
          const gc = tx * tileWidth + c;
          const gr = ty * tileHeight + r;
          const value = gc < width && gr < height ? elevation(gc, gr) : 0;
          plain.writeFloatLE(value, r * rowBytes + c * 4);
        }
      }
      // Forward predictor 3, per row: de-plane most-significant-byte-first, then difference.
      const encoded = Buffer.alloc(plain.length);
      for (let r = 0; r < tileHeight; r += 1) {
        const base = r * rowBytes;
        for (let s = 0; s < tileWidth; s += 1) {
          for (let b = 0; b < 4; b += 1) {
            encoded[base + b * tileWidth + s] = plain[base + s * 4 + (3 - b)];
          }
        }
        for (let i = rowBytes - 1; i >= 1; i -= 1) {
          encoded[base + i] = (encoded[base + i] - encoded[base + i - 1]) & 0xff;
        }
      }
      // A tile whose decompressed length is not what its declared tiling implies. Applied to
      // the payload before deflate, so the archive is otherwise well-formed and the failure is
      // the length alone rather than a broken stream.
      const payload =
        tilePayloadDelta === 0
          ? encoded
          : tilePayloadDelta > 0
            ? Buffer.concat([encoded, Buffer.alloc(tilePayloadDelta)])
            : encoded.subarray(0, encoded.length + tilePayloadDelta);
      tileBlobs.push(deflateSync(payload));
    }
  }

  const geoKeys = { 1024: 2, 1025: 2, 2048: 4326, ...geoKeyOverrides };
  const declared = Object.keys(geoKeys)
    .map(Number)
    .filter((key) => geoKeys[key] !== undefined)
    .sort((a, b) => a - b);
  const shorts = [1, 1, 0, declared.length];
  for (const key of declared) shorts.push(key, 0, 1, geoKeys[key]);

  /** SHORT=3, LONG=4, DOUBLE=12 */
  const entries = [
    { tag: 256, type: 3, values: [width] },
    { tag: 257, type: 3, values: [height] },
    { tag: 258, type: 3, values: [32] },
    { tag: 259, type: 3, values: [8] },
    { tag: 277, type: 3, values: [1] },
    { tag: 284, type: 3, values: [1] },
    { tag: 317, type: 3, values: [3] },
    { tag: 322, type: 3, values: [tileWidth] },
    { tag: 323, type: 3, values: [tileHeight] },
    // Placeholder of the right length: the entry's size decides the heap layout, and the heap
    // layout decides where the tile data starts, which is what the real offsets point at.
    { tag: 324, type: 4, values: tileBlobs.map(() => 0) },
    { tag: 325, type: 4, values: tileBlobs.map((b) => b.length) },
    { tag: 339, type: 3, values: [3] },
    { tag: 33550, type: 12, values: [pixelScale, pixelScale, 0] },
    { tag: 33922, type: 12, values: [0, 0, 0, originLon, originLat, 0] },
    { tag: 34735, type: 3, values: shorts },
  ]
    .filter((e) => !omit.includes(e.tag))
    .map((e) => (e.tag in overrides ? { ...e, values: overrides[e.tag] } : e));
  entries.sort((a, b) => a.tag - b.tag);

  const typeBytes = { 3: 2, 4: 4, 12: 8 };
  const ifdAt = 8;
  const ifdBytes = 2 + entries.length * 12 + 4;
  let heapAt = ifdAt + ifdBytes;
  for (const e of entries) {
    const size = typeBytes[e.type] * e.values.length;
    if (size > 4) {
      e.at = heapAt;
      heapAt += size;
    }
  }
  const dataAt = heapAt;
  const tileOffsetsEntry = entries.find((e) => e.tag === 324);
  if (tileOffsetsEntry !== undefined && !(324 in overrides)) {
    let cursor = dataAt;
    tileOffsetsEntry.values = tileBlobs.map((blob) => {
      const at = cursor;
      cursor += blob.length;
      return at;
    });
  }

  const total = dataAt + tileBlobs.reduce((n, b) => n + b.length, 0);
  const out = Buffer.alloc(Math.max(total, 0));
  out.writeUInt16LE(0x4949, 0);
  out.writeUInt16LE(42, 2);
  out.writeUInt32LE(ifdAt, 4);
  out.writeUInt16LE(entries.length, ifdAt);
  entries.forEach((e, i) => {
    const at = ifdAt + 2 + i * 12;
    out.writeUInt16LE(e.tag, at);
    out.writeUInt16LE(e.type, at + 2);
    out.writeUInt32LE(e.values.length, at + 4);
    const size = typeBytes[e.type] * e.values.length;
    const write = (target) =>
      e.values.forEach((v, k) => {
        const o = target + k * typeBytes[e.type];
        if (e.type === 3) out.writeUInt16LE(v, o);
        else if (e.type === 4) out.writeUInt32LE(v, o);
        else out.writeDoubleLE(v, o);
      });
    if (size <= 4) write(at + 8);
    else {
      out.writeUInt32LE(e.at, at + 8);
      write(e.at);
    }
  });
  let cursor = dataAt;
  for (const blob of tileBlobs) {
    blob.copy(out, cursor);
    cursor += blob.length;
  }
  return new Uint8Array(out);
}

/**
 * A `fetchRange` over an in-memory object, recording what it was asked for.
 *
 * @param {Uint8Array} bytes
 */
export function fetchRangeOver(bytes) {
  const calls = [];
  return {
    calls,
    fetchRange: (url, start, endInclusive) => {
      calls.push([start, endInclusive]);
      return Promise.resolve(bytes.slice(start, Math.min(endInclusive + 1, bytes.length)));
    },
  };
}
