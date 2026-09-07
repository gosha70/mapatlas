// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { assertPinnedBuild, basemapTiles, pinnedRangeSource } from "./basemap.mjs";

/**
 * The pinned range source, against responses a real server can produce.
 *
 * **Every check here is one a passing extract would otherwise hide.** A read from the wrong
 * offset, a response reaching past the range, a truncated body — each yields bytes that decode,
 * and the tiles they produce look like a map. The contract is the same one `rangeFetcher` states
 * for the terrain reader: the returned interval must be the requested interval intersected with
 * the representation, with a body of exactly that length.
 */
const PIN = { url: "https://upstream.invalid/a.pmtiles", size: 1000, key: "a.pmtiles" };

const responder = (over = {}) => {
  return (_url, init) => {
    const [, f, t] = /bytes=(\d+)-(\d+)/.exec(init.headers.Range);
    const start = Number(f);
    const end = Math.min(Number(t), PIN.size - 1);
    const header = over.contentRange?.(start, end) ?? `bytes ${start}-${end}/${PIN.size}`;
    const length = over.bodyLength?.(start, end) ?? end - start + 1;
    return Promise.resolve({
      status: over.status ?? 206,
      headers: { get: (n) => (n === "Content-Range" ? header : null) },
      arrayBuffer: () => Promise.resolve(new Uint8Array(length).fill(7).buffer),
    });
  };
};

const read = (over) => pinnedRangeSource(PIN, responder(over)).getBytes(0, 16);

describe("the pinned range source", () => {
  it("accepts the requested interval", async () => {
    await expect(read()).resolves.toMatchObject({ data: expect.anything() });
  });

  it("accepts a short read at the end of the object", async () => {
    // Legitimate: the intersection is shorter than the request. A rule that demanded the full
    // requested length would fail on the last window of every archive.
    await expect(pinnedRangeSource(PIN, responder()).getBytes(990, 64)).resolves.toBeDefined();
  });

  it("refuses a 200, which means the whole archive is being sent", async () => {
    await expect(read({ status: 200 })).rejects.toThrow(/non-range response/);
  });

  it("refuses an object that is not the pinned size", async () => {
    await expect(read({ contentRange: (s, e) => `bytes ${s}-${e}/999999` })).rejects.toThrow(
      /different archive/,
    );
  });

  it("refuses bytes served from the wrong offset", async () => {
    // The worst case available: the right number of bytes from the wrong place decodes as valid
    // data in the wrong location.
    await expect(
      read({ contentRange: (s, e) => `bytes ${s + 1}-${e}/${PIN.size}` }),
    ).rejects.toThrow(/the right number of bytes from the wrong offset/);
  });

  it("refuses a response reaching past the range it was asked for", async () => {
    await expect(
      read({ contentRange: (s, e) => `bytes ${s}-${e + 8}/${PIN.size}` }),
    ).rejects.toThrow(/intersects the object at/);
  });

  it("refuses a response stopping short of the range mid-object", async () => {
    await expect(
      read({ contentRange: (s, e) => `bytes ${s}-${e - 4}/${PIN.size}` }),
    ).rejects.toThrow(/intersects the object at/);
  });

  it("refuses a body shorter than its own Content-Range claims", async () => {
    // A truncated transfer. The header is consistent and the bytes are not.
    await expect(read({ bodyLength: (s, e) => e - s })).rejects.toThrow(/body carries/);
  });

  it("refuses a body longer than its own Content-Range claims", async () => {
    await expect(read({ bodyLength: (s, e) => e - s + 2 })).rejects.toThrow(/body carries/);
  });

  it("refuses an unparseable Content-Range", async () => {
    await expect(read({ contentRange: () => "bytes ???" })).rejects.toThrow(/unparseable/);
  });
});

describe("the pin is confirmed before a tile is read", () => {
  const rows = (over = {}) => [
    { key: "a.pmtiles", size: 1000, b3sum: "ab", version: "1.0.0", ...over },
  ];
  const pin = { ...PIN, blake3: "ab", version: "1.0.0", metadataUrl: "https://m.invalid/b.json" };
  const meta = (body) => () =>
    Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });

  it("accepts a row that matches", async () => {
    await expect(assertPinnedBuild(pin, meta(rows()))).resolves.toMatchObject({ key: "a.pmtiles" });
  });

  it("says the pin has aged out when the row is gone", async () => {
    // The upstream's own answer, not a local expiry someone must remember to bump.
    await expect(assertPinnedBuild(pin, meta([]))).rejects.toThrow(/aged out/);
  });

  it("refuses a row whose size, hash or version has moved", async () => {
    for (const over of [{ size: 2 }, { b3sum: "zz" }, { version: "9.9.9" }]) {
      await expect(assertPinnedBuild(pin, meta(rows(over)))).rejects.toThrow(
        /no longer matches the pin/,
      );
    }
  });

  it("refuses to proceed when the metadata itself cannot be read", async () => {
    const failing = () => Promise.resolve({ ok: false, status: 503 });
    await expect(assertPinnedBuild(pin, failing)).rejects.toThrow(/an unconfirmed pin/);
  });
});

describe("basemapTiles", () => {
  it("puts north on the low y and takes both sides of a boundary", () => {
    expect(basemapTiles([-180, -85, 180, 85], 1, 1)).toStrictEqual([
      { z: 1, x: 0, y: 0 },
      { z: 1, x: 0, y: 1 },
      { z: 1, x: 1, y: 0 },
      { z: 1, x: 1, y: 1 },
    ]);
    expect(basemapTiles([-1, 10, 1, 11], 2, 2).map((t) => t.x)).toStrictEqual([1, 2]);
  });
});
