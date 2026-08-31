// SPDX-License-Identifier: Apache-2.0

/**
 * The real implementations behind the build's fetching seams (T4.6).
 *
 * `build.mjs` takes `probe` and `readTile` as injected functions so its ordering is testable
 * with no network. This is where those two are bound to the actual source: an HTTP range read
 * against the GLO-30 bucket, and `readTerrariumCrop`. It exists as its own module rather than
 * inline in the build for the same reason the seams exist at all — the build's tests never want
 * these, and these want tests the build's suite cannot give them.
 *
 * It also binds the archive writer: `createArchiveWriter` composes the metadata each archive
 * carries and projects it onto the `entries()` view the licence checks assert over, so
 * `archive.mjs` stays ignorant of licences and the build stays ignorant of PMTiles.
 */

import { parseTileId } from "./coverage.mjs";
import { parseBounds } from "./region.mjs";
import { writeArchive } from "./archive.mjs";
import { LICENCE_ENTRY_PATH, NOT_FOR_DISTRIBUTION_PATH } from "./licence.mjs";
import { cogUrl, readTerrariumCrop } from "./source.mjs";
import { decodeElevation } from "./terrarium.mjs";

/** Degrees per source tile, both axes — GLO-30 Public ships 1°×1° cells. */
const TILE_DEGREES = 1;

/**
 * A range reader over `fetch`, which checks that it was **given the interval it asked for**.
 *
 * A status alone proves nothing about which bytes arrived, and every way of being wrong here
 * decodes into plausible terrain rather than into an error:
 *
 * - **200 is refused, not accepted.** A server or proxy that does not honour `Range` answers 200
 *   with the *whole* 42 MB object. The header parse would then succeed against byte 0 — it is
 *   the same object — and a tile read would take its bytes from the file's start.
 * - **`Content-Range`'s first byte must be the one requested.** A 206 carrying a correctly sized
 *   window from the wrong offset is the worst case available: the length checks out, `inflate`
 *   succeeds because another internal tile is also a valid deflate stream, and the result is a
 *   real piece of terrain in the wrong place.
 * - **The body's length must match what `Content-Range` claims.** Checked against the header
 *   rather than against the request, for the reason below.
 *
 * Stated as one rule rather than a list of policies: the returned interval must equal the
 * **requested interval intersected with the representation** — `first === start` and
 * `last === min(endInclusive, total - 1)` — with the body carrying exactly that many bytes.
 * A range answered short at the end of an object is legitimate under it (a 64 KB header window
 * over a smaller object comes back smaller), while truncation mid-object, an over-long response
 * and a reversed interval all fail without needing a rule of their own.
 *
 * Throws on all of these, because every caller of *this* wants the bytes and has no use for a
 * status. That is the opposite of what {@link createProbe} needs, and the two are deliberately
 * separate functions rather than one with a flag — see there.
 *
 * @param {typeof globalThis.fetch} [fetchImpl]
 * @returns {(url: string, start: number, endInclusive: number) => Promise<Uint8Array>}
 */
export function rangeFetcher(fetchImpl = globalThis.fetch) {
  return async (url, start, endInclusive) => {
    const requested = `bytes=${String(start)}-${String(endInclusive)}`;
    const where = `GET ${url} ${requested}`;
    const response = await fetchImpl(url, { headers: { Range: requested } });
    if (response.status !== 206) {
      throw new Error(
        `${where}: expected 206 Partial Content, got HTTP ${String(response.status)} — a range ` +
          `that is not honoured returns the whole object, whose bytes are not the ones asked for`,
      );
    }

    // RFC 9110 form: `bytes <first>-<last>/<complete-length>`.
    const contentRange = response.headers.get("Content-Range");
    const parsed = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange ?? "");
    if (parsed === null) {
      throw new Error(`${where}: answered Content-Range "${String(contentRange)}", unparseable`);
    }
    const first = Number(parsed[1]);
    const last = Number(parsed[2]);
    const total = Number(parsed[3]);
    if (first !== start) {
      throw new Error(
        `${where}: served from byte ${String(first)}, not ${String(start)} — the right number of ` +
          `bytes from the wrong offset decodes as valid data in the wrong place`,
      );
    }
    // The whole contract in one comparison: the returned interval must be the requested one
    // intersected with the representation. Reaching past the range, stopping short of it
    // mid-object, and a reversed or nonsensical interval all fall out of this rather than
    // needing a policy each — and the legitimate short read at the end of the object is exactly
    // the case where the intersection is shorter than the request.
    const expectedLast = Math.min(endInclusive, total - 1);
    if (last !== expectedLast) {
      throw new Error(
        `${where}: answered bytes ${String(first)}-${String(last)} of ${String(total)}, but the ` +
          `request intersects the object at ${String(first)}-${String(expectedLast)}`,
      );
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    const claimed = last - first + 1;
    if (bytes.length !== claimed) {
      throw new Error(
        `${where}: Content-Range claims ${String(claimed)} bytes, body carries ${String(bytes.length)}`,
      );
    }
    return bytes;
  };
}

/**
 * The coverage probe: one cheap range request per tile, reporting its **status**.
 *
 * **It must not reuse {@link rangeFetcher}**, and this is the whole reason the two exist
 * separately. A reader that throws on a non-2xx turns a 404 into a thrown error, and
 * `assertCoverage` classifies a thrown probe as `unreachable` — so an unpublished tile would
 * arrive as a transport failure, telling a reader to retry a tile that will never exist and
 * hiding the one case the coverage snapshot exists to name. The status has to survive as data.
 *
 * A genuine transport failure still throws, from `fetch` itself, and is classified as such.
 *
 * @param {typeof globalThis.fetch} [fetchImpl]
 * @param {string} [bucketUrl]
 * @returns {(tileId: string) => Promise<{ status: number }>}
 */
export function createProbe(fetchImpl = globalThis.fetch, bucketUrl) {
  return async (tileId) => {
    // One byte, because presence is the question. A present object answers 206 to this and a
    // withheld one answers 404; `assertCoverage` accepts 200 and 206 and nothing else.
    const response = await fetchImpl(cogUrl(tileId, bucketUrl), {
      headers: { Range: "bytes=0-0" },
    });
    // Release the body rather than walking away from it. Only the status is wanted, but an
    // unread body keeps its connection checked out of the agent's pool; over one probe per
    // required tile, serially, that is how a build ends up waiting on connection reuse for
    // bytes nobody will ever read. `body` is null when there is nothing to release.
    if (response.body !== null && response.body !== undefined) await response.body.cancel();
    return { status: response.status };
  };
}

/**
 * The part of a cut that falls inside one source tile.
 *
 * A cut spanning two cells cannot hand its full bounds to either of them — the crop would start
 * before the raster's first column and be rejected as outside the tile. Each tile is asked only
 * for its own share.
 *
 * The shares meet exactly, and that is a property of the **pair** rather than of either clip:
 * `cropWindow` is half-open at its east and south edges, so the column exactly on a shared
 * meridian belongs to the tile east of it and to that tile only. No sample is read twice and
 * none is missed. `requiredTiles` uses the same half-open rule for deciding which cells a cut
 * needs, which is what keeps the two from disagreeing.
 *
 * @param {[west: number, south: number, east: number, north: number]} bounds
 * @param {string} tileId
 * @returns {[west: number, south: number, east: number, north: number]}
 */
export function clipBoundsToTile(bounds, tileId) {
  const [west, south, east, north] = parseBounds(bounds, "cut bounds");
  const cell = parseTileId(tileId);
  return [
    Math.max(west, cell.west),
    Math.max(south, cell.south),
    Math.min(east, cell.west + TILE_DEGREES),
    Math.min(north, cell.south + TILE_DEGREES),
  ];
}

/**
 * Bind the build's fetching seams to the real source.
 *
 * **`readTile` takes the bounds per call rather than closing over them**, and that is a
 * correction rather than a style choice. Binding them at construction meant the caller chose an
 * extent once, while the build chooses one *later* — the production envelope, computed from the
 * declaration and the zoom range. The two silently disagreed: a cell east of the declared region
 * was admitted by coverage over the envelope and then clipped against the declaration, producing
 * a degenerate box. The build owns the extent, so the build passes it.
 *
 * @param {{
 *   fetchImpl?: typeof globalThis.fetch,
 *   bucketUrl?: string,
 * }} options
 * @returns {{
 *   probe: (tileId: string) => Promise<{ status: number }>,
 *   readTile: (tileId: string, bounds: [number, number, number, number]) => Promise<object>,
 * }}
 */
export function createSourceDeps({ fetchImpl = globalThis.fetch, bucketUrl } = {}) {
  const fetchRange = rangeFetcher(fetchImpl);
  return {
    probe: createProbe(fetchImpl, bucketUrl),
    // Returns the **crop**, not a stream of triples. The build needs the same read twice: once
    // for the floor check and once to stitch the source surface, and reading a 42 MB object
    // twice to avoid holding a 4 MB crop would be a poor trade. `elevationsOf` adapts it for
    // the floor check, which is the only consumer that wants samples one at a time.
    readTile: async (tileId, bounds) =>
      // Each tile is read for **its own** clipped share. Reading the cut's first tile every
      // time would decode successfully and report every other tile's name against the first
      // tile's samples.
      readTerrariumCrop(tileId, clipBoundsToTile(bounds, tileId), { fetchRange, bucketUrl }),
  };
}

/**
 * A crop's samples in metres, lazily, for the floor check.
 *
 * @param {{ rgb: Uint8Array }} crop
 * @returns {Iterable<number>}
 */
export function* elevationsOf(crop) {
  for (let i = 0; i < crop.rgb.length; i += 3) {
    yield decodeElevation(crop.rgb[i], crop.rgb[i + 1], crop.rgb[i + 2]);
  }
}

/** Where the archive's non-licence metadata is asserted to live, for the attribution check. */
export const METADATA_ENTRY_PATH = "metadata.json";

/**
 * The build's `writeArchive` seam, over a real PMTiles archive.
 *
 * Two jobs, and keeping them here is what lets `archive.mjs` stay ignorant of licences. It
 * composes the archive's JSON metadata from what the build hands it, and it exposes the
 * `entries()` view the licence and attribution checks assert over — a PMTiles archive has tiles
 * and a metadata blob rather than named files, so "what the archive carries" has to be projected
 * onto that shape somewhere, and the writer is the wrong place for it.
 *
 * The attribution strings must land **outside** the `LICENSE` entry, which is why the licence
 * text and the rest of the metadata are separate entries rather than one blob: they are drawn
 * from the licence, so a single entry containing both would satisfy the check by carrying the
 * document the strings came from.
 *
 * The payload type and compression arrive **per call**, in `meta`, because one build writes more
 * than one archive and they differ: PNG terrain uncompressed, MVT contours gzipped. Binding them
 * when the writer is constructed would mean two writers, and a caller choosing between them.
 */
export function createArchiveWriter() {
  return async (path, tiles, meta) => {
    const { licenceText, attribution, distributable, tileType, compression, ...rest } = meta;
    // A development archive carries the marker **in the archive**, not merely in its filename.
    // The `.dev` suffix is a naming convention and a rename away from being nothing; a key
    // inside the metadata travels with the bytes. That is the obligation a non-distributable
    // build trades the licence checks for, so it has to be as hard to lose.
    const metadata = distributable
      ? { ...rest, attribution }
      : {
          ...rest,
          [NOT_FOR_DISTRIBUTION_PATH]: "built without the licence checks; do not publish",
        };
    await writeArchive(
      path,
      tiles,
      distributable ? { ...metadata, license: licenceText } : metadata,
      { tileType, compression },
    );
    return {
      entries: () =>
        distributable
          ? [
              { path: LICENCE_ENTRY_PATH, text: licenceText },
              { path: METADATA_ENTRY_PATH, text: JSON.stringify(metadata) },
            ]
          : [
              { path: NOT_FOR_DISTRIBUTION_PATH, text: metadata[NOT_FOR_DISTRIBUTION_PATH] },
              { path: METADATA_ENTRY_PATH, text: JSON.stringify(metadata) },
            ],
    };
  };
}
