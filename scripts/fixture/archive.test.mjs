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

    await expect(writeArchive(path, tiles, { name: "fixture" })).resolves.toEqual({
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

    await writeArchive(forward, tiles, { name: "fixture" });
    await writeArchive(reversed, [...tiles].reverse(), { name: "fixture" });

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
      { name: "fixture" },
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
        {},
      ),
    ).rejects.toThrow(/14\/8504\/5839 was supplied more than once/);
  });

  it("refuses by throwing an ArchiveError, not by failing incidentally", async () => {
    // The type matters as much as the message: a validation that "works" because some later
    // line happens to throw a TypeError would read the same in a message assertion, and would
    // stop working the moment that line changed.
    await expect(
      writeArchive(scratch(), [{ z: 0, x: 0, y: 0, bytes: new Uint8Array(0) }], {}),
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
        {},
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
      writeArchive(scratch(), [{ ...tile, bytes: payload(0, 0, 0) }], {}),
    ).rejects.toThrow(expected);
  });

  it("refuses a zero-byte payload, because that is not how absence is written", async () => {
    // A tile never written reads back as `undefined`; a zero-byte tile would put something at
    // the address that is neither data nor absence, and obligation 3 rests on the distinction.
    await expect(
      writeArchive(scratch(), [{ z: 0, x: 0, y: 0, bytes: new Uint8Array(0) }], {}),
    ).rejects.toThrow(/an absent tile is written by not writing it/);
  });

  it("refuses an empty tile set rather than producing an empty archive", async () => {
    await expect(writeArchive(scratch(), [], {})).rejects.toThrow(/no tiles/);
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
      writeArchive(scratch(), [{ z: 0, x: 0, y: 0, bytes: payload(0, 0, 0) }], {}, options),
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
      writeArchive(
        path,
        [{ z: 0, x: 0, y: 0, bytes: payload(0, 0, 0) }],
        {},
        { createSink: failing },
      ),
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
    await writeArchive(path, TILES, { name: "fixture", attribution: "a notice" });
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

  it("carries the metadata it was given", async () => {
    const { archive } = openIndependently(path);
    expect(await archive.getMetadata()).toMatchObject({ name: "fixture", attribution: "a notice" });
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
    await writeArchive(path, TILES, { name: "fixture" });
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
