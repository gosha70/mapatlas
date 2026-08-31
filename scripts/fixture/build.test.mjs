// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { BUILD_STAGES, BuildError, runBuild } from "./build.mjs";
import { CoverageError, requiredTiles } from "./coverage.mjs";
import { clipBoundsToTile } from "./deps.mjs";
import { LICENCE_ENTRY_PATH } from "./licence.mjs";
import { productionEnvelope, tilesInRange } from "./mercator.mjs";
import { ElevationFloorError } from "./region.mjs";
import { SOURCE_SAMPLE_SPACING_DEG as SPACING } from "./source.mjs";
import { encodeElevation } from "./terrarium.mjs";

const LICENCE = "Produced under terms. No liability. No endorsement. Recipients are bound.";
const ATTRIBUTION = {
  derivedWorksNotice: "Produced under terms.",
  liabilityStatement: "No liability.",
  noEndorsement: "No endorsement.",
  downstreamBinding: "Recipients are bound.",
};
// Small enough that the pyramid is a couple of tiles, so every case here renders real rasters
// without the suite becoming a benchmark.
const REGION = {
  id: "test-region",
  bounds: [6.5, 45.5, 6.51, 45.51],
  minElevationM: 2500,
  minElevationJustification: "above the reported treeline",
  minZoom: 14,
  maxZoom: 14,
};
/**
 * A cut lying **wholly west of 7°E** whose production envelope does not.
 *
 * Its single z14 tile spans 6.98730..7.00928, so the complete raster reaches past the meridian
 * even though the declared region stops short of it. That gap between "what was asked for" and
 * "what must be read" is the entire reason coverage moved off the declaration, and bounds that
 * straddled 7°E themselves — the first version of this fixture — could not show it: coverage
 * would have admitted both cells either way.
 */
const SEAM_REGION = { ...REGION, bounds: [6.99, 45.5, 6.995, 45.51] };
/**
 * A cut that **straddles** 7°E, so both cells contribute samples inside the declared region.
 *
 * Distinct from `SEAM_REGION` on purpose. That one proves the envelope pulls in a cell the
 * region never touches; this one proves the floor is judged across both cells when both are
 * genuinely part of the region. A cell outside the region contributes nothing to the floor,
 * which is correct and is why the two fixtures cannot be the same.
 */
const STRADDLE_REGION = { ...REGION, bounds: [6.995, 45.5, 7.005, 45.51] };

/** Computed, not written in, so the fixture cannot drift from what the envelope actually needs. */
const SEAM_CELLS = requiredTiles(
  productionEnvelope(SEAM_REGION.bounds, SEAM_REGION.minZoom, SEAM_REGION.maxZoom, SPACING),
);

const PATHS = {
  regionPath: "region.json",
  snapshotPath: "snapshot.json",
  licencePath: "LICENCE.txt",
  attributionPath: "attribution.json",
  archivePath: "out.pmtiles",
};

/**
 * A synthetic source crop for one cell's share of a region's production envelope.
 *
 * Laid out on the **global** sample lattice — indices are `lon · 3600`, not offsets from the
 * crop — so adjacent cells' crops abut exactly the way GLO-30's do and `stitchSurface` can join
 * them. Half-open at east and south, matching `cropWindow`, so no sample is claimed twice.
 */
function cropFor(tileId, region, elevationAt) {
  const envelope = productionEnvelope(region.bounds, region.minZoom, region.maxZoom, SPACING);
  const [west, south, east, north] = clipBoundsToTile(envelope, tileId);
  const first = (v) => Math.ceil(v / SPACING - 1e-6);
  const col0 = first(west);
  const cols = first(east) - col0;
  const row0 = first(-north);
  const rows = first(-south) - row0;
  const rgb = new Uint8Array(cols * rows * 3);
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const [red, green, blue] = encodeElevation(
        elevationAt((col0 + c) * SPACING, -(row0 + r) * SPACING),
      );
      const i = (r * cols + c) * 3;
      rgb[i] = red;
      rgb[i + 1] = green;
      rgb[i + 2] = blue;
    }
  }
  return {
    width: cols,
    height: rows,
    west: col0 * SPACING,
    north: -row0 * SPACING,
    pixelScaleDeg: SPACING,
    rgb,
  };
}

/** A gentle slope, well clear of the floor. */
const slope = (lon, lat) => 3000 + (lon - 6.5) * 400 + (lat - 45.5) * 300;

function harness(overrides = {}) {
  const calls = {
    readTile: [],
    readBounds: [],
    probe: [],
    wrote: [],
    finalised: [],
    discarded: [],
    archived: [],
  };
  const files = {
    "LICENCE.txt": LICENCE,
    "region.json": JSON.stringify(overrides.region ?? REGION),
    "attribution.json": JSON.stringify(ATTRIBUTION),
    ...overrides.files,
  };
  const deps = {
    readText: (p) => {
      if (!(p in files)) throw new Error(`no such file: ${p}`);
      return files[p];
    },
    readJson: (p) => JSON.parse(files[p]),
    // Async by default, so the whole suite runs against the shape the real seams have. A
    // sync fake would let every `await` in the build be dropped without a single test noticing
    // — the seams fetch, so the fakes return promises.
    probe: async (id) => {
      calls.probe.push(id);
      return (overrides.probe ?? (() => ({ status: 200 })))(id);
    },
    readTile: async (id, bounds) => {
      calls.readTile.push(id);
      calls.readBounds.push(bounds);
      const region = overrides.region ?? REGION;
      return (overrides.readTile ?? ((tileId) => cropFor(tileId, region, slope)))(id);
    },
    writeArchive: (path, tiles, meta) => {
      calls.wrote.push(path);
      calls.archived.push({ path, tiles, meta });
      return (
        overrides.writeArchive ??
        ((_p, _t, m) => ({
          entries: () => [
            { path: "LICENSE", text: m.licenceText },
            {
              path: "metadata.json",
              text: JSON.stringify({ ...m, licenceText: undefined }),
            },
          ],
        }))
      )(path, tiles, meta);
    },
    finaliseArchive: (from, to) => calls.finalised.push([from, to]),
    discardArchive: (path) => calls.discarded.push(path),
    now: () => new Date("2026-08-30"),
    // The snapshot loader is the one collaborator reached through `io`; a stub keeps this suite
    // about the ordering rather than about file digests, which coverage.test.mjs already pins.
    // Inside the literal, so an override can replace it — assigning after the spread silently
    // discarded whatever a caller passed.
    io: {
      readFileSync: () => "",
      dirname: () => ".",
      join: () => "list.txt",
      sha256: () => "",
      ...overrides.io,
    },
    ...overrides.deps,
  };
  return { deps, calls, files };
}

/** Replaces the snapshot loader by pre-seeding what it would have produced. */
function withSnapshot(deps, published, extra = {}) {
  const manifest = {
    source: "test",
    retrievedAt: "2026-08-01",
    maxAgeDays: 365,
    tileListFile: "list.txt",
    tileListSha256: "sha",
    tileCount: published.length,
    ...extra,
  };
  const list = published.join("\n");
  deps.io = {
    readFileSync: (p) => (p === "snapshot.json" ? JSON.stringify(manifest) : list),
    dirname: () => ".",
    join: () => "list.txt",
    sha256: () => "sha",
  };
  return deps;
}

describe("the order of the checks", () => {
  it("runs them cheapest-and-most-decisive first", () => {
    expect(BUILD_STAGES).toEqual([
      "licence",
      "region",
      "snapshot",
      "coverage",
      "elevation",
      "tiles",
      "archive",
    ]);
  });

  it("completes a build whose every obligation is met", async () => {
    const { deps, calls } = harness();
    withSnapshot(deps, ["N45E006"]);

    const report = await runBuild(PATHS, deps);

    expect(report.sourceCells).toEqual(["N45E006"]);
    expect(report.tileCount).toBeGreaterThan(0);
    expect(report.lowest.tileId).toBe("N45E006");
    expect(report.lowest.elevationM).toBeGreaterThanOrEqual(REGION.minElevationM);
    // Written partial, then named as the archive only once every check has passed.
    expect(calls.wrote).toEqual(["out.pmtiles.partial"]);
    expect(calls.finalised).toEqual([["out.pmtiles.partial", "out.pmtiles"]]);
    expect(calls.discarded).toEqual([]);
  });

  it("fails at the licence before touching the network or any tile", async () => {
    // The ordering claim, asserted by what did *not* happen. A build that reaches the
    // expensive stage and then fails comparing a string is correct and infuriating.
    const { deps, calls } = harness({
      files: { "attribution.json": JSON.stringify({ ...ATTRIBUTION, noEndorsement: "Invented." }) },
    });
    withSnapshot(deps, ["N45E006"]);

    const error = await catchBuild(() => runBuild(PATHS, deps));

    expect(error.stage).toBe("licence");
    expect(calls.probe).toEqual([]);
    expect(calls.readTile).toEqual([]);
    expect(calls.wrote).toEqual([]);
  });

  it("fails at coverage before reading a single tile", async () => {
    const { deps, calls } = harness({ probe: () => ({ status: 404 }) });
    withSnapshot(deps, []);

    const error = await catchBuild(() => runBuild(PATHS, deps));

    expect(error.stage).toBe("coverage");
    expect(calls.probe).toEqual(["N45E006"]);
    expect(calls.readTile).toEqual([]);
  });

  it("writes nothing when the floor is breached", async () => {
    const { deps, calls } = harness({ readTile: (id) => cropFor(id, REGION, () => 2400) });
    withSnapshot(deps, ["N45E006"]);

    const error = await catchBuild(() => runBuild(PATHS, deps));

    expect(error.stage).toBe("elevation");
    expect(calls.wrote).toEqual([]);
  });
});

describe("every source cell is read, and read as itself", () => {
  /** @param {object} overrides */
  function seamHarness(overrides = {}) {
    const { deps, calls } = harness({ ...overrides, region: SEAM_REGION });
    withSnapshot(deps, SEAM_CELLS);
    return { deps, calls };
  }

  it("requires both cells its envelope reaches, not only the one its bounds sit in", () => {
    // The declared region lies wholly west of 7°E; its production envelope does not. This is
    // the property the coverage move exists for.
    expect(requiredTiles(SEAM_REGION.bounds)).toEqual(["N45E006"]);
    expect(SEAM_CELLS).toEqual(["N45E006", "N45E007"]);
  });

  it("genuinely requires the second cell — a build fails at coverage without it", async () => {
    // The other half of the mandatory property. The test above shows both cells are *read*;
    // this shows the second is *admitted by coverage*, so it cannot be reached by a build that
    // never checked it. The snapshot lists it, so its absence is classified `unexpected` — a
    // released tile that has gone missing, not a region that was never viable.
    const { deps, calls } = harness({
      region: SEAM_REGION,
      probe: (id) => ({ status: id === "N45E007" ? 404 : 206 }),
    });
    withSnapshot(deps, SEAM_CELLS);

    const error = await catchBuild(() => runBuild(PATHS, deps));

    expect(error.stage).toBe("coverage");
    expect(error.cause.kind).toBe("unexpected");
    expect(error.message).toContain("N45E007");
    expect(calls.readTile).toEqual([]);
  });

  it("reads each cell against the envelope, not the declared region", async () => {
    // Found by running the whole chain against real data, not by this suite: the reader was
    // clipping each cell against the declaration while coverage admitted cells over the
    // envelope. For a cell east of the declared region the two do not intersect, and the clip
    // produced a degenerate box. The suite missed it because its fake computed the envelope
    // itself instead of being told one — a harness agreeing with the code rather than checking
    // it. This asserts the value that actually crosses the seam.
    const { deps, calls } = harness({ region: SEAM_REGION });
    withSnapshot(deps, SEAM_CELLS);

    const report = await runBuild(PATHS, deps);

    expect(calls.readBounds).toHaveLength(SEAM_CELLS.length);
    for (const bounds of calls.readBounds) expect(bounds).toEqual(report.envelope);
    expect(report.envelope[2]).toBeGreaterThan(SEAM_REGION.bounds[2]);
  });

  it("sizes the envelope with the interpolation halo the source actually needs", async () => {
    // `mercator.test.mjs` proves `productionEnvelope` adds a halo when asked; this proves the
    // build asks. Passing zero is a plausible-looking call that leaves the outermost output
    // pixels without a complete stencil — and whether that throws depends on where the tile
    // footprint happens to fall on the source lattice, so it is exactly the kind of defect that
    // works until the region moves.
    const { deps } = harness({ region: SEAM_REGION });
    withSnapshot(deps, SEAM_CELLS);

    const report = await runBuild(PATHS, deps);

    const bare = productionEnvelope(
      SEAM_REGION.bounds,
      SEAM_REGION.minZoom,
      SEAM_REGION.maxZoom,
      0,
    );
    expect(bare[0] - report.envelope[0]).toBeCloseTo(SPACING, 12);
    expect(report.envelope[2] - bare[2]).toBeCloseTo(SPACING, 12);
  });

  it("reads each admitted cell once, by its own id, in the order coverage returned them", async () => {
    const { deps, calls } = seamHarness();

    const report = await runBuild(PATHS, deps);

    expect(calls.readTile).toEqual(SEAM_CELLS);
    expect(report.sourceCells).toEqual(SEAM_CELLS);
  });

  it("fails on a floor breach that exists only in the second cell", async () => {
    // A first-cell-only read sees nothing below the floor and the build passes.
    const { deps } = harness({
      region: STRADDLE_REGION,
      readTile: (id) => cropFor(id, STRADDLE_REGION, id === "N45E007" ? () => 2400 : () => 3000),
    });
    withSnapshot(deps, SEAM_CELLS);

    const error = await catchBuild(() => runBuild(PATHS, deps));

    expect(error.stage).toBe("elevation");
    expect(error.message).toContain("N45E007");
    expect(error.message).toContain("2400 m");
  });

  it("attributes each cell's samples to that cell", async () => {
    const { deps } = harness({
      region: STRADDLE_REGION,
      readTile: (id) => cropFor(id, STRADDLE_REGION, id === "N45E007" ? () => 2550 : () => 2900),
    });
    withSnapshot(deps, SEAM_CELLS);

    expect((await runBuild(PATHS, deps)).lowest.tileId).toBe("N45E007");
  });

  it("reads one cell at a time rather than fetching the whole cut up front", async () => {
    // A read that fails on the first cell must stop there. An eager implementation — `map` into
    // `Promise.all` — issues both reads before anything inspects the first, so the second cell
    // appears in the log even though the build never got past the first.
    const { deps, calls } = seamHarness({
      readTile: (id) => {
        if (id === "N45E006") throw new Error("range read failed");
        return cropFor(id, SEAM_REGION, () => 3000);
      },
    });

    const error = await catchBuild(() => runBuild(PATHS, deps));

    expect(error.stage).toBe("elevation");
    expect(calls.readTile).toEqual(["N45E006"]);
  });

  it("judges the floor on the declared region, not on the envelope it had to read", async () => {
    // The distinction the real run forced. The envelope reaches a tile's width past the region,
    // which around a summit means valley floors — so a build that judged the envelope would
    // fail on terrain it only read in order to complete the edge tiles. Here the out-of-region
    // margin is far below the floor and the build must still succeed.
    const region = SEAM_REGION;
    const { deps } = harness({
      region,
      readTile: (id) =>
        // Half a sample of slack on each side. A sample sitting exactly on the region's edge
        // has its longitude reconstructed by multiplication, which lands a hair below the
        // bound — so a strict predicate here marks an in-region sample as outside and the test
        // fails on its own arithmetic rather than on the build's.
        cropFor(id, region, (lon, lat) =>
          lon >= region.bounds[0] - SPACING / 2 &&
          lon < region.bounds[2] + SPACING / 2 &&
          lat >= region.bounds[1] - SPACING / 2 &&
          lat < region.bounds[3] + SPACING / 2
            ? 3000
            : 200,
        ),
    });
    withSnapshot(deps, SEAM_CELLS);

    const report = await runBuild(PATHS, deps);

    expect(report.lowest.elevationM).toBeCloseTo(3000, 1);
  });
});

describe("what the build hands the writer", () => {
  it("advertises the declared region, not the production envelope it had to read", async () => {
    // The envelope is how complete tiles were produced; the bounds are what a consumer asked
    // for. Publishing the envelope would invite a renderer to request tiles outside the region,
    // and those tiles do not exist in the archive.
    const { deps, calls } = harness({ region: SEAM_REGION });
    withSnapshot(deps, SEAM_CELLS);

    const report = await runBuild(PATHS, deps);

    const { meta } = calls.archived[0];
    expect(meta.bounds).toEqual(SEAM_REGION.bounds);
    expect(report.envelope[2]).toBeGreaterThan(7);
    expect(meta.bounds[2]).toBeLessThan(7);
    expect(meta.bounds[2]).toBeLessThan(report.envelope[2]);
  });

  it("produces every zoom the declaration asks for, not just one", async () => {
    // A pyramid built from `minZoom` alone, or from `maxZoom` alone, is a plausible archive
    // that silently lacks half its levels — and nothing downstream would notice until a
    // renderer asked for the missing one.
    const region = { ...REGION, minZoom: 13, maxZoom: 14 };
    const { deps, calls } = harness({ region });
    withSnapshot(deps, ["N45E006"]);

    await runBuild(PATHS, deps);

    const zooms = new Set(calls.archived[0].tiles.map((t) => t.z));
    expect([...zooms].sort()).toEqual([13, 14]);
  });

  it("hands over every address in the pyramid, each exactly once", async () => {
    const region = { ...REGION, minZoom: 13, maxZoom: 14 };
    const { deps, calls } = harness({ region });
    withSnapshot(deps, ["N45E006"]);

    await runBuild(PATHS, deps);

    const { tiles } = calls.archived[0];
    const expected = [...tilesInRange(region.bounds, region.minZoom, region.maxZoom)];
    expect(tiles.map(({ z, x, y }) => `${z}/${x}/${y}`).sort()).toEqual(
      expected.map(({ z, x, y }) => `${z}/${x}/${y}`).sort(),
    );
    expect(new Set(tiles.map(({ z, x, y }) => `${z}/${x}/${y}`)).size).toBe(tiles.length);
  });

  it("refuses a source whose sample spacing is not the one the envelope was sized for", async () => {
    // The halo is computed from a declared constant *before* any header is read, so a source at
    // a finer grid makes it the wrong width — and a halo that is too small is a build sampling
    // outside the envelope coverage admitted. Nothing else in this suite varies the spacing, so
    // without this the assertion was unobservable and could be deleted with the suite green.
    const { deps } = harness({
      readTile: (id) => ({ ...cropFor(id, REGION, slope), pixelScaleDeg: SPACING / 2 }),
    });
    withSnapshot(deps, ["N45E006"]);

    const error = await catchBuild(() => runBuild(PATHS, deps));

    expect(error.stage).toBe("tiles");
    expect(error.message).toContain("production envelope");
  });

  it("hands over real PNG rasters, not empty or placeholder payloads", async () => {
    const { deps, calls } = harness();
    withSnapshot(deps, ["N45E006"]);

    await runBuild(PATHS, deps);

    for (const tile of calls.archived[0].tiles) {
      expect([...tile.bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
      expect(tile.bytes.length).toBeGreaterThan(1000);
    }
  });
});

describe("a seam that rejects is still that stage's failure", () => {
  // The failure mode `async` introduces. A rejection is not a throw: if a stage's promise
  // settles outside the `try` that wraps it, the build loses the stage label, `error.stage`
  // reads `undefined`, and the discard that a failing archive stage owes never runs. Each of
  // these passes trivially against a synchronous fake, which is why the harness's fakes are
  // async by default.
  it("labels a rejecting probe as coverage, and classifies it as unreachable", async () => {
    const { deps, calls } = harness({ probe: () => Promise.reject(new Error("socket hang up")) });
    withSnapshot(deps, ["N45E006"]);

    const error = await catchBuild(() => runBuild(PATHS, deps));

    expect(error.stage).toBe("coverage");
    expect(error.cause).toBeInstanceOf(CoverageError);
    expect(error.cause.kind).toBe("unreachable");
    expect(calls.readTile).toEqual([]);
  });

  it("labels a rejecting tile read as elevation", async () => {
    const { deps, calls } = harness({ readTile: () => Promise.reject(new Error("range failed")) });
    withSnapshot(deps, ["N45E006"]);

    const error = await catchBuild(() => runBuild(PATHS, deps));

    expect(error.stage).toBe("elevation");
    expect(error.cause.message).toBe("range failed");
    expect(calls.wrote).toEqual([]);
  });

  it("labels a rejecting writer as archive, and still discards the partial", async () => {
    const { deps, calls } = harness({ writeArchive: () => Promise.reject(new Error("disk full")) });
    withSnapshot(deps, ["N45E006"]);

    const error = await catchBuild(() => runBuild(PATHS, deps));

    expect(error).toBeInstanceOf(BuildError);
    expect(error.stage).toBe("archive");
    expect(error.cause.message).toBe("disk full");
    expect(calls.discarded).toEqual(["out.pmtiles.partial"]);
    expect(calls.finalised).toEqual([]);
  });

  it("waits for the partial to be discarded before reporting the failure", async () => {
    // The `await` on `discardArchive` is invisible against a synchronous fake — removing it
    // leaves the suite green — so the fake here defers over a **timer**. Microtasks drain
    // completely before any timer fires, so an unawaited discard is deterministically still
    // pending when the rejection surfaces, and the order below is the observation that
    // separates waiting from not. It matters once `discardArchive` is `fs.rm`: a rejection
    // nobody awaits is an unhandled rejection, which current Node treats as fatal.
    const order = [];
    const { deps } = harness({
      writeArchive: () => ({ entries: () => [] }),
      deps: {
        discardArchive: () =>
          new Promise((resolve) => {
            setTimeout(() => {
              order.push("discarded");
              resolve();
            }, 0);
          }),
      },
    });
    withSnapshot(deps, ["N45E006"]);

    await catchBuild(() => runBuild(PATHS, deps));
    order.push("reported");

    expect(order).toEqual(["discarded", "reported"]);
  });

  it("keeps the archive failure when the cleanup fails too, rather than reporting only the cleanup", async () => {
    // `discardArchive` is `fs.rm` on a path a failing build just wrote, so a rejection here is
    // plausible — and it arrives *after* the real failure, so a raw rethrow would replace the
    // reason the build failed with a permissions error and drop the stage with it.
    const { deps } = harness({
      writeArchive: () => {
        throw new Error("disk full");
      },
      deps: { discardArchive: () => Promise.reject(new Error("permission denied")) },
    });
    withSnapshot(deps, ["N45E006"]);

    const error = await catchBuild(() => runBuild(PATHS, deps));

    expect(error.stage).toBe("archive");
    expect(error.cause).toBeInstanceOf(AggregateError);
    expect(error.cause.errors.map((e) => e.message)).toEqual(["disk full", "permission denied"]);
  });

  it("resolves an awaited probe's status rather than carrying the promise into the check", async () => {
    // A dropped `await` on the probe destructures `status` from a promise, gets `undefined`,
    // and lands in the transport-failure arm — a build that fails on a tile that is present.
    const { deps } = harness({ probe: () => Promise.resolve({ status: 206 }) });
    withSnapshot(deps, ["N45E006"]);

    await expect(runBuild(PATHS, deps)).resolves.toMatchObject({ sourceCells: ["N45E006"] });
  });
});

describe("the classification seam between coverage and the gap rule", () => {
  // The property that only exists *between* the checks: a withheld tile and a broken fetch
  // must take different paths through the assembled build, not merely through `assertCoverage`
  // in isolation. If anything between here and the classifier catches a CoverageError and
  // recasts it, the three cases collapse into "the build failed" exactly where the distinction
  // stops being visible — and the snapshot that exists to draw it becomes decorative.
  it("carries a withheld tile through as unpublished", async () => {
    const { deps } = harness({ probe: () => ({ status: 404 }) });
    withSnapshot(deps, []);

    const error = await catchBuild(() => runBuild(PATHS, deps));

    expect(error.stage).toBe("coverage");
    expect(error.cause).toBeInstanceOf(CoverageError);
    expect(error.cause.kind).toBe("unpublished");
  });

  it("carries a listed-but-missing tile through as unexpected", async () => {
    const { deps } = harness({ probe: () => ({ status: 404 }) });
    withSnapshot(deps, ["N45E006"]);

    const error = await catchBuild(() => runBuild(PATHS, deps));

    expect(error.cause.kind).toBe("unexpected");
  });

  it("carries a broken fetch through as unreachable, not as an absence", async () => {
    const { deps } = harness({
      probe: () => {
        throw new Error("socket hang up");
      },
    });
    withSnapshot(deps, ["N45E006"]);

    const error = await catchBuild(() => runBuild(PATHS, deps));

    expect(error.cause.kind).toBe("unreachable");
  });

  it("gives the three cases three different kinds from one status and one exception", async () => {
    // Stated as one assertion because the claim is about the *set*: same 404 twice, different
    // kinds, and a thrown probe distinct from both. Any collapse shows up here as a duplicate.
    const cases = [
      [() => ({ status: 404 }), []],
      [() => ({ status: 404 }), ["N45E006"]],
      [
        () => {
          throw new Error("reset");
        },
        ["N45E006"],
      ],
    ];
    const kinds = [];
    for (const [probe, published] of cases) {
      const { deps } = harness({ probe });
      withSnapshot(deps, published);
      kinds.push((await catchBuild(() => runBuild(PATHS, deps))).cause.kind);
    }

    expect(kinds).toEqual(["unpublished", "unexpected", "unreachable"]);
    expect(new Set(kinds).size).toBe(3);
  });
});

describe("the codec and the floor are actually wired together", () => {
  // Neither module's own suite can reach this: `terrarium` never sees a floor and `region`
  // never sees a pixel. The build is where they meet, so a missing decode — feeding raw RGB
  // to the floor — is invisible until here. RGB(128,0,0) is sea level, so undecoded bytes
  // would compare as ~128 m and breach a 2,500 m floor with a nonsense number.
  it("compares decoded metres against the declared floor, not raw channel values", async () => {
    const { deps } = harness({ readTile: (id) => cropFor(id, REGION, () => 2550) });
    withSnapshot(deps, ["N45E006"]);

    expect((await runBuild(PATHS, deps)).lowest.elevationM).toBeCloseTo(2550, 2);
  });

  it("reports the breaching elevation in metres, so the failure is readable", async () => {
    const { deps } = harness({ readTile: (id) => cropFor(id, REGION, () => 2412.5) });
    withSnapshot(deps, ["N45E006"]);

    const error = await catchBuild(() => runBuild(PATHS, deps));

    expect(error.cause).toBeInstanceOf(ElevationFloorError);
    expect(error.message).toContain("2412.5 m");
    expect(error.message).toContain("2500 m");
  });
});

describe("the licence gate is on distribution, not on execution", () => {
  it("builds without licence inputs when the output is not distributable", async () => {
    // The design correction: the obligation is about redistributing a derived work, so it
    // belongs where an archive becomes downloadable. Gating execution meant a missing legal
    // string blocked the writer, the tile reader and the contour source, none of which
    // redistribute anything.
    const { deps, calls } = harness({
      files: { "LICENCE.txt": undefined, "attribution.json": undefined },
      writeArchive: () => ({ entries: () => [{ path: "NOT-FOR-DISTRIBUTION", text: "" }] }),
    });
    withSnapshot(deps, ["N45E006"]);

    const report = await runBuild(PATHS, deps, { distributable: false });

    expect(report.distributable).toBe(false);
    expect(report.roles).toEqual([]);
    expect(report.outputPath).toBe("out.pmtiles.dev");
    expect(calls.finalised).toEqual([["out.pmtiles.dev.partial", "out.pmtiles.dev"]]);
  });

  it("refuses a development archive that does not say it is one", async () => {
    // Not an exemption but a trade: no licence, but a marker, and the build fails without it
    // exactly as a distributable build fails without the notices.
    const { deps } = harness({ writeArchive: () => ({ entries: () => [] }) });
    withSnapshot(deps, ["N45E006"]);

    const error = await catchBuild(() => runBuild(PATHS, deps, { distributable: false }));

    expect(error.stage).toBe("archive");
    expect(error.message).toContain("must carry NOT-FOR-DISTRIBUTION");
  });

  it("still enforces the licence when the output is distributable", async () => {
    const { deps } = harness({
      files: { "attribution.json": JSON.stringify({ ...ATTRIBUTION, noEndorsement: "Invented." }) },
    });
    withSnapshot(deps, ["N45E006"]);

    expect((await catchBuild(() => runBuild(PATHS, deps, { distributable: true }))).stage).toBe(
      "licence",
    );
    expect((await catchBuild(() => runBuild(PATHS, deps))).stage).toBe("licence");
  });
});

describe("the archive must carry what it was built under", () => {
  it("fails when the writer omits the LICENSE", async () => {
    const { deps } = harness({ writeArchive: () => ({ entries: () => [] }) });
    withSnapshot(deps, ["N45E006"]);

    const error = await catchBuild(() => runBuild(PATHS, deps));

    expect(error.stage).toBe("archive");
    expect(error.message).toContain("carries no LICENSE");
  });

  it("fails when the strings were validated but never emitted", async () => {
    // The half of obligation 1 that a validate-only build satisfies on paper: the declaration
    // is checked against the licence and then dropped, leaving recipients no attribution while
    // every earlier check passes. Only an assertion over what the archive *emits* catches it.
    const { deps } = harness({
      writeArchive: (_p, _t, m) => ({ entries: () => [{ path: "LICENSE", text: m.licenceText }] }),
    });
    withSnapshot(deps, ["N45E006"]);

    const error = await catchBuild(() => runBuild(PATHS, deps));

    expect(error.stage).toBe("archive");
    expect(error.message).toContain("never reaches the archive");
    expect(error.message).toContain("only LICENSE");
  });

  it("hands the writer the attribution as well as the licence", async () => {
    let received;
    const { deps } = harness({
      writeArchive: (_p, _t, m) => {
        received = m.attribution;
        return {
          entries: () => [
            { path: "LICENSE", text: m.licenceText },
            { path: "meta", text: Object.values(m.attribution).join(" ") },
          ],
        };
      },
    });
    withSnapshot(deps, ["N45E006"]);

    await runBuild(PATHS, deps);

    expect(received).toEqual(ATTRIBUTION);
  });

  it.each([
    {
      note: "the writer itself throws",
      overrides: {
        writeArchive: () => {
          throw new Error("disk full");
        },
      },
    },
    {
      note: "finalising fails",
      overrides: {
        deps: {
          finaliseArchive: () => {
            throw new Error("rename failed");
          },
        },
      },
    },
  ])("discards the partial when $note", async ({ overrides }) => {
    const { deps, calls } = harness(overrides);
    withSnapshot(deps, ["N45E006"]);

    await catchBuild(() => runBuild(PATHS, deps));

    expect(calls.discarded).toEqual(["out.pmtiles.partial"]);
    expect(calls.finalised).toEqual([]);
  });

  it("uses one licence entry name for both halves of the obligation", async () => {
    // The two checks are halves of one obligation and must agree on this name. Were it a
    // literal at one call site and a default parameter at the other, renaming it in one place
    // would leave the attribution check excluding an entry that no longer exists — the licence
    // entry would re-enter the scanned set and every declared string would be found inside it.
    const paths = [];
    const { deps } = harness({
      writeArchive: (_p, _t, m) => ({
        entries: () => [
          { path: LICENCE_ENTRY_PATH, text: m.licenceText },
          { path: "meta", text: Object.values(m.attribution).join(" ") },
        ],
      }),
      deps: {
        discardArchive: (p) => paths.push(p),
      },
    });
    withSnapshot(deps, ["N45E006"]);

    await expect(runBuild(PATHS, deps)).resolves.toBeDefined();
    expect(paths).toEqual([]);
  });

  it("discards the partial archive rather than leaving a failing one on disk", async () => {
    // A failed build that leaves a usable-looking artifact is worse than one that leaves
    // nothing: `/lab` and the browser scenario would pick up an archive whose licence checks
    // did not pass.
    const { deps, calls } = harness({ writeArchive: () => ({ entries: () => [] }) });
    withSnapshot(deps, ["N45E006"]);

    await catchBuild(() => runBuild(PATHS, deps));

    expect(calls.discarded).toEqual(["out.pmtiles.partial"]);
    expect(calls.finalised).toEqual([]);
  });
});

/** @returns {Promise<BuildError>} */
async function catchBuild(fn) {
  try {
    await fn();
  } catch (error) {
    if (error instanceof BuildError) return error;
    throw error;
  }
  throw new Error("expected a BuildError, but nothing was thrown");
}
