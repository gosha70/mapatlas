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

import { VectorTile } from "@mapbox/vector-tile";
import Pbf from "pbf";
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
  zoomJustification: "one z14 tile fits the synthetic raster",
  contourIntervalM: 100,
  contourIntervalJustification: "100 m across the synthetic ramp gives several levels",
};
const SPACING = 1 / 3600;
/**
 * Well clear of the floor, and varying enough to carry contours.
 *
 * The gradient is steep because the region is one z14 tile, some 79 samples across: at 0.7 m per
 * sample it spanned 55 m, which contains no multiple of the 100 m interval, and the build
 * refuses a fixture whose contour layer would be empty.
 */
const elevation = (col, row) => 3000 + col * 3 - row * 1.5;

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
    terrainArchivePath: join(dir, "out", "terrain.pmtiles"),
    contourArchivePath: join(dir, "out", "contours.pmtiles"),
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
    // Two archives, because PMTiles v3 carries one tile type and one compression per file.
    expect(report.archives.map((a) => a.kind)).toEqual(["terrain", "contours"]);
    for (const archive of report.archives) {
      expect(archive.bytes).toBeGreaterThan(0);
      expect(statSync(archive.path).size).toBe(archive.bytes);
      expect(archive.tiles).toBeGreaterThan(0);
    }
  });

  it("creates the output directory rather than requiring one to exist", async () => {
    // The real default writes to `build/fixture/`, which is not in the repository — it is a
    // build artifact and `*.pmtiles` is git-ignored. Every other case here writes into a
    // directory the fixture set up first, so without this the `mkdirSync` could be deleted with
    // the suite green and only the committed command would break.
    const nested = join(dir, "made", "up", "path", "terrain.pmtiles");
    const nestedContours = join(dir, "made", "up", "path", "contours.pmtiles");

    const report = await buildFixture({
      paths: { ...paths, terrainArchivePath: nested, contourArchivePath: nestedContours },
      fetchImpl: syntheticSource().fetchImpl,
    });

    expect(report.archives.map((a) => a.path)).toEqual([nested, nestedContours]);
    for (const archive of report.archives) expect(statSync(archive.path).size).toBeGreaterThan(0);
  });

  it("carries every tile of the declared pyramid, each a distinct PNG", async () => {
    const { fetchImpl } = syntheticSource();
    await buildFixture({ paths, fetchImpl });

    const archive = openArchive(paths.terrainArchivePath);
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

  it("declares the contour archive as gzipped vector tiles, and it decodes as such", async () => {
    // PMTiles v3 carries one tile type and one compression per archive, which is why there are
    // two. Asserting the payloads decode is not enough on its own: an MVT archive mislabelled as
    // PNG hands perfectly good protobuf to an image decoder, and every payload check passes.
    const { fetchImpl } = syntheticSource();
    await buildFixture({ paths, fetchImpl });

    const terrain = await openArchive(paths.terrainArchivePath).getHeader();
    const contours = openArchive(paths.contourArchivePath);
    const header = await contours.getHeader();

    expect(terrain.tileType).toBe(2); // PNG
    expect(terrain.tileCompression).toBe(1); // none — PNG is already deflated
    expect(header.tileType).toBe(1); // MVT
    expect(header.tileCompression).toBe(2); // gzip
    expect(header.tileType).not.toBe(terrain.tileType);

    // And the bytes really are vector tiles carrying elevations, read by an independent decoder.
    let decoded = 0;
    for (const { z, x, y } of tilesInRange(REGION.bounds, REGION.minZoom, REGION.maxZoom)) {
      const tile = await contours.getZxy(z, x, y);
      if (tile === undefined) continue;
      const layer = new VectorTile(new Pbf(new Uint8Array(tile.data))).layers.contours;
      expect(layer.length).toBeGreaterThan(0);
      for (let i = 0; i < layer.length; i += 1) {
        expect(layer.feature(i).properties.elevation % 100).toBe(0);
        decoded += 1;
      }
    }
    expect(decoded).toBeGreaterThan(0);
  });

  it("advertises the declared region and the real licence in its metadata", async () => {
    const { fetchImpl } = syntheticSource();
    await buildFixture({ paths, fetchImpl });

    const metadata = await openArchive(paths.terrainArchivePath).getMetadata();
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
        paths: { ...paths, regionPath: join(dir, "low.json"), terrainArchivePath: failing },
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
    // Both paths are fresh: asserting on the shared contour path would only observe an archive
    // an earlier test wrote successfully, and would pass however this build behaved.
    const failingContours = join(dir, "out", "orphan-contours.pmtiles");
    const { fetchImpl } = syntheticSource();
    const io = {
      ...realIo(),
      renameSync: () => {
        throw new Error("cross-device link not permitted");
      },
    };

    await expect(
      buildFixture({
        paths: { ...paths, terrainArchivePath: failing, contourArchivePath: failingContours },
        fetchImpl,
        io,
      }),
    ).rejects.toThrow(/cross-device link/);

    // Neither archive is named, and neither partial survives, when either fails: a half-built
    // stack that looks complete is the same defect as a licence-violating archive, one level up.
    for (const path of [failing, failingContours]) {
      expect(() => statSync(path), path).toThrow();
      expect(() => statSync(`${path}.partial`), `${path}.partial`).toThrow();
    }
  });

  it("leaves no archive at all when a rebuild's second promotion fails", async () => {
    // The transactional case, on a real filesystem. **A rebuild finds both finals already
    // there**, so a failure partway through promotion can leave the *previous* counterpart
    // published beside nothing — a half-built stack assembled from two builds rather than one.
    // Removing only what this build renamed does not fix that, which is why the invariant is
    // "once promotion has begun, a failure leaves no archive".
    const terrain = join(dir, "out", "rebuild.pmtiles");
    const contours = join(dir, "out", "rebuild-contours.pmtiles");
    const rebuildPaths = { ...paths, terrainArchivePath: terrain, contourArchivePath: contours };

    // A previous build succeeded, leaving both finals in place.
    await buildFixture({ paths: rebuildPaths, fetchImpl: syntheticSource().fetchImpl });
    expect(statSync(terrain).size).toBeGreaterThan(0);
    expect(statSync(contours).size).toBeGreaterThan(0);

    // This one replaces terrain and then fails renaming contours.
    let renames = 0;
    const io = {
      ...realIo(),
      renameSync: (from, to) => {
        renames += 1;
        if (renames === 2) throw new Error("rename failed");
        renameSync(from, to);
      },
    };

    await expect(
      buildFixture({ paths: rebuildPaths, fetchImpl: syntheticSource().fetchImpl, io }),
    ).rejects.toThrow(/rename failed/);

    expect(renames).toBe(2); // the second was attempted, so the first had already published
    for (const path of [terrain, contours, `${terrain}.partial`, `${contours}.partial`]) {
      expect(() => statSync(path), path).toThrow();
    }
  });

  it("leaves a previous pair intact when the first promotion fails", async () => {
    // The other side of the transaction boundary, and the one that decides *where* it sits. A
    // first rename that throws has modified nothing, so the previous build's pair is still whole
    // — deleting it would destroy good output over a failure that touched none of it. Only once
    // a rename has landed is the pair a mixture, and only then does everything go.
    const terrain = join(dir, "out", "keep.pmtiles");
    const contours = join(dir, "out", "keep-contours.pmtiles");
    const keepPaths = { ...paths, terrainArchivePath: terrain, contourArchivePath: contours };

    await buildFixture({ paths: keepPaths, fetchImpl: syntheticSource().fetchImpl });
    const before = [readFileSync(terrain), readFileSync(contours)];

    const io = {
      ...realIo(),
      renameSync: () => {
        throw new Error("rename failed");
      },
    };

    await expect(
      buildFixture({ paths: keepPaths, fetchImpl: syntheticSource().fetchImpl, io }),
    ).rejects.toThrow(/rename failed/);

    // The previous pair survives, byte for byte...
    expect(readFileSync(terrain).equals(before[0])).toBe(true);
    expect(readFileSync(contours).equals(before[1])).toBe(true);
    // ...and this build's partials do not.
    for (const path of [`${terrain}.partial`, `${contours}.partial`]) {
      expect(() => statSync(path), path).toThrow();
    }
  });

  it("writes a development build to its own path, marked not for distribution", async () => {
    const { fetchImpl } = syntheticSource();
    const dev = join(dir, "out", "dev.pmtiles");

    const devContours = join(dir, "out", "dev-contours.pmtiles");
    const report = await buildFixture({
      paths: { ...paths, terrainArchivePath: dev, contourArchivePath: devContours },
      distributable: false,
      fetchImpl,
    });

    expect(report.archives.map((a) => a.path)).toEqual([`${dev}.dev`, `${devContours}.dev`]);
    expect(report.distributable).toBe(false);
    // Both archives are development output, so both carry the marker — checking only the one
    // holding the elevation data would ship unmarked contours traced from the same source.
    for (const archive of report.archives) {
      const metadata = await openArchive(archive.path).getMetadata();
      expect(metadata["NOT-FOR-DISTRIBUTION"]).toBeDefined();
    }
  });
});
