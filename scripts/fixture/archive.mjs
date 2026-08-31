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

  /** @type {Map<number, { z: number, x: number, y: number, bytes: Uint8Array }>} */
  const byId = new Map();
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
  }
  if (byId.size === 0) {
    throw new ArchiveError("refusing to write an archive with no tiles");
  }

  const writer = new S2PMTilesWriter(
    createSink(path),
    TILE_TYPES[tileType],
    COMPRESSIONS[compression],
  );
  for (const id of [...byId.keys()].sort((a, b) => a - b)) {
    const { z, x, y, bytes } = /** @type {{z: number, x: number, y: number, bytes: Uint8Array}} */ (
      byId.get(id)
    );
    await writer.writeTileXYZ(z, x, y, bytes);
  }
  await writer.commit(metadata);

  return { path, tileCount: byId.size };
}
