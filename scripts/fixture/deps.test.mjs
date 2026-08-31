// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { buildCog } from "./cog-fixture.mjs";
import { clipBoundsToTile, createProbe, createSourceDeps, rangeFetcher } from "./deps.mjs";
import { cropWindow } from "./source.mjs";
import { decodeElevation } from "./terrarium.mjs";

const NO_HEADERS = { get: () => null };

/**
 * A well-behaved partial response: the bytes, a `Content-Range` naming the interval they came
 * from, and a body that can be released.
 *
 * @param {Uint8Array} slice
 * @param {number} first
 * @param {number} total
 */
function partial(slice, first, total, overrides = {}) {
  const last = first + slice.byteLength - 1;
  return {
    status: 206,
    headers: {
      get: (name) => (name === "Content-Range" ? `bytes ${first}-${last}/${total}` : null),
    },
    body: { cancel: () => Promise.resolve() },
    arrayBuffer: () =>
      Promise.resolve(slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength)),
    ...overrides,
  };
}

/** A `fetch` over named objects, recording the URLs and Range headers it was asked for. */
function fetchOver(objects) {
  const calls = [];
  return {
    calls,
    fetchImpl: (url, init) => {
      const range = /bytes=(\d+)-(\d+)/.exec(init?.headers?.Range ?? "");
      calls.push({ url, range: init?.headers?.Range });
      const key = Object.keys(objects).find((k) => url.includes(k));
      if (key === undefined) {
        return Promise.resolve({ status: 404, headers: NO_HEADERS, body: null });
      }
      const bytes = objects[key];
      const first = Number(range?.[1] ?? 0);
      // Clamped to the object, as a real server does: a window past the end comes back short.
      const slice = bytes.slice(
        first,
        Math.min(Number(range?.[2] ?? bytes.length - 1) + 1, bytes.length),
      );
      return Promise.resolve(partial(slice, first, bytes.length));
    },
  };
}

describe("the coverage probe reports a status rather than throwing on one", () => {
  it("returns 404 as data, so an unpublished tile stays distinguishable", async () => {
    // The whole reason `createProbe` does not reuse `rangeFetcher`. A reader that throws on a
    // non-2xx turns a withheld tile into a thrown probe, and `assertCoverage` classifies a
    // thrown probe as `unreachable` — telling a reader to retry a tile that will never exist,
    // and silently retiring the one case the coverage snapshot exists to name.
    const probe = createProbe(() => Promise.resolve({ status: 404, body: null }));
    await expect(probe("N45E006")).resolves.toEqual({ status: 404 });
  });

  it("returns 206 for a present tile", async () => {
    const probe = createProbe(() => Promise.resolve({ status: 206, body: null }));
    await expect(probe("N45E006")).resolves.toEqual({ status: 206 });
  });

  it("asks for one byte of the tile's own object", async () => {
    const { calls, fetchImpl } = fetchOver({});
    await createProbe(fetchImpl)("N45E007");
    expect(calls[0].url).toContain("Copernicus_DSM_COG_10_N45_00_E007_00_DEM.tif");
    expect(calls[0].range).toBe("bytes=0-0");
  });

  it("releases the response body instead of leaving it unread", async () => {
    // Only the status is wanted, but an unconsumed body keeps its connection checked out of the
    // pool. One probe per required tile, serially, is exactly the shape that stalls on reuse.
    let cancelled = 0;
    const probe = createProbe(() =>
      Promise.resolve({
        status: 206,
        body: {
          cancel: () => {
            cancelled += 1;
            return Promise.resolve();
          },
        },
      }),
    );

    await probe("N45E006");

    expect(cancelled).toBe(1);
  });

  it("tolerates a response carrying no body to release", async () => {
    const probe = createProbe(() => Promise.resolve({ status: 404, body: null }));
    await expect(probe("N45E006")).resolves.toEqual({ status: 404 });
  });

  it("lets a genuine transport failure through, so it is not read as an absence", async () => {
    const probe = createProbe(() => Promise.reject(new Error("socket hang up")));
    await expect(probe("N45E006")).rejects.toThrow("socket hang up");
  });
});

describe("the range reader checks it was given the interval it asked for", () => {
  const payload = new Uint8Array([1, 2, 3, 4]);

  it("returns the bytes of a well-formed partial response", async () => {
    await expect(
      rangeFetcher(() => Promise.resolve(partial(payload, 0, 99)))("u", 0, 3),
    ).resolves.toEqual(payload);
  });

  it("sends the range it was asked for", async () => {
    let sent;
    await rangeFetcher((_u, init) => {
      sent = init.headers.Range;
      return Promise.resolve(partial(payload, 0, 99));
    })("u", 0, 3);
    expect(sent).toBe("bytes=0-3");
  });

  it("refuses 200, because an ignored Range returns the whole object", async () => {
    // The status a proxy or a server without range support gives. The bytes are from the same
    // object, so a header parse against byte 0 succeeds and a tile read silently takes the
    // file's opening bytes instead of the tile's.
    const whole = () => Promise.resolve(partial(payload, 0, 99, { status: 200 }));
    await expect(rangeFetcher(whole)("u", 0, 3)).rejects.toThrow(/expected 206 Partial Content/);
  });

  it.each([404, 416, 500])("throws on HTTP %i", async (status) => {
    const fail = () => Promise.resolve(partial(payload, 0, 99, { status }));
    await expect(rangeFetcher(fail)("u", 0, 3)).rejects.toThrow(`HTTP ${String(status)}`);
  });

  it("refuses a correctly sized window served from the wrong offset", async () => {
    // The worst case available: the length checks out, the payload inflates because another
    // internal tile is also a valid deflate stream, and the build gets real terrain from the
    // wrong part of the world. Only Content-Range distinguishes it.
    const shifted = () => Promise.resolve(partial(payload, 4096, 99999));
    await expect(rangeFetcher(shifted)("u", 0, 3)).rejects.toThrow(/served from byte 4096, not 0/);
  });

  it.each([
    { note: "absent", headers: NO_HEADERS },
    { note: "malformed", headers: { get: () => "bytes 0-3" } },
  ])("refuses a $note Content-Range", async ({ headers }) => {
    const bare = () => Promise.resolve(partial(payload, 0, 99, { headers }));
    await expect(rangeFetcher(bare)("u", 0, 3)).rejects.toThrow(/unparseable/);
  });

  it("refuses a response reaching beyond the range it was asked for", async () => {
    const over = () => Promise.resolve(partial(new Uint8Array(8), 0, 99));
    await expect(rangeFetcher(over)("u", 0, 3)).rejects.toThrow(
      /answered bytes 0-7 of 99, but the request intersects the object at 0-3/,
    );
  });

  it("accepts a short read only where the object itself ends", async () => {
    // A 64 KB header window over a smaller object legitimately comes back short: HTTP returns
    // the intersection of the request with what exists. Refusing this would make the reader
    // unable to read any object smaller than its own header window.
    const atEof = () => Promise.resolve(partial(payload, 0, 4));
    await expect(rangeFetcher(atEof)("u", 0, 65535)).resolves.toEqual(payload);
  });

  it("refuses a read truncated short of both the range and the object", async () => {
    // The same shape as a legitimate short read, distinguished only by the object's declared
    // total. A header window stopping early would otherwise be parsed as a divergent format.
    const truncated = () => Promise.resolve(partial(payload, 0, 99999));
    await expect(rangeFetcher(truncated)("u", 0, 65535)).rejects.toThrow(
      /answered bytes 0-3 of 99999, but the request intersects the object at 0-65535/,
    );
  });

  it.each([
    { note: "short", body: new Uint8Array([1, 2]) },
    { note: "over-long", body: new Uint8Array([1, 2, 3, 4, 5, 6]) },
  ])("refuses a $note body even when the headers agree", async ({ body }) => {
    const lying = () =>
      Promise.resolve({
        ...partial(payload, 0, 99),
        arrayBuffer: () => Promise.resolve(body.buffer),
      });
    await expect(rangeFetcher(lying)("u", 0, 3)).rejects.toThrow(
      `body carries ${String(body.length)}`,
    );
  });
});

describe("a cut is split across the tiles it spans", () => {
  const ACROSS_MERIDIAN = [6.5, 45.5, 7.5, 45.6];
  const ACROSS_PARALLEL = [6.5, 45.5, 6.6, 46.5];
  const headerAt = (originLon, originLat) => ({
    width: 3600,
    height: 3600,
    pixelScaleDeg: 1 / 3600,
    originLon,
    originLat,
  });

  it("gives each tile only its own share", () => {
    expect(clipBoundsToTile(ACROSS_MERIDIAN, "N45E006")).toEqual([6.5, 45.5, 7, 45.6]);
    expect(clipBoundsToTile(ACROSS_MERIDIAN, "N45E007")).toEqual([7, 45.5, 7.5, 45.6]);
    expect(clipBoundsToTile(ACROSS_PARALLEL, "N45E006")).toEqual([6.5, 45.5, 6.6, 46]);
    expect(clipBoundsToTile(ACROSS_PARALLEL, "N46E006")).toEqual([6.5, 46, 6.6, 46.5]);
  });

  it("leaves a cut inside one tile untouched", () => {
    expect(clipBoundsToTile([6.825, 45.815, 6.905, 45.865], "N45E006")).toEqual([
      6.825, 45.815, 6.905, 45.865,
    ]);
  });

  it("makes the two shares meet exactly across a meridian — no column read twice, none missed", () => {
    // A property of the **pair**, so it is checked on the pair. Each tile resolves its share
    // against its *own* raster origin, and the shares are only correct together: the column on
    // the shared meridian must belong to exactly one of them. `cropWindow`'s half-open east
    // edge is what decides that, and testing either clip alone cannot see it.
    const west = cropWindow(headerAt(6, 46), clipBoundsToTile(ACROSS_MERIDIAN, "N45E006"));
    const east = cropWindow(headerAt(7, 46), clipBoundsToTile(ACROSS_MERIDIAN, "N45E007"));

    // In absolute sample columns from lon 6, where the two tiles' indices are comparable at all.
    expect(3600 + east.col0).toBe(west.col0 + west.cols);
    expect(west.cols + east.cols).toBe(
      Math.round((ACROSS_MERIDIAN[2] - ACROSS_MERIDIAN[0]) * 3600),
    );
    expect(west.rows).toBe(east.rows);
  });

  it("makes the two shares meet exactly across a parallel — no row read twice, none missed", () => {
    // The latitude seam is a separate claim from the longitude one and fails independently:
    // rows are indexed downward from each tile's northern origin, so the arithmetic is not the
    // same arithmetic. `cropWindow`'s half-open **south** edge is what settles ownership here,
    // and under `PixelIsPoint` the shared parallel belongs to the **southern** tile — N45's
    // row 0 sits exactly on lat 46, while N46's rows stop one sample above it.
    const north = cropWindow(headerAt(6, 47), clipBoundsToTile(ACROSS_PARALLEL, "N46E006"));
    const south = cropWindow(headerAt(6, 46), clipBoundsToTile(ACROSS_PARALLEL, "N45E006"));

    // In absolute sample rows southward from lat 47.
    expect(3600 + south.row0).toBe(north.row0 + north.rows);
    expect(north.rows + south.rows).toBe(
      Math.round((ACROSS_PARALLEL[3] - ACROSS_PARALLEL[1]) * 3600),
    );
    expect(north.cols).toBe(south.cols);
    // The shared parallel is owned by the southern tile, and named rather than implied: its
    // first row is exactly lat 46, and the northern tile's last row is one sample above it.
    expect(46 - south.row0 / 3600).toBe(46);
    expect(47 - (north.row0 + north.rows - 1) / 3600).toBeCloseTo(46 + 1 / 3600, 9);
  });
});

describe("readTile is bound to each tile's own object", () => {
  // Two distinguishable sources: the elevations differ, so reading the wrong object is visible
  // in the samples rather than only in the URL.
  const objects = {
    N45_00_E006_00_DEM: buildCog({ originLon: 6, originLat: 46, samples: () => 3000 }),
    N45_00_E007_00_DEM: buildCog({ originLon: 7, originLat: 46, samples: () => 4000 }),
  };
  const CUT = [6.25, 45.25, 7.75, 45.75];

  it.each([
    { tile: "N45E006", metres: 3000 },
    { tile: "N45E007", metres: 4000 },
  ])("reads $tile from its own object and its own share", async ({ tile, metres }) => {
    const { calls, fetchImpl } = fetchOver(objects);
    const { readTile } = createSourceDeps({ bounds: CUT, fetchImpl });

    const samples = [...(await readTile(tile))].map(([r, g, b]) => decodeElevation(r, g, b));

    expect(samples.length).toBeGreaterThan(0);
    for (const m of samples) expect(m).toBeCloseTo(metres, 2);
    const object = `${tile.replace("N45E", "N45_00_E")}_00_DEM`;
    for (const call of calls) expect(call.url).toContain(object);
  });

  it("clips the cut to the tile instead of handing each tile the whole box", async () => {
    // Without the clip, N45E007 is asked for a crop starting at 6.25 — a column west of its
    // own raster — and the reader rejects it as outside the tile. The failure is loud, but it
    // only happens for a cut that spans a seam, which no single-tile fixture produces.
    const { fetchImpl } = fetchOver(objects);
    const { readTile } = createSourceDeps({ bounds: CUT, fetchImpl });

    await expect(readTile("N45E007")).resolves.toBeDefined();
  });
});
