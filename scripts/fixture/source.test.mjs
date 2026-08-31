// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { buildCog, fetchRangeOver } from "./cog-fixture.mjs";

import { decodeElevation } from "./terrarium.mjs";
import {
  HEADER_WINDOW_BYTES,
  SourceFormatError,
  cogObjectKey,
  cogUrl,
  cropWindow,
  parseCogHeader,
  readTerrariumCrop,
  undoFloatPredictor,
} from "./source.mjs";

describe("object naming", () => {
  it("builds the release's key from a tile id", () => {
    expect(cogObjectKey("N45E006")).toBe(
      "Copernicus_DSM_COG_10_N45_00_E006_00_DEM/Copernicus_DSM_COG_10_N45_00_E006_00_DEM.tif",
    );
  });

  it("keeps the hemisphere letters and the zero padding in the southern and western cells", () => {
    expect(cogObjectKey("S09W123")).toBe(
      "Copernicus_DSM_COG_10_S09_00_W123_00_DEM/Copernicus_DSM_COG_10_S09_00_W123_00_DEM.tif",
    );
  });

  it("prefixes the bucket", () => {
    expect(cogUrl("N45E006")).toBe(
      "https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_N45_00_E006_00_DEM/Copernicus_DSM_COG_10_N45_00_E006_00_DEM.tif",
    );
  });
});

describe("header parsing reads the geometry it will decode with", () => {
  it("returns the image, tile and georeferencing shape", () => {
    const header = parseCogHeader(buildCog());
    expect(header).toMatchObject({
      width: 8,
      height: 8,
      tileWidth: 4,
      tileHeight: 4,
      tilesAcross: 2,
      tilesDown: 2,
      pixelScaleDeg: 0.25,
      originLon: 6,
      originLat: 46,
    });
    expect(header.tileOffsets).toHaveLength(4);
    expect(header.tileByteCounts).toHaveLength(4);
  });
});

describe("every structural assumption fails loudly and names the tag", () => {
  // One mutation per case. A reader that accepted any of these would still decode — into a
  // wrong surface — which is why each is asserted rather than assumed from the product family.
  it.each([
    { what: "Compression", overrides: { 259: [5] }, expected: /Compression \(tag 259\) is 5/ },
    { what: "Predictor", overrides: { 317: [1] }, expected: /Predictor \(tag 317\) is 1/ },
    {
      what: "BitsPerSample",
      overrides: { 258: [16] },
      expected: /BitsPerSample \(tag 258\) is 16/,
    },
    { what: "SampleFormat", overrides: { 339: [1] }, expected: /SampleFormat \(tag 339\) is 1/ },
    {
      what: "SamplesPerPixel",
      overrides: { 277: [3] },
      expected: /SamplesPerPixel \(tag 277\) is 3/,
    },
    {
      what: "PlanarConfiguration",
      overrides: { 284: [2] },
      expected: /PlanarConfiguration \(tag 284\) is 2/,
    },
  ])("rejects $what", ({ overrides, expected }) => {
    expect(() => parseCogHeader(buildCog({ overrides }))).toThrow(expected);
  });

  it("rejects a byte order and magic it cannot read", () => {
    const bytes = buildCog();
    bytes[0] = 0x4d;
    bytes[1] = 0x4d;
    expect(() => parseCogHeader(bytes)).toThrow(/not a little-endian classic TIFF/);
  });

  it("rejects a missing tag by name", () => {
    expect(() => parseCogHeader(buildCog({ omit: [322] }))).toThrow(
      /TileWidth \(tag 322\) is missing/,
    );
  });

  it("rejects a tile table that does not match the image's tiling", () => {
    expect(() => parseCogHeader(buildCog({ overrides: { 325: [1, 2, 3] } }))).toThrow(
      /needs 4 entries, but TileOffsets has 4 and TileByteCounts has 3/,
    );
  });

  it("rejects anisotropic pixel spacing, which the crop arithmetic assumes away", () => {
    expect(() => parseCogHeader(buildCog({ overrides: { 33550: [0.25, 0.5, 0] } }))).toThrow(
      /ModelPixelScale is \[0.25, 0.5, 0\]/,
    );
  });

  it("rejects a tiepoint that does not tie raster (0, 0)", () => {
    expect(() => parseCogHeader(buildCog({ overrides: { 33922: [1, 1, 0, 6, 46, 0] } }))).toThrow(
      /ModelTiepoint is \[1, 1, 0, 6, 46, 0\]/,
    );
  });

  it("rejects a projected CRS", () => {
    expect(() => parseCogHeader(buildCog({ geoKeyOverrides: { 2048: 32632 } }))).toThrow(
      /GeographicTypeGeoKey \(geokey 2048\) is 32632/,
    );
  });

  it("rejects PixelIsArea, which would shift every sample by half a cell", () => {
    expect(() => parseCogHeader(buildCog({ geoKeyOverrides: { 1025: 1 } }))).toThrow(
      /GTRasterTypeGeoKey \(geokey 1025\) is 1/,
    );
  });

  it("rejects a geokey the source stopped declaring", () => {
    const bytes = buildCog();
    const header = parseCogHeader(bytes);
    expect(header.width).toBe(8); // the well-formed case reaches the end, so the case below is the mutation
    expect(() => parseCogHeader(buildCog({ geoKeyOverrides: { 1025: undefined } }))).toThrow();
  });

  it("refuses to read past the header window rather than reading whatever is there", () => {
    const bytes = buildCog();
    expect(() => parseCogHeader(bytes.slice(0, 20))).toThrow(/beyond the 20-byte header window/);
  });
});

describe("the floating-point predictor", () => {
  it("inverts the forward transform the builder applies", () => {
    // Round-tripped through the format rather than through the implementation: the builder
    // de-planes and differences from the TIFF specification, and this asserts the reader
    // recovers the exact floats.
    const values = [1.5, -2.25, 3000.125, 4810.717];
    const rowBytes = values.length * 4;
    const plain = Buffer.alloc(rowBytes);
    values.forEach((v, i) => plain.writeFloatLE(v, i * 4));
    const encoded = Buffer.alloc(rowBytes);
    for (let s = 0; s < values.length; s += 1) {
      for (let b = 0; b < 4; b += 1) encoded[b * values.length + s] = plain[s * 4 + (3 - b)];
    }
    for (let i = rowBytes - 1; i >= 1; i -= 1) encoded[i] = (encoded[i] - encoded[i - 1]) & 0xff;

    const out = undoFloatPredictor(new Uint8Array(encoded), rowBytes);
    expect([...out]).toEqual(values.map((v) => Math.fround(v)));
  });

  it("decodes a view that does not start at its buffer's origin", () => {
    // CI caught this and the local suite did not. `inflateSync` returns a Buffer, and
    // `Buffer.prototype.slice` is a **view** where `Uint8Array.prototype.slice` is a copy — so
    // reading `.buffer` off it yielded the whole allocation pool and the floats came from the
    // pool's origin rather than from this tile. Whether that was wrong depended entirely on
    // where the allocator happened to put the buffer: correct at offset zero, which is what a
    // large unpooled allocation gives, and silently another tile's bytes otherwise. The real
    // 4 MB tiles were fine; the 64-byte synthetic ones were not, on one Node and not another.
    //
    // Pinned here rather than left to the allocator: the offset is chosen explicitly, and it is
    // deliberately not a multiple of four so it also exercises the alignment the copy exists for.
    const values = [1.5, -2.25, 3000.125, 4810.717];
    const rowBytes = values.length * 4;
    const plain = Buffer.alloc(rowBytes);
    values.forEach((v, i) => plain.writeFloatLE(v, i * 4));
    const encoded = Buffer.alloc(rowBytes);
    for (let s = 0; s < values.length; s += 1) {
      for (let b = 0; b < 4; b += 1) encoded[b * values.length + s] = plain[s * 4 + (3 - b)];
    }
    for (let i = rowBytes - 1; i >= 1; i -= 1) encoded[i] = (encoded[i] - encoded[i - 1]) & 0xff;

    // Both view types, and **`Buffer` is the one that matters**: `inflateSync` returns a Buffer,
    // and only Buffer overrides `slice` to return a view. A first version of this test used a
    // plain `Uint8Array`, whose `slice` copies — so it passed against the broken code and
    // proved nothing. The backing buffer is constructed explicitly rather than left to
    // `allocUnsafe`, so the offset does not depend on the allocator's mood.
    for (const wrap of [
      (backing) => Buffer.from(backing, 5, rowBytes),
      (backing) => new Uint8Array(backing, 5, rowBytes),
    ]) {
      const backing = new ArrayBuffer(rowBytes + 16);
      new Uint8Array(backing).fill(0xff); // what surrounds the tile must not be read as data
      const view = wrap(backing);
      view.set(encoded);

      expect([...undoFloatPredictor(view, rowBytes)]).toEqual(values.map((v) => Math.fround(v)));
    }
  });
});

describe("the crop window selects exactly the samples inside the bounds", () => {
  const header = { width: 8, height: 8, pixelScaleDeg: 0.25, originLon: 6, originLat: 46 };

  it("takes the columns before an east edge that lands on a sample, not that column too", () => {
    // The convention has to match `requiredTiles`, which excludes a cut's upper edge cell.
    // Disagreeing would read a column from a tile coverage was never asked to check.
    expect(cropWindow(header, [6.25, 45.25, 6.75, 45.75])).toEqual({
      col0: 1,
      row0: 1,
      cols: 2,
      rows: 2,
    });
  });

  it.each([
    { edge: "west", bounds: [6.1, 45.25, 6.75, 45.75], expect_: { col0: 1, cols: 2 } },
    { edge: "east", bounds: [6.25, 45.25, 6.9, 45.75], expect_: { col0: 1, cols: 3 } },
  ])("never selects a sample outside an unaligned $edge edge", ({ bounds, expect_ }) => {
    // The defect an earlier version had: rounding a west edge of 6.1 at 0.25° spacing picks
    // the sample at 6.0, which is *outside* the requested crop, and produces entirely
    // plausible terrain there. Aligned bounds — which the declared region happens to use —
    // hide it completely, so it has to be asserted on bounds that are not aligned.
    const window = cropWindow(header, bounds);
    expect(window).toMatchObject(expect_);
    const west = header.originLon + window.col0 * header.pixelScaleDeg;
    const east = header.originLon + (window.col0 + window.cols - 1) * header.pixelScaleDeg;
    expect(west).toBeGreaterThanOrEqual(bounds[0]);
    expect(east).toBeLessThanOrEqual(bounds[2]);
  });

  it("takes the same window for an exactly aligned bound as for one a hair inside it", () => {
    // The floating-point half of the same fix. `(6.825 - 6) / (1 / 3600)` is 2970.0000000000005,
    // and a bare `ceil` would step to 2971 — selecting a sample one east of the declared edge
    // and losing one at the far end. The tolerance is what stops an exactly aligned bound from
    // being read as an unaligned one; it is not cosmetic.
    const arcsec = {
      width: 3600,
      height: 3600,
      pixelScaleDeg: 1 / 3600,
      originLon: 6,
      originLat: 46,
    };
    expect(cropWindow(arcsec, [6.825, 45.815, 6.905, 45.865])).toEqual({
      col0: 2970,
      row0: 486,
      cols: 288,
      rows: 180,
    });
  });

  it("rejects a crop reaching outside the tile", () => {
    expect(() => cropWindow(header, [5.5, 45.25, 6.5, 45.75])).toThrow(/falls outside the tile/);
  });

  it("rejects a span that falls between samples entirely", () => {
    // Distinct from a narrow span that still contains one: [6.25, 6.3] holds the sample at
    // 6.25 and is a legitimate one-column crop, where [6.3, 6.4] holds none.
    expect(() => cropWindow(header, [6.3, 45.25, 6.4, 45.75])).toThrow(/selects no samples/);
    expect(cropWindow(header, [6.25, 45.25, 6.3, 45.75])).toMatchObject({ col0: 1, cols: 1 });
  });

  it("rejects a box whose edges are in the wrong order, using the shared bounds validator", () => {
    expect(() => cropWindow(header, [6.75, 45.25, 6.25, 45.75])).toThrow(/west must precede east/);
  });
});

describe("reading a crop", () => {
  const bounds = [6.25, 45.25, 6.75, 45.75];

  it("terrarium-encodes the samples the bounds select, in row-major order from the north-west", async () => {
    const elevation = (c, r) => 3000 + c * 10 + r;
    const bytes = buildCog({ samples: elevation });
    const { fetchRange } = fetchRangeOver(bytes);
    const crop = await readTerrariumCrop("N45E006", bounds, { fetchRange });

    expect(crop).toMatchObject({ width: 2, height: 2, west: 6.25, north: 45.75 });
    // Decoded back through the codec rather than compared as bytes: what this asserts is that
    // a real sample survives the encode, to the encoding's own 1/256 m resolution.
    const got = [];
    for (let i = 0; i < crop.rgb.length; i += 3) {
      got.push(decodeElevation(crop.rgb[i], crop.rgb[i + 1], crop.rgb[i + 2]));
    }
    const want = [elevation(1, 1), elevation(2, 1), elevation(1, 2), elevation(2, 2)];
    got.forEach((v, i) => expect(v).toBeCloseTo(want[i], 2));
  });

  it("fetches only the internal tiles the crop overlaps, and the right ones", async () => {
    // The economy is the point of range-reading a 42 MB object at all, and it is invisible in
    // the returned pixels — so it is asserted on the requests rather than inferred from them.
    //
    // The crop sits in the **south-east** quadrant deliberately. An earlier version put it at
    // the north-west corner, where the first overlapping tile is tile zero — so a reader that
    // ignored the crop entirely and started from tile zero issued exactly the same requests,
    // and the test passed a mutation that broke the property it names. A crop at the origin
    // removes the difference the assertion is examining.
    // A **3x3** internal grid, so the crop can sit strictly inside the centre tile and be
    // interior on all four sides. A 2x2 grid cannot: whichever tile the crop lands in touches
    // both a first and a last edge, so a reader that ignored one of the four bounds issued the
    // same requests and the mutation survived. The property is "only the overlapping tiles",
    // and only an interior crop can observe all four ways of getting it wrong.
    const bytes = buildCog({ width: 12, height: 12, tileWidth: 4, tileHeight: 4 });
    const header = parseCogHeader(bytes);
    const { calls, fetchRange } = fetchRangeOver(bytes);
    await readTerrariumCrop("N45E006", [7.25, 44.25, 7.75, 44.75], { fetchRange });

    expect(calls[0]).toEqual([0, HEADER_WINDOW_BYTES - 1]);
    // Named by offset rather than counted: asserting the range says *which* tile was read,
    // where a count only says how many.
    const centre = header.tilesAcross * 1 + 1;
    expect(calls.slice(1)).toEqual([
      [header.tileOffsets[centre], header.tileOffsets[centre] + header.tileByteCounts[centre] - 1],
    ]);
  });

  it("refuses an object tied to a corner other than the one the id names", async () => {
    // The one failure in this module that would otherwise be silent: a wrong object key decodes
    // perfectly and puts correct-looking terrain in the wrong place.
    const bytes = buildCog({ originLon: 7, originLat: 46 });
    const { fetchRange } = fetchRangeOver(bytes);
    await expect(readTerrariumCrop("N45E006", bounds, { fetchRange })).rejects.toThrow(
      /tied to \(7, 46\), but N45E006 names the cell whose north-west corner is \(6, 46\)/,
    );
  });

  it("stops on a sample the encoding cannot represent rather than clamping it into terrain", async () => {
    // A nodata sentinel, a metres/feet mistake or a corrupt read all arrive this way. There is
    // no encoding for absence, so there is no encoding for out-of-range either.
    const bytes = buildCog({ samples: (c, r) => (c === 1 && r === 1 ? -1e6 : 3000) });
    const { fetchRange } = fetchRangeOver(bytes);
    await expect(readTerrariumCrop("N45E006", bounds, { fetchRange })).rejects.toThrow(
      /outside the encodable range/,
    );
  });

  it.each([
    { delta: 8, what: "longer", detail: /inflates to 72 bytes, but a 4x4 float32 tile is 64/ },
    { delta: -8, what: "shorter", detail: /inflates to 56 bytes, but a 4x4 float32 tile is 64/ },
  ])(
    "refuses an internal tile that inflates $what than its tiling implies",
    async ({ delta, detail }) => {
      // The over-long case is the one that would otherwise be silent: the predictor decodes it
      // happily and the surplus samples are simply never indexed, so a source that changed its
      // tiling would yield a plausible surface rather than a failure.
      const bytes = buildCog({ tilePayloadDelta: delta });
      const { fetchRange } = fetchRangeOver(bytes);
      await expect(readTerrariumCrop("N45E006", bounds, { fetchRange })).rejects.toThrow(detail);
    },
  );

  it("names the object in a header failure, so a reader knows which tile diverged", async () => {
    const bytes = buildCog({ overrides: { 259: [5] } });
    const { fetchRange } = fetchRangeOver(bytes);
    await expect(readTerrariumCrop("N45E006", bounds, { fetchRange })).rejects.toThrow(
      SourceFormatError,
    );
    await expect(readTerrariumCrop("N45E006", bounds, { fetchRange })).rejects.toThrow(
      /N45E006 \(https:\/\/copernicus-dem-30m/,
    );
  });
});
