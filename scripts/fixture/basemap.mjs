// SPDX-License-Identifier: Apache-2.0

/**
 * The basemap stage: read a pinned Protomaps build by range and cut the declared region out of it
 * (T7.1 increment 4a; ADR-0038).
 *
 * **Nothing here fetches directly.** `fetchImpl` is injected exactly as it is for the Copernicus
 * reader, so the whole stage is exercised in the suite against a synthetic upstream with no
 * network. A stage only a live run can reach is a stage CI never runs.
 *
 * **The pin is data, not a constant.** It arrives as the parsed `fixtures/basemap/pin.json`, which
 * is what lets the suite point the same code at a synthetic archive of its own size and hash. A
 * pin compiled into this module would have forced the tests either onto the network or onto a
 * different code path from the one that ships.
 *
 * The round-trip this stage depends on — that `pmtiles` reads the upstream by range and the tiles
 * survive a re-write byte for byte — was proved before any of it was built:
 * `basemap-roundtrip.mjs`, run against the real build.
 */

import { PMTiles } from "pmtiles";

/** Slippy coordinates. `y` grows southward, so the north edge is the low index. */
const lonToX = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
const latToY = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
};

/**
 * Every tile covering `bounds` at each zoom, as a closed, ordered set.
 *
 * Duplicated from neither the terrain path nor the spike: `mercator.mjs`'s `tilesInRange` walks
 * the same lattice, and this is the same computation. It is here rather than imported because the
 * spike's oracle pins *this* function's edge behaviour — clamping at the antimeridian, north on
 * the low index — and the two must not drift silently. If they are ever unified, the oracle moves
 * with it.
 */
export function basemapTiles(bounds, minZoom, maxZoom) {
  const [west, south, east, north] = bounds;
  const tiles = [];
  for (let z = minZoom; z <= maxZoom; z += 1) {
    const span = 2 ** z;
    const clamp = (v) => Math.min(span - 1, Math.max(0, v));
    for (let x = clamp(lonToX(west, z)); x <= clamp(lonToX(east, z)); x += 1) {
      for (let y = clamp(latToY(north, z)); y <= clamp(latToY(south, z)); y += 1) {
        tiles.push({ z, x, y });
      }
    }
  }
  return tiles;
}

export class BasemapPinError extends Error {
  constructor(message) {
    super(message);
    this.name = "BasemapPinError";
  }
}

/**
 * Confirm the URL is serving the build the pin names, **before a single tile is read**.
 *
 * The row is the identity check; it is not source-byte verification and must not be described as
 * one (ADR-0038). Verifying the published BLAKE3 would mean hashing 137 GB to cut two megabytes.
 */
export async function assertPinnedBuild(pin, fetchImpl) {
  const response = await fetchImpl(pin.metadataUrl);
  if (!response.ok) {
    throw new BasemapPinError(
      `build metadata ${String(response.status)} from ${pin.metadataUrl}: the pin cannot be ` +
        `confirmed, and an unconfirmed pin is an unknown upstream`,
    );
  }
  const rows = await response.json();
  const row = Array.isArray(rows) ? rows.find((r) => r?.key === pin.key) : undefined;
  if (row === undefined) {
    throw new BasemapPinError(
      `${pin.key} is no longer listed at ${pin.metadataUrl} — the pin has aged out. Retention is ` +
        `the past week plus the final build of each superseded patch version; pick that build for ` +
        `a version that has been superseded, and record it in fixtures/basemap/pin.json`,
    );
  }
  const wrong = [];
  if (row.size !== pin.size) wrong.push(`size ${String(row.size)} (pinned ${String(pin.size)})`);
  if (row.b3sum !== pin.blake3) wrong.push(`b3sum ${String(row.b3sum)}`);
  if (row.version !== pin.version) wrong.push(`version ${String(row.version)}`);
  if (wrong.length > 0) {
    throw new BasemapPinError(
      `the metadata row for ${pin.key} no longer matches the pin: ${wrong.join(", ")} — this is a ` +
        `different build under the same name`,
    );
  }
  return row;
}

/**
 * A `pmtiles` Source that refuses anything but a range response over the pinned object.
 *
 * Two checks per request, and each catches something a passing extract would otherwise hide: a
 * 200 means the server ignored `Range` and is sending the whole archive, and a `Content-Range`
 * total other than the pinned size means a **different archive** is being read — one that would
 * round-trip perfectly and be the wrong map.
 */
export function pinnedRangeSource(pin, fetchImpl, tally = { requests: 0, bytes: 0 }) {
  return {
    tally,
    getKey: () => pin.url,
    getBytes: async (offset, length) => {
      const range = `bytes=${String(offset)}-${String(offset + length - 1)}`;
      const response = await fetchImpl(pin.url, { headers: { Range: range } });
      if (response.status !== 206) {
        throw new BasemapPinError(
          `expected 206 for ${range} of ${pin.url}, got ${String(response.status)} — a ` +
            `non-range response means the whole archive is being sent`,
        );
      }
      const header = response.headers.get("Content-Range") ?? "";
      const parsed = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(header);
      if (parsed === null) {
        throw new BasemapPinError(`unparseable Content-Range ${JSON.stringify(header)}`);
      }
      const first = Number(parsed[1]);
      const last = Number(parsed[2]);
      const total = Number(parsed[3]);
      if (total !== pin.size) {
        throw new BasemapPinError(
          `the object at ${pin.url} is ${String(total)} bytes, not the pinned ` +
            `${String(pin.size)} — this is a different archive`,
        );
      }
      if (first !== offset) {
        throw new BasemapPinError(
          `served from byte ${String(first)}, not ${String(offset)} — the right number of bytes ` +
            `from the wrong offset decodes as valid data in the wrong place`,
        );
      }
      /**
       * The whole contract in one comparison, the same one `rangeFetcher` states for the terrain
       * reader: the returned interval must be the **requested interval intersected with the
       * representation**. Checking only the first byte and the total left a response that reaches
       * past the range, or stops short of it mid-object, indistinguishable from a correct one —
       * and a short read is legitimate only at the end of the object, which is exactly where the
       * intersection is shorter than the request.
       */
      const expectedLast = Math.min(offset + length - 1, total - 1);
      if (last !== expectedLast) {
        throw new BasemapPinError(
          `answered bytes ${String(first)}-${String(last)} of ${String(total)}, but the request ` +
            `intersects the object at ${String(first)}-${String(expectedLast)}`,
        );
      }
      const data = await response.arrayBuffer();
      // Checked against what `Content-Range` claimed, not against what was asked for: a body
      // shorter than its own header is a truncated transfer, and one longer is a different
      // object being spliced in.
      const claimed = last - first + 1;
      if (data.byteLength !== claimed) {
        throw new BasemapPinError(
          `Content-Range claims ${String(claimed)} bytes, body carries ${String(data.byteLength)}`,
        );
      }
      tally.requests += 1;
      tally.bytes += data.byteLength;
      return { data };
    },
  };
}

/**
 * Read the declared region's tiles out of the pinned build.
 *
 * Returns the tiles, the upstream's metadata document, and what the wire saw. The metadata is
 * returned rather than consumed here because the archive writer owns what the extract carries —
 * this stage's job is to read, and `vector_layers` is the v4 schema 4b's style layers are written
 * against (ADR-0038).
 *
 * @param {object} pin parsed `fixtures/basemap/pin.json`
 * @param {[number, number, number, number]} bounds the declared region
 * @param {typeof globalThis.fetch} fetchImpl
 */
export async function readBasemapRegion(pin, bounds, fetchImpl) {
  await assertPinnedBuild(pin, fetchImpl);

  const source = pinnedRangeSource(pin, fetchImpl);
  const archive = new PMTiles(source);
  const header = await archive.getHeader();
  const metadata = await archive.getMetadata();

  const wanted = basemapTiles(bounds, pin.minZoom, pin.maxZoom);
  const tiles = [];
  const absent = [];
  for (const { z, x, y } of wanted) {
    const tile = await archive.getZxy(z, x, y);
    if (tile === undefined) absent.push({ z, x, y });
    else tiles.push({ z, x, y, bytes: new Uint8Array(tile.data) });
  }
  if (tiles.length === 0) {
    throw new BasemapPinError(
      `the pinned build has no tile of the declared region at z${String(pin.minZoom)}-` +
        `${String(pin.maxZoom)} — the region is outside its coverage, or the zoom range is`,
    );
  }
  return { tiles, absent, metadata, upstreamTileType: header.tileType, read: source.tally };
}
