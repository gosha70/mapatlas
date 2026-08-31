// SPDX-License-Identifier: Apache-2.0

/**
 * The source reader: Copernicus DEM GLO-30 Public COGs on S3, cropped to a declared region and
 * terrarium-encoded (T4.6; ADR-0024, criteria 5 and 7).
 *
 * **No GeoTIFF library, and that is a choice rather than an omission.** The source is one known
 * product family with one structure, measured from `N45E006` on 2026-08-30: little-endian
 * classic TIFF, 3600x3600, one float32 sample per pixel, deflate (compression 8) with the
 * floating-point predictor (3), tiled 1024x1024, EPSG:4326, `RasterPixelIsPoint`. Decoding that
 * needs `node:zlib` and the predictor's inverse — some sixty lines — where a general reader
 * would be a dependency whose whole value is the formats this build must never silently accept.
 * Every structural assumption below is asserted and names the tag that diverged, so an upstream
 * format change fails loudly here instead of being accommodated into a wrong surface.
 *
 * **Range reads, not whole objects.** The object is 42 MB; a cut of the declared region touches
 * two of its sixteen internal tiles, so a build reads a header window plus ~3.8 MB across three
 * requests. Coverage is **not** discovered for free along the way: `deps.mjs` issues a separate
 * one-byte probe per required tile, because a reader that throws on a 404 would destroy the
 * distinction between an unpublished tile and a broken fetch. The probe is a range GET like
 * these, which is why 206 is a presence status — not because it is the same request.
 *
 * Nothing here fetches directly: `fetchRange` is injected, so the whole reader is testable
 * against a constructed COG with no network.
 */

import { inflateSync } from "node:zlib";

import { parseTileId } from "./coverage.mjs";
import { parseBounds } from "./region.mjs";
import { encodeElevation } from "./terrarium.mjs";

/** The public mirror the release is read from (ADR-0024, criterion 7). */
export const COG_BUCKET_URL = "https://copernicus-dem-30m.s3.amazonaws.com";

/**
 * Bytes read up-front to parse the header.
 *
 * The measured object puts IFD0 at offset 192 and its out-of-line arrays inside the first
 * kilobyte, so this is generous by three orders of magnitude — deliberately, because the cost of
 * being wrong is a second round trip and the cost of being generous is 64 KB once. Anything the
 * header references beyond the window fails naming the extent it needed, rather than reading
 * whatever bytes happened to be there.
 */
export const HEADER_WINDOW_BYTES = 65536;

/** Structural constants this reader decodes, and only these. */
const REQUIRED = Object.freeze({
  bitsPerSample: 32,
  sampleFormat: 3, // IEEE floating point
  samplesPerPixel: 1,
  compression: 8, // deflate
  predictor: 3, // floating point
  planarConfig: 1, // chunky
  geographicCrs: 4326,
  rasterType: 2, // RasterPixelIsPoint
});

const TAG = Object.freeze({
  imageWidth: 256,
  imageLength: 257,
  bitsPerSample: 258,
  compression: 259,
  samplesPerPixel: 277,
  planarConfig: 284,
  predictor: 317,
  tileWidth: 322,
  tileLength: 323,
  tileOffsets: 324,
  tileByteCounts: 325,
  sampleFormat: 339,
  modelPixelScale: 33550,
  modelTiepoint: 33922,
  geoKeyDirectory: 34735,
});

/** Bytes per TIFF field type, for the types this header uses. */
const TYPE_BYTES = Object.freeze({ 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 11: 4, 12: 8 });

export class SourceFormatError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "SourceFormatError";
  }
}

/**
 * The object key for a source tile.
 *
 * @param {string} id
 * @returns {string}
 */
export function cogObjectKey(id) {
  const { south, west } = parseTileId(id);
  const ns = south < 0 ? "S" : "N";
  const ew = west < 0 ? "W" : "E";
  const name =
    `Copernicus_DSM_COG_10_${ns}${String(Math.abs(south)).padStart(2, "0")}_00_` +
    `${ew}${String(Math.abs(west)).padStart(3, "0")}_00_DEM`;
  return `${name}/${name}.tif`;
}

/**
 * The full URL for a source tile.
 *
 * @param {string} id
 * @param {string} [bucketUrl]
 * @returns {string}
 */
export function cogUrl(id, bucketUrl = COG_BUCKET_URL) {
  return `${bucketUrl}/${cogObjectKey(id)}`;
}

/**
 * Parse the subset of TIFF this source uses, asserting every structure the decoder relies on.
 *
 * @param {Uint8Array} window Bytes from offset 0 of the object.
 * @param {string} source Named in failures, so a reader knows which object diverged.
 * @returns {{
 *   width: number, height: number, tileWidth: number, tileHeight: number,
 *   tilesAcross: number, tilesDown: number,
 *   tileOffsets: number[], tileByteCounts: number[],
 *   pixelScaleDeg: number, originLon: number, originLat: number,
 * }}
 */
export function parseCogHeader(window, source = "COG") {
  const view = new DataView(window.buffer, window.byteOffset, window.byteLength);
  const need = (end, what) => {
    if (end > window.byteLength) {
      throw new SourceFormatError(
        `${source}: ${what} lies at byte ${String(end)}, beyond the ${String(window.byteLength)}-byte header window`,
      );
    }
  };

  need(8, "the TIFF header");
  if (view.getUint16(0, true) !== 0x4949 || view.getUint16(2, true) !== 42) {
    throw new SourceFormatError(
      `${source}: not a little-endian classic TIFF (byte order and magic are the first four bytes)`,
    );
  }
  const ifd = view.getUint32(4, true);
  need(ifd + 2, "the first IFD");
  const count = view.getUint16(ifd, true);
  need(ifd + 2 + count * 12, "the first IFD's entries");

  /** @type {Map<number, number[]>} */
  const fields = new Map();
  for (let i = 0; i < count; i += 1) {
    const entry = ifd + 2 + i * 12;
    const tag = view.getUint16(entry, true);
    const type = view.getUint16(entry + 2, true);
    const length = view.getUint32(entry + 4, true);
    const unit = TYPE_BYTES[type];
    if (unit === undefined) continue; // a type this reader does not read; the assertions below decide whether that matters
    const size = unit * length;
    const at = size <= 4 ? entry + 8 : view.getUint32(entry + 8, true);
    need(at + size, `tag ${String(tag)}`);
    const values = [];
    for (let k = 0; k < length; k += 1) {
      const o = at + k * unit;
      if (type === 3) values.push(view.getUint16(o, true));
      else if (type === 4) values.push(view.getUint32(o, true));
      else if (type === 12) values.push(view.getFloat64(o, true));
      else if (type === 11) values.push(view.getFloat32(o, true));
      else values.push(view.getUint8(o));
    }
    fields.set(tag, values);
  }

  /**
   * @param {number} tag
   * @param {string} name
   * @returns {number[]}
   */
  const require_ = (tag, name) => {
    const values = fields.get(tag);
    if (values === undefined || values.length === 0) {
      throw new SourceFormatError(`${source}: ${name} (tag ${String(tag)}) is missing`);
    }
    return values;
  };
  /**
   * @param {number} tag
   * @param {string} name
   * @param {number} expected
   */
  const requireValue = (tag, name, expected) => {
    const [actual] = require_(tag, name);
    if (actual !== expected) {
      throw new SourceFormatError(
        `${source}: ${name} (tag ${String(tag)}) is ${String(actual)}, and this reader decodes only ${String(expected)}`,
      );
    }
  };

  requireValue(TAG.bitsPerSample, "BitsPerSample", REQUIRED.bitsPerSample);
  requireValue(TAG.sampleFormat, "SampleFormat", REQUIRED.sampleFormat);
  requireValue(TAG.samplesPerPixel, "SamplesPerPixel", REQUIRED.samplesPerPixel);
  requireValue(TAG.compression, "Compression", REQUIRED.compression);
  requireValue(TAG.predictor, "Predictor", REQUIRED.predictor);
  requireValue(TAG.planarConfig, "PlanarConfiguration", REQUIRED.planarConfig);

  const [width] = require_(TAG.imageWidth, "ImageWidth");
  const [height] = require_(TAG.imageLength, "ImageLength");
  const [tileWidth] = require_(TAG.tileWidth, "TileWidth");
  const [tileHeight] = require_(TAG.tileLength, "TileLength");
  const tileOffsets = require_(TAG.tileOffsets, "TileOffsets");
  const tileByteCounts = require_(TAG.tileByteCounts, "TileByteCounts");

  const tilesAcross = Math.ceil(width / tileWidth);
  const tilesDown = Math.ceil(height / tileHeight);
  const expectedTiles = tilesAcross * tilesDown;
  if (tileOffsets.length !== expectedTiles || tileByteCounts.length !== expectedTiles) {
    throw new SourceFormatError(
      `${source}: a ${String(width)}x${String(height)} image in ${String(tileWidth)}x${String(tileHeight)} tiles ` +
        `needs ${String(expectedTiles)} entries, but TileOffsets has ${String(tileOffsets.length)} ` +
        `and TileByteCounts has ${String(tileByteCounts.length)}`,
    );
  }

  const scale = require_(TAG.modelPixelScale, "ModelPixelScale");
  if (scale.length < 2 || scale[0] !== scale[1] || !(scale[0] > 0)) {
    throw new SourceFormatError(
      `${source}: ModelPixelScale is [${scale.join(", ")}]; this reader needs equal, positive x and y spacing`,
    );
  }
  const tiepoint = require_(TAG.modelTiepoint, "ModelTiepoint");
  if (tiepoint.length < 6 || tiepoint[0] !== 0 || tiepoint[1] !== 0) {
    throw new SourceFormatError(
      `${source}: ModelTiepoint is [${tiepoint.join(", ")}]; this reader needs raster (0, 0) tied to a ground point`,
    );
  }

  const geoKeys = require_(TAG.geoKeyDirectory, "GeoKeyDirectory");
  /** @param {number} key @param {string} name @param {number} expected */
  const requireGeoKey = (key, name, expected) => {
    for (let i = 4; i + 3 < geoKeys.length; i += 4) {
      if (geoKeys[i] !== key) continue;
      if (geoKeys[i + 1] !== 0) {
        throw new SourceFormatError(
          `${source}: ${name} (geokey ${String(key)}) is stored out of line, which this reader does not read`,
        );
      }
      if (geoKeys[i + 3] !== expected) {
        throw new SourceFormatError(
          `${source}: ${name} (geokey ${String(key)}) is ${String(geoKeys[i + 3])}, and this reader decodes only ${String(expected)}`,
        );
      }
      return;
    }
    throw new SourceFormatError(`${source}: ${name} (geokey ${String(key)}) is missing`);
  };
  requireGeoKey(2048, "GeographicTypeGeoKey", REQUIRED.geographicCrs);
  requireGeoKey(1025, "GTRasterTypeGeoKey", REQUIRED.rasterType);

  return {
    width,
    height,
    tileWidth,
    tileHeight,
    tilesAcross,
    tilesDown,
    tileOffsets,
    tileByteCounts,
    pixelScaleDeg: scale[0],
    originLon: tiepoint[3],
    originLat: tiepoint[4],
  };
}

/**
 * Undo TIFF predictor 3 in place and reinterpret the row as float32.
 *
 * Two steps, and conflating them is the classic way to get a plausible-looking wrong surface.
 * Each row is first byte-wise accumulated at the sample stride, then **de-planed**: the row is
 * stored as one plane per byte position, most significant first, so the float's bytes are
 * gathered from four places rather than read consecutively. On a little-endian host the most
 * significant plane lands last within each sample.
 *
 * @param {Uint8Array} bytes One decompressed tile, row-major.
 * @param {number} rowBytes
 * @returns {Float32Array}
 */
export function undoFloatPredictor(bytes, rowBytes) {
  const BYTES_PER_SAMPLE = 4;
  const stride = REQUIRED.samplesPerPixel;
  const samplesPerRow = rowBytes / BYTES_PER_SAMPLE;
  const rows = bytes.length / rowBytes;
  const plane = new Uint8Array(rowBytes);
  for (let row = 0; row < rows; row += 1) {
    const base = row * rowBytes;
    for (let i = stride; i < rowBytes; i += 1) {
      bytes[base + i] = (bytes[base + i] + bytes[base + i - stride]) & 0xff;
    }
    plane.set(bytes.subarray(base, base + rowBytes));
    for (let s = 0; s < samplesPerRow; s += 1) {
      for (let b = 0; b < BYTES_PER_SAMPLE; b += 1) {
        bytes[base + BYTES_PER_SAMPLE * s + (BYTES_PER_SAMPLE - 1 - b)] =
          plane[b * samplesPerRow + s];
      }
    }
  }
  // Copied into an ArrayBuffer this function owns, because `bytes` is a view: it starts at some
  // byteOffset inside a larger buffer, and `Float32Array`'s constructor both requires four-byte
  // alignment and ignores the view's offset when handed a raw `.buffer`.
  //
  // **Not `bytes.slice()`.** `inflateSync` returns a Buffer, and `Buffer.prototype.slice` is a
  // view rather than a copy — the one method on Buffer that disagrees with its `Uint8Array`
  // namesake. `bytes.slice().buffer` is therefore the whole allocation pool, and the floats get
  // read from the pool's origin instead of from this tile. It decoded correctly wherever the
  // buffer happened to land at offset zero, which is what a large unpooled allocation does, and
  // returned another tile's bytes as entirely plausible terrain where it did not.
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return new Float32Array(copy.buffer);
}

/**
 * How far a sample index may sit from a bound before it counts as a distinct sample.
 *
 * In sample units, so it is independent of the source's spacing. At 1 arcsec this is about
 * 0.03 mm on the ground: six orders of magnitude below one sample, and three above the ~1.6e-9
 * worst-case rounding error of a double at index magnitude 3600. Wide enough that an exactly
 * aligned bound never rounds to the next sample, narrow enough that it can never absorb a real
 * one.
 */
export const GRID_EPSILON_SAMPLES = 1e-6;

/**
 * The half-open sample window a region's bounds select from one source tile.
 *
 * **Every index comes from its own endpoint, by ceiling.** The first version rounded the west
 * and north edges and then took a *width*, which is wrong in two ways that only appear on
 * bounds that are not sample-aligned: a west edge at 6.1 with 0.25° spacing rounds to the
 * sample at 6.0 — **outside the requested crop** — and the east edge is never consulted at all,
 * so the window's extent is asserted rather than derived. Aligned bounds hide both, which is
 * why the declared region did not expose it. Taking `ceil` of each endpoint selects exactly the
 * samples lying within the request, whether or not the request lands on the grid.
 *
 * **Half-open on both upper edges**, matching `requiredTiles`: a cut whose east edge lands
 * exactly on a sample column takes the columns before it, not that column as well. The two
 * conventions have to agree, because one decides which tiles are fetched and the other decides
 * which samples are read from them — disagreeing would read a column from a tile coverage never
 * required. The end indices are exclusive ceilings, which is what preserves that: an exactly
 * aligned east edge ceils to its own column, and the column is then excluded.
 *
 * @param {{ width: number, height: number, pixelScaleDeg: number, originLon: number, originLat: number }} header
 * @param {[west: number, south: number, east: number, north: number]} bounds
 * @returns {{ col0: number, row0: number, cols: number, rows: number }}
 */
export function cropWindow(header, bounds) {
  // The same validator the region declaration and the coverage check use, not a third copy.
  // It also removes the only way `cols` could come out negative — a box whose east precedes
  // its west — so the emptiness check below needs no unreachable arm for it.
  const [west, south, east, north] = parseBounds(bounds, "crop bounds");
  const { pixelScaleDeg: scale, originLon, originLat } = header;
  /** First sample index at or beyond an offset, in degrees from the raster origin. */
  const firstAtOrBeyond = (offsetDeg) => Math.ceil(offsetDeg / scale - GRID_EPSILON_SAMPLES);
  const col0 = firstAtOrBeyond(west - originLon);
  const row0 = firstAtOrBeyond(originLat - north);
  const cols = firstAtOrBeyond(east - originLon) - col0;
  const rows = firstAtOrBeyond(originLat - south) - row0;
  if (col0 < 0 || row0 < 0 || col0 + cols > header.width || row0 + rows > header.height) {
    throw new SourceFormatError(
      `crop [${bounds.join(", ")}] falls outside the tile at ` +
        `(${String(originLon)}, ${String(originLat)}) spanning ${String(header.width)}x${String(header.height)} samples`,
    );
  }
  if (cols === 0 || rows === 0) {
    throw new SourceFormatError(`crop [${bounds.join(", ")}] selects no samples from this tile`);
  }
  return { col0, row0, cols, rows };
}

/**
 * Read one source tile's crop and terrarium-encode it.
 *
 * @param {string} id Source tile id, e.g. `N45E006`.
 * @param {[west: number, south: number, east: number, north: number]} bounds
 * @param {{ fetchRange: (url: string, start: number, endInclusive: number) => Promise<Uint8Array>, bucketUrl?: string }} deps
 * @returns {Promise<{ width: number, height: number, west: number, north: number, pixelScaleDeg: number, rgb: Uint8Array }>}
 *   `rgb` holds three bytes per sample, row-major from the crop's north-west corner.
 */
export async function readTerrariumCrop(id, bounds, deps) {
  const url = cogUrl(id, deps.bucketUrl);
  const source = `${id} (${url})`;
  const header = parseCogHeader(await deps.fetchRange(url, 0, HEADER_WINDOW_BYTES - 1), source);

  // The tiepoint is checked against the id rather than trusted, because every other failure in
  // this module is loud and this one would not be: fetching the wrong object decodes perfectly
  // and produces a correct-looking surface in the wrong place.
  const { south, west } = parseTileId(id);
  const expectedLat = south + 1;
  if (header.originLon !== west || header.originLat !== expectedLat) {
    throw new SourceFormatError(
      `${id}: the object is tied to (${String(header.originLon)}, ${String(header.originLat)}), ` +
        `but ${id} names the cell whose north-west corner is (${String(west)}, ${String(expectedLat)})`,
    );
  }

  const window = cropWindow(header, bounds);
  const { tileWidth, tileHeight, tilesAcross } = header;
  const rowBytes = tileWidth * 4;
  const tileBytes = rowBytes * tileHeight;

  /** @type {Map<number, Float32Array>} */
  const decoded = new Map();
  const firstTileRow = Math.floor(window.row0 / tileHeight);
  const lastTileRow = Math.floor((window.row0 + window.rows - 1) / tileHeight);
  const firstTileCol = Math.floor(window.col0 / tileWidth);
  const lastTileCol = Math.floor((window.col0 + window.cols - 1) / tileWidth);
  for (let ty = firstTileRow; ty <= lastTileRow; ty += 1) {
    for (let tx = firstTileCol; tx <= lastTileCol; tx += 1) {
      const index = ty * tilesAcross + tx;
      const offset = header.tileOffsets[index];
      const length = header.tileByteCounts[index];
      const raw = await deps.fetchRange(url, offset, offset + length - 1);
      const inflated = inflateSync(raw);
      // Checked rather than trusted, and checked *here* rather than left to fail downstream.
      // An over-long tile is the dangerous one: `undoFloatPredictor` would decode it happily
      // and the extra samples would simply never be indexed, so a source that changed its
      // tiling would produce a plausible surface instead of a failure — the exact silent
      // accommodation this reader's assertions exist to prevent. A short tile fails too, but
      // otherwise only later and indirectly, as a garbled row or an out-of-bounds read.
      if (inflated.length !== tileBytes) {
        throw new SourceFormatError(
          `${source}: internal tile ${String(index)} inflates to ${String(inflated.length)} bytes, ` +
            `but a ${String(tileWidth)}x${String(tileHeight)} float32 tile is ${String(tileBytes)}`,
        );
      }
      decoded.set(index, undoFloatPredictor(inflated, rowBytes));
    }
  }

  const rgb = new Uint8Array(window.cols * window.rows * 3);
  let out = 0;
  for (let r = window.row0; r < window.row0 + window.rows; r += 1) {
    const ty = Math.floor(r / tileHeight);
    const inTileRow = (r % tileHeight) * tileWidth;
    for (let c = window.col0; c < window.col0 + window.cols; c += 1) {
      const samples = decoded.get(ty * tilesAcross + Math.floor(c / tileWidth));
      // `encodeElevation` throws on a non-finite or out-of-range sample rather than clamping,
      // so a nodata value or a unit mistake stops the build here instead of becoming terrain.
      const [red, green, blue] = encodeElevation(samples[inTileRow + (c % tileWidth)]);
      rgb[out] = red;
      rgb[out + 1] = green;
      rgb[out + 2] = blue;
      out += 3;
    }
  }

  return {
    width: window.cols,
    height: window.rows,
    west: header.originLon + window.col0 * header.pixelScaleDeg,
    north: header.originLat - window.row0 * header.pixelScaleDeg,
    pixelScaleDeg: header.pixelScaleDeg,
    rgb,
  };
}
