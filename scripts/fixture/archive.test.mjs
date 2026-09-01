// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PMTiles } from "pmtiles";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ArchiveError, writeArchive } from "./archive.mjs";
import { rangeFetcher } from "./deps.mjs";

let dir;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "mapatlas-archive-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

let n = 0;
const scratch = () => join(dir, `a${String(n++)}.pmtiles`);

/** Payloads that are distinguishable per address, so a mixed-up tile is visible in the bytes. */
const payload = (z, x, y, size = 64) =>
  Uint8Array.from({ length: size }, (_, i) => (z * 7 + x * 13 + y * 29 + i) % 251);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Every archive needs bounds: they go in the header, and a renderer rejects a degenerate box. */
const BOUNDS = [6.825, 45.815, 6.905, 45.865];
const META = { name: "fixture", bounds: BOUNDS, minzoom: 10, maxzoom: 14 };

/** A small, valid tile set for tests whose subject is the metadata rather than the tiles. */
const SOME_TILES = [
  { z: 14, x: 8504, y: 5839, bytes: payload(14, 8504, 5839) },
  { z: 10, x: 531, y: 364, bytes: payload(10, 531, 364) },
];

/**
 * Read an archive through the **independent** reader, sourced through the hardened range path.
 *
 * Two independent implementations agreeing on the spec is the claim, so nothing here touches
 * `s2-pmtiles`. The source goes through `rangeFetcher`, which joins the writer to the reader
 * contract rather than proving the two halves separately.
 */
function openIndependently(path) {
  const total = statSync(path).size;
  const requests = [];
  const fetchImpl = (_url, init) => {
    const [, from, to] = /bytes=(\d+)-(\d+)/.exec(init.headers.Range);
    const start = Number(from);
    const end = Math.min(Number(to), total - 1);
    requests.push([start, end]);
    const slice = readFileSync(path).subarray(start, end + 1);
    return Promise.resolve({
      status: 206,
      headers: {
        get: (name) => (name === "Content-Range" ? `bytes ${start}-${end}/${total}` : null),
      },
      body: { cancel: () => Promise.resolve() },
      arrayBuffer: () =>
        Promise.resolve(slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength)),
    });
  };
  const read = rangeFetcher(fetchImpl);
  const source = {
    getKey: () => path,
    getBytes: async (offset, length) => ({
      data: (await read(path, offset, offset + length - 1)).buffer,
    }),
  };
  return { archive: new PMTiles(source), requests };
}

describe("the writer's contract", () => {
  it("writes the tiles it is given and reports what it wrote", async () => {
    const path = scratch();
    const tiles = [
      { z: 14, x: 8504, y: 5839, bytes: payload(14, 8504, 5839) },
      { z: 14, x: 8505, y: 5839, bytes: payload(14, 8505, 5839) },
      { z: 10, x: 531, y: 364, bytes: payload(10, 531, 364) },
    ];

    await expect(writeArchive(path, tiles, META)).resolves.toEqual({
      path,
      tileCount: 3,
    });
    expect(statSync(path).size).toBeGreaterThan(0);
  });

  it("sorts, so the same tile set produces the same bytes whatever order it arrives in", async () => {
    // The decision recorded in the module: output is a function of the tile set, not of the
    // caller's iteration order. A depth-first pyramid walk and a breadth-first one must not
    // produce different archives from identical data.
    const tiles = [
      { z: 14, x: 8505, y: 5839, bytes: payload(14, 8505, 5839) },
      { z: 10, x: 531, y: 364, bytes: payload(10, 531, 364) },
      { z: 14, x: 8504, y: 5839, bytes: payload(14, 8504, 5839) },
    ];
    const forward = scratch();
    const reversed = scratch();

    await writeArchive(forward, tiles, META);
    await writeArchive(reversed, [...tiles].reverse(), META);

    expect(digest(readFileSync(forward))).toBe(digest(readFileSync(reversed)));
  });

  it("declares the archive clustered, which is what sorting buys", async () => {
    // Named rather than implied: `clustered` is the reader-visible consequence of writing in
    // tile-id order, and asserting the sort only through byte equality would not show it.
    const path = scratch();
    await writeArchive(
      path,
      [
        { z: 14, x: 8505, y: 5839, bytes: payload(14, 8505, 5839) },
        { z: 10, x: 531, y: 364, bytes: payload(10, 531, 364) },
      ],
      META,
    );

    const { archive } = openIndependently(path);
    expect((await archive.getHeader()).clustered).toBe(true);
  });

  it("refuses the same address twice, rather than silently keeping one payload", async () => {
    // Two payloads at one address have no correct resolution; the dependency would keep the
    // last one, which is a silent answer to an ambiguous question.
    await expect(
      writeArchive(
        scratch(),
        [
          { z: 14, x: 8504, y: 5839, bytes: payload(14, 8504, 5839) },
          { z: 14, x: 8504, y: 5839, bytes: payload(1, 1, 1) },
        ],
        META,
      ),
    ).rejects.toThrow(/14\/8504\/5839 was supplied more than once/);
  });

  it("refuses by throwing an ArchiveError, not by failing incidentally", async () => {
    // The type matters as much as the message: a validation that "works" because some later
    // line happens to throw a TypeError would read the same in a message assertion, and would
    // stop working the moment that line changed.
    await expect(
      writeArchive(scratch(), [{ z: 0, x: 0, y: 0, bytes: new Uint8Array(0) }], META),
    ).rejects.toBeInstanceOf(ArchiveError);
  });

  it("refuses a repeated address even when the bytes are identical", async () => {
    // The caller enumerated an address twice, which is a bug whether or not it is harmless here.
    const bytes = payload(14, 8504, 5839);
    await expect(
      writeArchive(
        scratch(),
        [
          { z: 14, x: 8504, y: 5839, bytes },
          { z: 14, x: 8504, y: 5839, bytes },
        ],
        META,
      ),
    ).rejects.toThrow(/more than once/);
  });

  it.each([
    {
      note: "a negative coordinate",
      tile: { z: 14, x: -1, y: 0 },
      expected: /tile x must be a non-negative integer/,
    },
    {
      note: "a fractional zoom",
      tile: { z: 1.5, x: 0, y: 0 },
      expected: /tile z must be a non-negative integer/,
    },
    {
      note: "a coordinate past the zoom's span",
      tile: { z: 1, x: 2, y: 0 },
      expected: /outside zoom 1/,
    },
  ])("refuses $note", async ({ tile, expected }) => {
    await expect(
      writeArchive(scratch(), [{ ...tile, bytes: payload(0, 0, 0) }], META),
    ).rejects.toThrow(expected);
  });

  it("refuses a zero-byte payload, because that is not how absence is written", async () => {
    // A tile never written reads back as `undefined`; a zero-byte tile would put something at
    // the address that is neither data nor absence, and obligation 3 rests on the distinction.
    await expect(
      writeArchive(scratch(), [{ z: 0, x: 0, y: 0, bytes: new Uint8Array(0) }], META),
    ).rejects.toThrow(/an absent tile is written by not writing it/);
  });

  it.each([
    { note: "no bounds at all", bounds: undefined },
    { note: "too few numbers", bounds: [6.8, 45.8, 6.9] },
    { note: "a non-finite edge", bounds: [6.8, 45.8, Number.NaN, 45.9] },
    { note: "reversed longitude", bounds: [6.9, 45.8, 6.8, 45.9] },
    { note: "reversed latitude", bounds: [6.8, 45.9, 6.9, 45.8] },
    // Ordered and finite, and nowhere on Earth. The first is the one that matters most: 300°
    // is 3 × 10⁹ in the header's degrees × 10⁷, past `Int32`'s 2.147 × 10⁹, so it wraps to a
    // negative longitude and the archive claims a box in the opposite hemisphere — a wrong
    // answer rather than a rejected one, which is the shape this whole file exists to refuse.
    { note: "an eastern longitude that wraps the Int32 field", bounds: [200, 45.8, 300, 45.9] },
    { note: "a western longitude past the antimeridian", bounds: [-200, 45.8, -190, 45.9] },
    { note: "a latitude past the north pole", bounds: [6.8, 45.8, 6.9, 91] },
    { note: "a latitude past the south pole", bounds: [6.8, -91, 6.9, 45.9] },
  ])("refuses $note rather than writing a header a renderer rejects", async ({ bounds }) => {
    // **A successful write must mean a renderer-valid archive.** The patcher used to return
    // quietly on any of these, leaving the same `0,0,0,0` header the fix exists to prevent —
    // and `writeArchive` resolving as though it had succeeded.
    await expect(writeArchive(scratch(), SOME_TILES, { ...META, bounds })).rejects.toThrow(
      /metadata\.bounds/,
    );
  });

  it("patches the header through an injected sink too", async () => {
    // Reopening the path would have left every custom sink unpatched — the one case a caller
    // cannot observe, since a fake sink has no file to inspect.
    const writes = [];
    const failing = () => ({
      append: () => Promise.resolve(),
      appendSync: () => {},
      write: (data, offset) => {
        writes.push({ offset, length: data.length });
        return Promise.resolve();
      },
    });

    await writeArchive(scratch(), SOME_TILES, META, { createSink: failing });

    // 102 is where PMTiles v3 keeps `minLon`; 25 bytes covers bounds, centre and centre zoom.
    expect(writes).toContainEqual({ offset: 102, length: 25 });
  });

  it("refuses an empty tile set rather than producing an empty archive", async () => {
    await expect(writeArchive(scratch(), [], META)).rejects.toThrow(/no tiles/);
  });

  it.each([
    { field: "tileType", options: { tileType: "tiff" }, expected: /unknown tile type "tiff"/ },
    {
      field: "compression",
      options: { compression: "lzma" },
      expected: /unknown compression "lzma"/,
    },
  ])("refuses an unknown $field", async ({ options, expected }) => {
    await expect(
      writeArchive(scratch(), [{ z: 0, x: 0, y: 0, bytes: payload(0, 0, 0) }], META, options),
    ).rejects.toThrow(expected);
  });

  it("rejects when finalisation fails, so a caller never treats a partial write as done", async () => {
    // Injected at the sink, which is the seam the failure really occurs at: `commit` writes the
    // header and directories back over the start of the file, and that write is what fails when
    // a disk fills or a handle is revoked. The build promotes `.partial` only on resolution, so
    // a rejection here is what stops a half-written archive being named as the archive.
    const path = scratch();
    const failing = () => ({
      append: () => Promise.resolve(),
      appendSync: () => {},
      write: () => Promise.reject(new Error("no space left on device")),
    });

    await expect(
      writeArchive(path, [{ z: 0, x: 0, y: 0, bytes: payload(0, 0, 0) }], META, {
        createSink: failing,
      }),
    ).rejects.toThrow("no space left on device");
  });
});

describe("the archive reads back through an independent reader", () => {
  const TILES = [
    { z: 14, x: 8504, y: 5839, bytes: payload(14, 8504, 5839, 20000) },
    { z: 14, x: 8505, y: 5839, bytes: payload(14, 8505, 5839, 20000) },
    { z: 10, x: 531, y: 364, bytes: payload(10, 531, 364, 20000) },
  ];
  let path;
  beforeAll(async () => {
    path = scratch();
    await writeArchive(path, TILES, { ...META, attribution: "a notice" });
  });

  it("returns every payload byte-identical to what the writer was given", async () => {
    // Metadata and index correctness say nothing about whether compression or offset
    // construction damaged a payload, which is the failure that reaches a renderer as corrupt
    // terrain rather than as an error.
    const { archive } = openIndependently(path);
    for (const tile of TILES) {
      const got = await archive.getZxy(tile.z, tile.x, tile.y);
      expect(got, `${tile.z}/${tile.x}/${tile.y}`).toBeDefined();
      expect(digest(new Uint8Array(got.data))).toBe(digest(tile.bytes));
    }
  });

  it("reads a tile that was never written as absent, not as empty data", async () => {
    // Obligation 3's second leg: the reader distinguishes absent from present without a
    // sentinel, so a gap cannot be mistaken for a tile carrying nothing.
    const { archive } = openIndependently(path);
    expect(await archive.getZxy(14, 9999, 9999)).toBeUndefined();
  });

  it("declares its geographic bounds in the header, not only in the metadata", async () => {
    // **Two different fields, and only one was ever checked.** The JSON metadata's `bounds` were
    // verified and correct while the header's were `0,0,0,0`, because `s2-pmtiles` never writes
    // them — its `headerToBytes` stops at `maxZoom`. The `pmtiles` reader logs "Bounds of PMTiles
    // archive 0,0,0,0 are not valid" and hands a renderer a degenerate box in its TileJSON, and a
    // renderer uses source bounds to decide which tiles to ask for. Found from a browser console
    // error, not from reading the writer.
    const path = scratch();
    const bounds = [6.825, 45.815, 6.905, 45.865];
    await writeArchive(path, SOME_TILES, { ...META, bounds });

    const header = await openIndependently(path).archive.getHeader();

    expect(header.minLon).toBeCloseTo(bounds[0], 6);
    expect(header.minLat).toBeCloseTo(bounds[1], 6);
    expect(header.maxLon).toBeCloseTo(bounds[2], 6);
    expect(header.maxLat).toBeCloseTo(bounds[3], 6);
    // The reader's own validity rule, asserted as the reader states it.
    expect(header.minLon).toBeLessThan(header.maxLon);
    expect(header.minLat).toBeLessThan(header.maxLat);
  });

  it("writes the centre fields alongside the bounds", async () => {
    // Unpinned until now: a renderer reads `centerLon`/`centerLat` for its initial view, and
    // zeros there put the default camera in the Gulf of Guinea while the bounds looked right.
    const path = scratch();
    await writeArchive(path, SOME_TILES, META);

    const header = await openIndependently(path).archive.getHeader();

    expect(header.centerLon).toBeCloseTo((BOUNDS[0] + BOUNDS[2]) / 2, 6);
    expect(header.centerLat).toBeCloseTo((BOUNDS[1] + BOUNDS[3]) / 2, 6);
    expect(header.centerZoom).toBe(Math.min(...SOME_TILES.map((tile) => tile.z)));
  });

  it("takes the centre zoom from the tiles, so unusable metadata cannot reach a uint8", async () => {
    // **`setUint8` truncates modulo 256 rather than refusing.** The centre zoom used to be
    // `metadata.minzoom`, unvalidated, so `300` would have been written as 44 with nothing said
    // — and the previous test could not see it, because that fixture's `minzoom` happened to
    // equal its shallowest tile. Here the two disagree, so only one of them can be the answer.
    const path = scratch();
    await writeArchive(path, SOME_TILES, { ...META, minzoom: 300 });

    const header = await openIndependently(path).archive.getHeader();

    expect(header.centerZoom).toBe(10);
    expect(header.centerZoom, "a wrapped uint8").not.toBe(300 % 256);
  });

  it("carries the metadata it was given", async () => {
    const { archive } = openIndependently(path);
    expect(await archive.getMetadata()).toMatchObject({ ...META, attribution: "a notice" });
  });

  it("is read entirely through the hardened range path", async () => {
    // The property that joins the writer to the reader contract. Asserted on the requests
    // rather than inferred: every byte the reader saw came through `rangeFetcher`, so a
    // response that lied about its interval would have failed the read rather than been decoded.
    const { archive, requests } = openIndependently(path);
    await archive.getHeader();
    await archive.getZxy(14, 8504, 5839);

    expect(requests.length).toBeGreaterThanOrEqual(2);
    for (const [start, end] of requests) expect(end).toBeGreaterThanOrEqual(start);
  });
});

describe("a corrupted archive fails rather than decoding", () => {
  // Acceptance tests over the finished bytes, not seams inside the writer: these prove the
  // reader/range path refuses damage, which is what protects a consumer. Contorting
  // `writeArchive` with an injectable wrong-offset hook would only be testing what
  // `s2-pmtiles` owns internally.
  const TILES = [
    { z: 14, x: 8504, y: 5839, bytes: payload(14, 8504, 5839, 20000) },
    { z: 10, x: 531, y: 364, bytes: payload(10, 531, 364, 20000) },
  ];

  async function written() {
    const path = scratch();
    await writeArchive(path, TILES, META);
    return path;
  }

  it("refuses a truncated archive", async () => {
    const path = await written();
    const whole = readFileSync(path);
    writeFileSync(path, whole.subarray(0, Math.floor(whole.length / 2)));

    const { archive } = openIndependently(path);
    // Deterministic failure rather than a wrong answer: the tile lives past the new end, and
    // the range read for it cannot be satisfied.
    await expect(archive.getZxy(14, 8504, 5839)).rejects.toThrow();
  });

  it("does not return a tile's bytes when the directory points at the wrong offset", async () => {
    // The corruption that would otherwise be silent: a valid-looking read from the wrong place
    // returns bytes that are real, well-formed and wrong. Detected here as the payload no
    // longer matching what was written.
    const path = await written();
    const whole = readFileSync(path);
    const target = digest(TILES[0].bytes);
    // Shift the tile data region under the index by rotating a payload-sized window.
    const from = whole.length - 20000;
    whole.copy(whole, from, from - 137, whole.length - 137);
    writeFileSync(path, whole);

    const { archive } = openIndependently(path);
    const got = await archive.getZxy(14, 8504, 5839).catch(() => undefined);
    const gotDigest = got === undefined ? "(unreadable)" : digest(new Uint8Array(got.data));
    expect(gotDigest).not.toBe(target);
  });

  it("refuses an archive whose header has been damaged", async () => {
    const path = await written();
    const whole = readFileSync(path);
    whole.writeUInt16LE(0x0000, 0); // the magic
    writeFileSync(path, whole);

    const { archive } = openIndependently(path);
    await expect(archive.getHeader()).rejects.toThrow();
  });
});
