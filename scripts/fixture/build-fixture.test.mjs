// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { PMTiles } from "pmtiles";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildFixture, DEFAULT_PATHS } from "./build-fixture.mjs";
import { buildCog } from "./cog-fixture.mjs";
import { rangeFetcher } from "./deps.mjs";
import { tilesInRange } from "./mercator.mjs";

/**
 * A region in the north-west corner of `N45E006`, small enough that a synthetic COG covering it
 * is 200 × 200 samples rather than the release's 3600 × 3600.
 *
 * The corner matters: the reader cross-checks a COG's tiepoint against the cell its id names, so
 * the synthetic raster must start at (6, 46) like the real one.
 *
 * The bounds are **computed, not chosen**. A first attempt put them at 6.01, which sits on a z14
 * tile straddling the 6°E cell edge — so the production envelope reached into `N45E005` and the
 * build correctly failed at coverage for a cell no synthetic raster served. They sit inside tile
 * 14/8466/5829, whose whole footprint plus halo falls within the raster.
 */
const REGION = {
  id: "synthetic-corner",
  bounds: [6.0271, 45.9863, 6.0359, 45.9924],
  minElevationM: 2500,
  minElevationJustification: "synthetic terrain, declared above the floor for this test",
  minZoom: 14,
  maxZoom: 14,
};
const SPACING = 1 / 3600;
/** Well clear of the floor, and varying, so a constant fill could not pass. */
const elevation = (col, row) => 3000 + col * 0.7 - row * 0.4;

let dir;
let paths;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "mapatlas-fixture-"));
  mkdirSync(join(dir, "out"), { recursive: true });
  writeFileSync(join(dir, "region.json"), JSON.stringify(REGION));
  paths = {
    // The real licence, attribution and coverage snapshot: they are checked in, and using them
    // means this exercises the obligations against the documents the build actually ships with
    // rather than against stand-ins.
    regionPath: join(dir, "region.json"),
    snapshotPath: DEFAULT_PATHS.snapshotPath,
    licencePath: DEFAULT_PATHS.licencePath,
    attributionPath: DEFAULT_PATHS.attributionPath,
    archivePath: join(dir, "out", "terrain.pmtiles"),
  };
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** The same filesystem object the entry point builds for itself, so a test can vary one part. */
function realIo() {
  return {
    readFileSync,
    renameSync,
    rmSync,
    mkdirSync,
    statSync,
    dirname,
    join,
    sha256: (bytes) => createHash("sha256").update(bytes).digest("hex"),
  };
}

/** A synthetic `N45E006` served over a fake `fetch`, with real HTTP range semantics. */
function syntheticSource() {
  const object = buildCog({
    width: 200,
    height: 200,
    tileWidth: 64,
    tileHeight: 64,
    originLon: 6,
    originLat: 46,
    pixelScale: SPACING,
    samples: elevation,
  });
  const requests = [];
  const fetchImpl = (url, init) => {
    requests.push(url);
    if (!url.includes("N45_00_E006_00_DEM")) {
      return Promise.resolve({ status: 404, headers: { get: () => null }, body: null });
    }
    const range = /bytes=(\d+)-(\d+)/.exec(init.headers.Range);
    const start = Number(range[1]);
    const end = Math.min(Number(range[2]), object.length - 1);
    const slice = object.slice(start, end + 1);
    return Promise.resolve({
      status: 206,
      headers: {
        get: (n) => (n === "Content-Range" ? `bytes ${start}-${end}/${object.length}` : null),
      },
      body: { cancel: () => Promise.resolve() },
      arrayBuffer: () =>
        Promise.resolve(slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength)),
    });
  };
  return { fetchImpl, requests };
}

/** Read an archive back through the independent reader over the hardened range path. */
function openArchive(path) {
  const total = statSync(path).size;
  const read = rangeFetcher((_url, init) => {
    const [, f, t] = /bytes=(\d+)-(\d+)/.exec(init.headers.Range);
    const start = Number(f);
    const end = Math.min(Number(t), total - 1);
    const slice = readFileSync(path).subarray(start, end + 1);
    return Promise.resolve({
      status: 206,
      headers: { get: (n) => (n === "Content-Range" ? `bytes ${start}-${end}/${total}` : null) },
      body: { cancel: () => Promise.resolve() },
      arrayBuffer: () =>
        Promise.resolve(slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength)),
    });
  });
  return new PMTiles({
    getKey: () => path,
    getBytes: async (offset, length) => ({
      data: (await read(path, offset, offset + length - 1)).buffer,
    }),
  });
}

describe("the committed entry point produces an archive", () => {
  // What this establishes and what it does not. It proves the **assembled, committed path**
  // works — every stage, in order, through the real writer onto a real filesystem — with no
  // network. It says nothing about whether the release still publishes the data, which is a
  // fact about the world that only a networked run can check.
  it("runs every stage and writes a readable archive", async () => {
    const { fetchImpl } = syntheticSource();

    const report = await buildFixture({ paths, fetchImpl });

    expect(report.region).toBe("synthetic-corner");
    expect(report.sourceCells).toEqual(["N45E006"]);
    expect(report.lowest.elevationM).toBeGreaterThanOrEqual(REGION.minElevationM);
    expect(report.outputPath).toBe(paths.archivePath);
    expect(report.archiveBytes).toBeGreaterThan(0);
    expect(statSync(paths.archivePath).size).toBe(report.archiveBytes);
  });

  it("creates the output directory rather than requiring one to exist", async () => {
    // The real default writes to `build/fixture/`, which is not in the repository — it is a
    // build artifact and `*.pmtiles` is git-ignored. Every other case here writes into a
    // directory the fixture set up first, so without this the `mkdirSync` could be deleted with
    // the suite green and only the committed command would break.
    const nested = join(dir, "made", "up", "path", "terrain.pmtiles");

    const report = await buildFixture({
      paths: { ...paths, archivePath: nested },
      fetchImpl: syntheticSource().fetchImpl,
    });

    expect(report.outputPath).toBe(nested);
    expect(statSync(nested).size).toBeGreaterThan(0);
  });

  it("carries every tile of the declared pyramid, each a distinct PNG", async () => {
    const { fetchImpl } = syntheticSource();
    await buildFixture({ paths, fetchImpl });

    const archive = openArchive(paths.archivePath);
    // The archive's own declaration, not just the payloads. A raster archive mislabelled as
    // vector carries perfectly good PNGs that a renderer will hand to a vector-tile decoder,
    // and every payload assertion below passes either way.
    const header = await archive.getHeader();
    expect(header.tileType).toBe(2); // PMTiles v3: 2 is PNG, 1 is MVT
    expect(header.minZoom).toBe(REGION.minZoom);
    expect(header.maxZoom).toBe(REGION.maxZoom);
    const digests = new Set();
    let count = 0;
    for (const { z, x, y } of tilesInRange(REGION.bounds, REGION.minZoom, REGION.maxZoom)) {
      const tile = await archive.getZxy(z, x, y);
      expect(tile, `${z}/${x}/${y}`).toBeDefined();
      const bytes = new Uint8Array(tile.data);
      expect([...bytes.subarray(0, 4)]).toEqual([137, 80, 78, 71]);
      digests.add(Buffer.from(bytes).toString("base64").slice(0, 32));
      count += 1;
    }
    expect(count).toBeGreaterThan(0);
    expect(digests.size).toBe(count);
  });

  it("advertises the declared region and the real licence in its metadata", async () => {
    const { fetchImpl } = syntheticSource();
    await buildFixture({ paths, fetchImpl });

    const metadata = await openArchive(paths.archivePath).getMetadata();
    expect(metadata.bounds).toEqual(REGION.bounds);
    expect(metadata.minzoom).toBe(REGION.minZoom);
    expect(metadata.maxzoom).toBe(REGION.maxZoom);
    expect(Object.keys(metadata.attribution)).toEqual([
      "derivedWorksNotice",
      "liabilityStatement",
      "noEndorsement",
      "downstreamBinding",
    ]);
    expect(metadata.license.length).toBeGreaterThan(100);
  });

  it("writes nothing at all when a check fails before the archive stage", async () => {
    const failing = join(dir, "out", "never.pmtiles");
    const { fetchImpl } = syntheticSource();
    writeFileSync(join(dir, "low.json"), JSON.stringify({ ...REGION, minElevationM: 9000 }));

    await expect(
      buildFixture({
        paths: { ...paths, regionPath: join(dir, "low.json"), archivePath: failing },
        fetchImpl,
      }),
    ).rejects.toThrow(/below the declared floor/);

    expect(() => statSync(failing)).toThrow();
    expect(() => statSync(`${failing}.partial`)).toThrow();
  });

  it("discards the partial when the archive stage fails after writing one", async () => {
    // The case the test above cannot reach. A floor breach fails *before* anything is written,
    // so `discardArchive` never runs and could be deleted with the suite green. Failing the
    // rename is a failure at the archive stage with a real partial already on disk — and a
    // failed build that leaves a usable-looking artifact is worse than one leaving nothing,
    // since `/lab` and the browser scenario read the finalised path.
    const failing = join(dir, "out", "orphan.pmtiles");
    const { fetchImpl } = syntheticSource();
    const io = {
      ...realIo(),
      renameSync: () => {
        throw new Error("cross-device link not permitted");
      },
    };

    await expect(
      buildFixture({ paths: { ...paths, archivePath: failing }, fetchImpl, io }),
    ).rejects.toThrow(/cross-device link/);

    expect(() => statSync(`${failing}.partial`)).toThrow();
    expect(() => statSync(failing)).toThrow();
  });

  it("writes a development build to its own path, marked not for distribution", async () => {
    const { fetchImpl } = syntheticSource();
    const dev = join(dir, "out", "dev.pmtiles");

    const report = await buildFixture({
      paths: { ...paths, archivePath: dev },
      distributable: false,
      fetchImpl,
    });

    expect(report.outputPath).toBe(`${dev}.dev`);
    expect(report.distributable).toBe(false);
    const metadata = await openArchive(`${dev}.dev`).getMetadata();
    expect(metadata["NOT-FOR-DISTRIBUTION"]).toBeDefined();
  });
});
