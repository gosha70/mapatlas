// SPDX-License-Identifier: Apache-2.0

/**
 * The PMTiles writer (T4.6; ADR-0024, criterion 6).
 *
 * **This module owns no raster semantics.** It takes opaque `bytes` at a `z/x/y` address plus a
 * metadata object, and writes a PMTiles v3 archive. Terrarium encoding, PNG versus vector
 * payloads, resampling and source-cell addressing all belong upstream — so the Web-Mercator
 * increment can supply a different pyramid, and a contour layer a different payload type,
 * without this file changing.
 *
 * **`s2-pmtiles` does not appear in the seam.** Its writer, its sink, its tile-id conversion and
 * its enums stay behind `writeArchive`, which speaks `z/x/y`, a plain metadata object, and the
 * strings `"png" | "mvt"` and `"none" | "gzip"`. Swapping the dependency should not reach any
 * caller.
 *
 * The sink is `FileWriter`, and that is a measured choice rather than a default. `BufferWriter`
 * appends **one array push and one `await` per byte**, which threw `RangeError: Invalid array
 * length` on a fixture-scale archive before writing anything; `FileWriter` issues one `write`
 * per payload and wrote the same 61 MB archive in 2.3 s.
 */

import { Compression, S2PMTilesWriter, TileType, zxyToTileID } from "s2-pmtiles";
import { FileWriter } from "s2-pmtiles/file";

/** Payload types this writer will label an archive with, in MAP-ATLAS terms. */
const TILE_TYPES = Object.freeze({ png: TileType.Png, mvt: TileType.Pbf });
/**
 * Compressions, likewise.
 *
 * PMTiles carries **one** setting for a whole archive, which is a real constraint rather than a
 * detail: already-compressed PNG rasters want `none` and vector tiles want `gzip`, so a raster
 * source and a contour source cannot share an archive without one of them being wrong. They are
 * separate sources to a renderer anyway, so the fixture writes separate archives.
 */
const COMPRESSIONS = Object.freeze({ none: Compression.None, gzip: Compression.Gzip });

export class ArchiveError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "ArchiveError";
  }
}

/**
 * Validate, order and write a set of tiles as a PMTiles v3 archive.
 *
 * **Tiles are sorted, and duplicates are refused.** Both halves are decided here rather than
 * inherited from whatever the dependency happens to do with the order it is handed:
 *
 * - *Sorted*, by the archive's own tile id, because it makes the output a function of the tile
 *   set rather than of the caller's iteration order — the same tiles produce the same bytes —
 *   and because writing in id order is what lets the archive declare itself `clustered`. A
 *   caller that enumerated a pyramid depth-first would otherwise silently produce a differently
 *   ordered, unclustered archive from identical data.
 * - *Duplicates refused*, because two payloads at one address have no correct resolution: the
 *   dependency would keep whichever arrived last, which is a silent answer to an ambiguous
 *   question. Identical bytes are refused too — the caller enumerated an address twice, and
 *   that is a bug whether or not it happens to be harmless this time.
 *
 * `metadata.bounds` is **required**, as `[west, south, east, north]` degrees, and is written into
 * the archive **header** as well as the JSON blob — see {@link writeHeaderBounds}. It is not
 * optional: an archive whose header bounds are absent is one a renderer rejects, so a
 * `writeArchive` that resolved without them would report success for an unusable file.
 *
 * @param {string} path Where to write. Must not already exist — the sink appends.
 * @param {Iterable<{ z: number, x: number, y: number, bytes: Uint8Array }>} tiles
 * @param {Record<string, unknown>} metadata Written into the archive as its JSON metadata.
 * @param {{
 *   tileType?: "png" | "mvt",
 *   compression?: "none" | "gzip",
 *   createSink?: (path: string) => object,
 * }} [options]
 * @returns {Promise<{ path: string, tileCount: number }>}
 */
export async function writeArchive(path, tiles, metadata, options = {}) {
  const { tileType = "png", compression = "none", createSink = (p) => new FileWriter(p) } = options;
  if (!(tileType in TILE_TYPES)) {
    throw new ArchiveError(
      `unknown tile type "${tileType}"; this writer labels archives ${Object.keys(TILE_TYPES).join(" or ")}`,
    );
  }
  if (!(compression in COMPRESSIONS)) {
    throw new ArchiveError(
      `unknown compression "${compression}"; this writer writes ${Object.keys(COMPRESSIONS).join(" or ")}`,
    );
  }

  // **Required and checked before anything is written.** `writeHeaderBounds` used to return
  // quietly when the bounds were missing, malformed, reversed or non-finite — leaving exactly
  // the `0,0,0,0` header this fix exists to prevent, and a `writeArchive` that resolved
  // successfully having produced an archive a renderer rejects. A successful write must always
  // mean a renderer-valid archive, so the failure moves to the front where it costs nothing.
  const bounds = metadata["bounds"];
  if (!Array.isArray(bounds) || bounds.length !== 4 || !bounds.every(Number.isFinite)) {
    throw new ArchiveError(
      "metadata.bounds must be four finite numbers [west, south, east, north]: they are written " +
        "into the archive header, and a renderer treats a degenerate box as an invalid archive",
    );
  }
  const [west, south, east, north] = bounds.map(Number);
  if (west >= east || south >= north) {
    throw new ArchiveError(
      `metadata.bounds [${bounds.join(", ")}] is degenerate: west must precede east and south north`,
    );
  }
  // **Ordered is not the same as real.** `[200, 45, 300, 46]` is finite and correctly ordered
  // and describes nowhere: 300° × 10⁷ is 3 × 10⁹, past `Int32`'s 2.147 × 10⁹, so the header
  // field wraps to a *negative* longitude and the archive claims a box on the other side of the
  // world. Latitudes past ±90 do not wrap but are equally impossible, and a renderer handed one
  // has no defined behaviour to fall back on. The field is geographic, so the check is too.
  if (west < -180 || east > 180 || south < -90 || north > 90) {
    throw new ArchiveError(
      `metadata.bounds [${bounds.join(", ")}] is not a location: longitude must lie within ` +
        `±180 and latitude within ±90, and the header stores degrees × 10⁷ in an Int32, ` +
        `where an out-of-range longitude wraps to the opposite hemisphere rather than failing`,
    );
  }

  /** @type {Map<number, { z: number, x: number, y: number, bytes: Uint8Array }>} */
  const byId = new Map();
  /** The shallowest tile actually written — see {@link writeHeaderBounds}'s `centreZoom`. */
  let minTileZoom = Infinity;
  for (const tile of tiles) {
    const { z, x, y, bytes } = tile;
    for (const [name, value] of [
      ["z", z],
      ["x", x],
      ["y", y],
    ]) {
      if (!Number.isInteger(value) || value < 0) {
        throw new ArchiveError(`tile ${name} must be a non-negative integer, got ${String(value)}`);
      }
    }
    const span = 2 ** z;
    if (x >= span || y >= span) {
      throw new ArchiveError(
        `tile ${String(z)}/${String(x)}/${String(y)} is outside zoom ${String(z)}`,
      );
    }
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
      // An empty payload is not a way to say "absent". A tile that was never written reads back
      // as `undefined`, and that distinction is what obligation 3 rests on; writing a zero-byte
      // tile would put something at the address that is neither data nor absence.
      throw new ArchiveError(
        `tile ${String(z)}/${String(x)}/${String(y)} has no bytes; an absent tile is written by not writing it`,
      );
    }
    const id = zxyToTileID(z, x, y);
    if (byId.has(id)) {
      throw new ArchiveError(
        `tile ${String(z)}/${String(x)}/${String(y)} was supplied more than once; ` +
          `two payloads at one address have no correct resolution`,
      );
    }
    byId.set(id, tile);
    minTileZoom = Math.min(minTileZoom, z);
  }
  if (byId.size === 0) {
    throw new ArchiveError("refusing to write an archive with no tiles");
  }

  // The sink is retained: it already offers the random-access `write(data, offset)` the header
  // patch needs. Reopening the path instead created two writer behaviours — and left every
  // custom sink with an unpatched header, which is the one case a caller cannot see.
  const sink = createSink(path);
  const writer = new S2PMTilesWriter(sink, TILE_TYPES[tileType], COMPRESSIONS[compression]);
  for (const id of [...byId.keys()].sort((a, b) => a - b)) {
    const { z, x, y, bytes } = /** @type {{z: number, x: number, y: number, bytes: Uint8Array}} */ (
      byId.get(id)
    );
    await writer.writeTileXYZ(z, x, y, bytes);
  }
  await writer.commit(metadata);
  await writeHeaderBounds(sink, { west, south, east, north }, minTileZoom);

  return { path, tileCount: byId.size };
}

/** Where PMTiles v3 keeps the geographic bounds, in the header, as degrees × 10⁷. */
const HEADER_BOUNDS = Object.freeze({
  minLon: 102,
  minLat: 106,
  maxLon: 110,
  maxLat: 114,
  centreZoom: 118,
  centreLon: 119,
  centreLat: 123,
});
const E7 = 10_000_000;

/**
 * Write the archive's geographic bounds into its header.
 *
 * **`s2-pmtiles` does not.** Its `headerToBytes` stops at `maxZoom` (byte 101) and the string
 * `minLon` does not appear anywhere in the package, so every archive it writes carries
 * `0,0,0,0`. The `pmtiles` reader then logs *"Bounds of PMTiles archive 0,0,0,0 are not valid"*
 * and hands a renderer a degenerate box in its TileJSON — and a renderer uses source bounds to
 * decide which tiles are worth asking for.
 *
 * It surfaced as a console error in the browser scenario, not from reading the writer. Worth
 * noting how it was missed: the metadata blob's `bounds` **were** correct and were verified, and
 * the header's are a different field entirely. Checking one and reporting "bounds" was true of
 * what was checked and wrong about the archive.
 *
 * Written **through the sink**, after `commit`, because the header is written last and the sink
 * already has the random-access operation this needs. The bounds are validated by the caller
 * before any of this runs, so there is no path here that can decline to write them.
 *
 * **`centreZoom` is derived from the tiles, not read from the metadata.** It is a `uint8`, and
 * `setUint8` truncates modulo 256 rather than refusing, so `minzoom: 300` in a metadata blob
 * would have written a centre zoom of 44 with nothing said. The shallowest tile actually
 * written cannot disagree with the archive and needs no separate check to be in range: every
 * tile passed through `zxyToTileID`, which refuses a zoom above 26 — beyond that the ids stop
 * being safe integers, and the sort and duplicate check this writer relies on would fail
 * silently.
 *
 * @param {{ write: (data: Uint8Array, offset: number) => Promise<void> }} sink
 * @param {{ west: number, south: number, east: number, north: number }} box
 * @param {number} centreZoom The shallowest zoom in the archive; `0 <= centreZoom <= 26`.
 */
async function writeHeaderBounds(sink, box, centreZoom) {
  const patch = new Uint8Array(25);
  const view = new DataView(patch.buffer);
  const at = (offset) => offset - HEADER_BOUNDS.minLon;
  view.setInt32(at(HEADER_BOUNDS.minLon), Math.round(box.west * E7), true);
  view.setInt32(at(HEADER_BOUNDS.minLat), Math.round(box.south * E7), true);
  view.setInt32(at(HEADER_BOUNDS.maxLon), Math.round(box.east * E7), true);
  view.setInt32(at(HEADER_BOUNDS.maxLat), Math.round(box.north * E7), true);
  view.setUint8(at(HEADER_BOUNDS.centreZoom), centreZoom);
  view.setInt32(at(HEADER_BOUNDS.centreLon), Math.round(((box.west + box.east) / 2) * E7), true);
  view.setInt32(at(HEADER_BOUNDS.centreLat), Math.round(((box.south + box.north) / 2) * E7), true);
  await sink.write(patch, HEADER_BOUNDS.minLon);
}
