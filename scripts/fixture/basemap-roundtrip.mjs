// SPDX-License-Identifier: Apache-2.0

/**
 * The basemap round-trip proof — T7.1 increment 4, and **only** the proof.
 *
 * The plan makes the rest of the increment conditional on this: "the first increment that touches
 * it must prove a round-trip before anything is built on it, and if it fails, that is a finding to
 * report rather than a reason to add a Go binary without a ruling." No style layers, no licence
 * integration, no demo wiring here.
 *
 * **What it establishes, and each of these is asserted rather than printed.**
 * 1. The upstream is *the pinned build*. The metadata row is fetched and its tuple compared, and
 *    every range response's `Content-Range` total is checked against the published size — so a
 *    different, perfectly valid archive at the same URL fails instead of passing.
 * 2. Only range requests occur. Any non-206 aborts, and the bytes read are counted against 137 GB.
 * 3. The tile-coordinate set for the declared bounds and zooms is enumerated up front, so "every
 *    tile" is a closed set rather than whatever the reader happened to return.
 * 4. Every tile upstream has is written and read back through `pmtiles` 4.5.0 **byte for byte**;
 *    coordinates never written stay absent.
 * 5. The output header — bounds, zoom range, tile type, compression — and the **whole metadata
 *    document**, including v4 `vector_layers`, attribution and Planetiler provenance, are what
 *    the intended transformation says they should be. Not all of these *survive*: bounds and the
 *    zoom range are narrowed to the declared region, and the stored compression is **chosen**
 *    rather than carried — upstream stores gzip and this extract stores none. Only the metadata
 *    document and the tile type pass through unchanged.
 * 6. The extract is byte-deterministic: its SHA-256 is compared with a recorded constant.
 *
 * **File size is deliberately not one of those checks.** `s2-pmtiles` pads the region before the
 * tile data — header, root directory and JSON metadata — to a multiple of 16 KiB, so removing
 * 7.5 KB of metadata leaves the file exactly the same length (1,604,280 bytes; 1,604,280 −
 * 1,505,976 = 98,304 = 6 × 16,384). A size assertion would therefore pass over a metadata
 * document that had been gutted. The hash is the integrity signal; the size is a log line.
 *
 * **Nothing is committed and nothing is written into the repo** — the extract goes to a temporary
 * directory and is removed in a `finally`, per `CLAUDE.md`'s no-bundled-tiles rule.
 *
 * **`--mutate=` exists so the proof can be disproved.** Each of `drop`, `alter`, `invent`,
 * `header`, `metadata` and `compression` changes one property the proof claims, and a run with
 * any of them must fail. They are not all corruption: `compression` produces a perfectly valid
 * gzip archive that every tile and metadata comparison passes, and it fails because the encoding
 * is not the one this build declares. A comparison that cannot fail is not evidence.
 *
 * Run: `node scripts/fixture/basemap-roundtrip.mjs
 * [--mutate=drop|alter|invent|header|metadata|compression]`
 */

import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { argv } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { PMTiles } from "pmtiles";

import { writeArchive } from "./archive.mjs";

/**
 * The pinned build.
 *
 * **A named build, not "latest".** Retention on the daily bucket is the past week plus the final
 * build of each superseded patch version; `20260811` is the retained final build of v4.15.1, so it
 * stays addressable after its week. `blake3` is the **published** hash from the build metadata,
 * used to identify the row — this script does not recompute BLAKE3 over 137 GB, and comparing a
 * metadata row is not source-byte verification.
 */
export const PIN = Object.freeze({
  key: "20260811.pmtiles",
  url: "https://build.protomaps.com/20260811.pmtiles",
  version: "4.15.1",
  publishedSize: 137_295_889_397,
  publishedBlake3: "b2aa7f4b1858ec873bd2fb6aff1393ce330ad4d236f2b4f9ad1875e910c1eb8e",
  metadataUrl: "https://build-metadata.protomaps.dev/builds.json",
});

/** The declared region — `fixtures/vertical/region.json`, read rather than restated. */
const REGION_PATH = new URL("../../fixtures/vertical/region.json", import.meta.url);

/** The basemap's zoom range. The fixture's own z11–12 is the terrain's; a basemap a person can
 *  zoom out of needs more, and the plan names z8–14 against an upstream serving z0–15. */
export const MIN_ZOOM = 8;
export const MAX_ZOOM = 14;

/**
 * The extract's SHA-256, recorded so the whole pipeline is pinned end to end.
 *
 * Not BLAKE3: no `b3sum` is available here and a hand-rolled implementation would be worse than
 * none. SHA-256 over a 1.6 MB artefact answers the same question — did this build produce exactly
 * the bytes the last one did.
 */
export const EXPECTED_EXTRACT_SHA256 =
  "dfc2b162339a72b30db0d8ab868b2a6b1e61af0ddd3d6a0905b449b0d4b357cf";

const lonToX = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
const latToY = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
};

/**
 * Every tile covering `bounds` at each zoom, as a closed, ordered set.
 *
 * This decides every byte the build fetches, so it is exported and has a fast, network-free
 * oracle in `basemap-roundtrip.test.mjs`: a live run over one interior box cannot tell an
 * off-by-one from a correct enumeration, because the round trip is self-consistent either way.
 *
 * `y` grows southward, so the **north** edge is the low index — the orientation an enumeration
 * written from longitude alone gets backwards.
 */
export function enumerateTiles(bounds, minZoom, maxZoom) {
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

/**
 * The metadata the extract carries.
 *
 * **Upstream's document is preserved whole**, not reduced to what today's demo happens to read.
 * `vector_layers` is the v4 schema every style layer will be written against; `attribution` is a
 * licence obligation; the `planetiler:*` keys are the provenance that says which OSM replication
 * sequence these tiles came from. An extract that dropped them would render identically and be
 * untraceable.
 *
 * Two keys are added, and **nothing here reads a clock** — the extract has to be byte-identical
 * across runs for its hash to mean anything.
 */
export function extractMetadata(upstream, region) {
  return {
    ...upstream,
    // `writeArchive` requires this and writes it into the header.
    bounds: region.bounds,
    "mapatlas:source": {
      key: PIN.key,
      url: PIN.url,
      version: PIN.version,
      size: PIN.publishedSize,
      blake3: PIN.publishedBlake3,
    },
    "mapatlas:region": {
      id: region.id,
      bounds: region.bounds,
      minZoom: MIN_ZOOM,
      maxZoom: MAX_ZOOM,
    },
  };
}

/** Confirm the URL is serving the build we pinned, before a single tile is read. */
async function assertPinnedBuild() {
  const response = await fetch(PIN.metadataUrl);
  if (!response.ok) throw new Error(`build metadata ${String(response.status)}`);
  const rows = await response.json();
  const row = rows.find((r) => r.key === PIN.key);
  if (row === undefined) {
    throw new Error(`${PIN.key} is no longer listed in the build metadata — the pin has aged out`);
  }
  const mismatches = [];
  if (row.size !== PIN.publishedSize) mismatches.push(`size ${String(row.size)}`);
  if (row.b3sum !== PIN.publishedBlake3) mismatches.push(`b3sum ${String(row.b3sum)}`);
  if (row.version !== PIN.version) mismatches.push(`version ${String(row.version)}`);
  if (mismatches.length > 0) {
    throw new Error(
      `the metadata row for ${PIN.key} no longer matches the pin: ${mismatches.join(", ")}`,
    );
  }
  return row;
}

/**
 * A `pmtiles` Source that refuses anything but a range response over the pinned object.
 *
 * Two assertions per request, both of which a passing round trip would otherwise hide: a 200
 * means the server ignored `Range` and is sending 137 GB, and a `Content-Range` total other than
 * the published size means a *different archive* is being read — one that could still round-trip
 * perfectly.
 */
function pinnedRangeSource(url, tally) {
  return {
    getKey: () => url,
    getBytes: async (offset, length) => {
      const range = `bytes=${String(offset)}-${String(offset + length - 1)}`;
      const response = await fetch(url, { headers: { Range: range } });
      if (response.status !== 206) {
        throw new Error(
          `expected 206 for ${range}, got ${String(response.status)} — a non-range response means ` +
            `the whole archive is being sent`,
        );
      }
      const header = response.headers.get("content-range") ?? "";
      const parsed = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(header);
      if (parsed === null) throw new Error(`unparseable Content-Range ${JSON.stringify(header)}`);
      if (Number(parsed[3]) !== PIN.publishedSize) {
        throw new Error(
          `the object at ${url} is ${parsed[3]} bytes, not the pinned ${String(PIN.publishedSize)} — ` +
            `this is a different archive`,
        );
      }
      if (Number(parsed[1]) !== offset) {
        throw new Error(`asked for byte ${String(offset)}, served from ${parsed[1]}`);
      }
      const data = await response.arrayBuffer();
      tally.requests += 1;
      tally.bytes += data.byteLength;
      return { data };
    },
  };
}

/** A Source over bytes already in memory, for reading the extract back. */
function bufferSource(name, bytes) {
  return {
    getKey: () => name,
    getBytes: async (offset, length) =>
      Promise.resolve({ data: bytes.buffer.slice(offset, offset + length) }),
  };
}

const sameBytes = (a, b) => a.length === b.length && a.every((byte, i) => byte === b[i]);

export async function runProof({ mutate, log = console.log } = {}) {
  const region = JSON.parse(await readFile(REGION_PATH, "utf8"));
  const wanted = enumerateTiles(region.bounds, MIN_ZOOM, MAX_ZOOM);
  const failures = [];

  const row = await assertPinnedBuild();
  log(`pin           ${PIN.key} v${PIN.version} — metadata row matches`);
  log(`              size ${String(row.size)}, published blake3 ${row.b3sum}`);
  log(`              (published hash, not recomputed over 137 GB by this script)`);
  log(`region        ${region.id} ${JSON.stringify(region.bounds)}`);
  log(
    `zooms         ${String(MIN_ZOOM)}-${String(MAX_ZOOM)}, tiles wanted ${String(wanted.length)}`,
  );

  const tally = { requests: 0, bytes: 0 };
  const upstream = new PMTiles(pinnedRangeSource(PIN.url, tally));
  const upstreamHeader = await upstream.getHeader();
  const upstreamMetadata = await upstream.getMetadata();
  log(
    `upstream      z${String(upstreamHeader.minZoom)}-${String(upstreamHeader.maxZoom)}, ` +
      `tileType ${String(upstreamHeader.tileType)}, ${String(Object.keys(upstreamMetadata).length)} metadata keys`,
  );

  const present = [];
  const absent = [];
  for (const { z, x, y } of wanted) {
    const tile = await upstream.getZxy(z, x, y);
    if (tile === undefined) absent.push({ z, x, y });
    else present.push({ z, x, y, bytes: new Uint8Array(tile.data) });
  }
  log(`upstream has  ${String(present.length)} present, ${String(absent.length)} absent`);
  log(
    `range reads   ${String(tally.requests)} requests, ${String(tally.bytes)} bytes ` +
      `(${(tally.bytes / 1e6).toFixed(2)} MB of ${(PIN.publishedSize / 1e9).toFixed(1)} GB)`,
  );
  if (present.length === 0) throw new Error("no tile of the declared region is present upstream");

  const dir = await mkdtemp(join(tmpdir(), "mapatlas-basemap-"));
  const path = join(dir, "basemap.pmtiles");
  try {
    let writing = present;
    let metadata = extractMetadata(upstreamMetadata, region);
    let tileType = "mvt";
    let compression = "none";

    if (mutate === "drop") writing = present.slice(1);
    if (mutate === "alter") {
      writing = present.map((t, i) =>
        i === 0
          ? { ...t, bytes: Uint8Array.from([...t.bytes.slice(0, -1), t.bytes.at(-1) ^ 1]) }
          : t,
      );
    }
    if (mutate === "invent") {
      const stray = {
        z: MAX_ZOOM,
        x: lonToX(region.bounds[0], MAX_ZOOM) - 2,
        y: latToY(region.bounds[3], MAX_ZOOM),
      };
      writing = [...present, { ...stray, bytes: present[0].bytes }];
    }
    if (mutate === "header") tileType = "png";
    if (mutate === "compression") compression = "gzip";
    if (mutate === "metadata") {
      metadata = { ...metadata };
      delete metadata["vector_layers"];
    }
    if (mutate !== undefined) log(`MUTATION      ${mutate}`);

    const written = await writeArchive(path, writing, metadata, { tileType, compression });

    const bytes = await readFile(path);
    const size = (await stat(path)).size;
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const extract = new PMTiles(bufferSource(path, bytes));
    const outHeader = await extract.getHeader();
    const outMetadata = await extract.getMetadata();

    log(`extract       ${String(written.tileCount)} tiles, ${String(size)} bytes`);
    log(`extract sha256 ${sha256}`);
    log(
      `extract meta  offset ${String(outHeader.jsonMetadataOffset)}, ` +
        `length ${String(outHeader.jsonMetadataLength)}, tileData ${String(outHeader.tileDataLength)}`,
    );

    for (const tile of present) {
      const back = await extract.getZxy(tile.z, tile.x, tile.y);
      if (back === undefined) {
        failures.push(`${String(tile.z)}/${String(tile.x)}/${String(tile.y)} missing from extract`);
      } else if (!sameBytes(tile.bytes, new Uint8Array(back.data))) {
        failures.push(`${String(tile.z)}/${String(tile.x)}/${String(tile.y)} differs`);
      }
    }
    for (const tile of absent) {
      if ((await extract.getZxy(tile.z, tile.x, tile.y)) !== undefined) {
        failures.push(`${String(tile.z)}/${String(tile.x)}/${String(tile.y)} invented by extract`);
      }
    }

    /** A control, because the loop above is vacuous when upstream has every tile of the region. */
    const neverWritten = [
      {
        z: MAX_ZOOM,
        x: lonToX(region.bounds[0], MAX_ZOOM) - 2,
        y: latToY(region.bounds[3], MAX_ZOOM),
      },
      {
        z: MAX_ZOOM,
        x: lonToX(region.bounds[2], MAX_ZOOM) + 2,
        y: latToY(region.bounds[1], MAX_ZOOM),
      },
    ];
    for (const tile of neverWritten) {
      if ((await extract.getZxy(tile.z, tile.x, tile.y)) !== undefined) {
        failures.push(
          `${String(tile.z)}/${String(tile.x)}/${String(tile.y)} was never written yet the extract answers for it`,
        );
      }
    }
    log(`controls      ${String(neverWritten.length)} unwritten coordinates checked absent`);

    // --- header, asserted rather than printed ---
    if (outHeader.minZoom !== MIN_ZOOM)
      failures.push(`header minZoom ${String(outHeader.minZoom)}`);
    if (outHeader.maxZoom !== MAX_ZOOM)
      failures.push(`header maxZoom ${String(outHeader.maxZoom)}`);
    if (outHeader.tileType !== upstreamHeader.tileType) {
      failures.push(
        `header tileType ${String(outHeader.tileType)} != upstream ${String(upstreamHeader.tileType)}`,
      );
    }
    /**
     * Compression, asserted rather than named — and it pins an **encoding choice**, not validity.
     *
     * Two earlier versions of this comment were wrong, in opposite directions. The first claimed
     * a gzip label over raw tiles; `writeArchive` asks the writer to gzip, so `--mutate=compression`
     * yields a perfectly valid archive — 1,138,892 bytes, every tile and metadata comparison
     * passing. The second said the encoding could change "with nothing red"; it could not, because
     * the recorded SHA-256 below moves with it.
     *
     * What this assertion is actually for: it states the `none` policy **semantically**, where the
     * hash only pins whatever bytes the last baseline happened to have. A deliberate re-baseline
     * of that hash — after a legitimate change elsewhere — would otherwise bless a changed
     * encoding in passing, and the failure would read as "the extract moved" rather than "the
     * extract is stored differently now". `getZxy` decompresses on the way out, so the byte
     * comparison above cannot see this at all.
     */
    if (outHeader.tileCompression !== 1) {
      failures.push(
        `header tileCompression ${String(outHeader.tileCompression)}, expected 1 (none) — the ` +
          `extract's encoding is pinned, and a change to it moves the archive's bytes`,
      );
    }
    const bounds = [outHeader.minLon, outHeader.minLat, outHeader.maxLon, outHeader.maxLat];
    if (bounds.some((v, i) => Math.abs(v - region.bounds[i]) > 1e-6)) {
      failures.push(`header bounds ${JSON.stringify(bounds)} != ${JSON.stringify(region.bounds)}`);
    }

    // --- metadata, compared as a whole document ---
    const expected = extractMetadata(upstreamMetadata, region);
    if (JSON.stringify(outMetadata) !== JSON.stringify(expected)) {
      const lost = Object.keys(expected).filter((k) => !(k in outMetadata));
      failures.push(
        lost.length > 0
          ? `metadata lost ${lost.join(", ")}`
          : "metadata differs from the intended transformation",
      );
    } else {
      log(
        `metadata      ${String(Object.keys(outMetadata).length)} keys preserved, incl. vector_layers`,
      );
    }

    if (mutate === undefined && sha256 !== EXPECTED_EXTRACT_SHA256) {
      failures.push(`extract sha256 ${sha256} != recorded ${EXPECTED_EXTRACT_SHA256}`);
    }

    if (failures.length > 0) {
      log(`\nFAILED (${String(failures.length)}):`);
      for (const f of failures.slice(0, 10)) log(`  ${f}`);
      return { ok: false, failures, sha256 };
    }
    log(
      `\nOK  ${String(present.length)} tiles byte-identical, header and metadata preserved, extract deterministic`,
    );
    return { ok: true, failures, sha256 };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Only when run directly: importing this module for its pure exports must not hit the network.
if (
  argv[1] !== undefined &&
  import.meta.url === pathToFileURL(fileURLToPath(pathToFileURL(argv[1]).href)).href
) {
  const mutate = argv.find((a) => a.startsWith("--mutate="))?.split("=")[1];
  const result = await runProof({ mutate });
  if (!result.ok) process.exitCode = 1;
}
