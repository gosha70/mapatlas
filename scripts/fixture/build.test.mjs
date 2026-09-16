// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { BUILD_STAGES, BuildError, runBuild } from "./build.mjs";
import { cropTrace, observeCrop } from "./crop-trace.mjs";
import { CoverageError, requiredTiles } from "./coverage.mjs";
import { clipBoundsToTile, encodeRasterTile } from "./deps.mjs";
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
  zoomJustification: "one z14 tile keeps the suite fast",
  contourIntervalM: 100,
  contourIntervalJustification: "100 m across the test ramp gives several levels",
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
  terrainArchivePath: "out.pmtiles",
  contourArchivePath: "out-contours.pmtiles",
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
  const crop = {
    width: cols,
    height: rows,
    west: col0 * SPACING,
    north: -row0 * SPACING,
    pixelScaleDeg: SPACING,
    rgb,
  };
  // Diagnostic only (T8.1, issue #30). This is the construction site on the path that has been
  // failing intermittently: `west` and `width` are both derived from `col0` here, so a report in
  // which they disagree has to have acquired that disagreement somewhere, and this is the first
  // place that can be ruled in or out.
  observeCrop(crop, "construction", {
    tileId,
    clippedTo: [west, south, east, north],
    col0,
    row0,
  });
  return crop;
}

/**
 * A slope well clear of the floor, with enough relief to carry contours.
 *
 * The gradient is steep because the test region is 0.01° across: at a gentler one the whole
 * region spanned 7 m, which contains no multiple of the 100 m interval, and the build refused it
 * — correctly. Here it spans some 700 m, so several levels fall inside.
 */
const slope = (lon, lat) => 3000 + (lon - 6.5) * 40000 + (lat - 45.5) * 30000;

/**
 * Terrain whose minimum is **exactly** `base`, with relief above it.
 *
 * Flat test terrain used to be enough, and is not any more: a region containing no multiple of
 * the contour interval has no contour lines, and the build now refuses that rather than shipping
 * an empty vector layer. The western part is held flat at `base` so a floor failure can still
 * name an exact metre value, while the east rises far enough to cross several interval
 * multiples.
 */
const ramp = (region, base) => (lon) =>
  base + Math.max(0, (lon - (region.bounds[0] + 0.003)) * 100000);

function harness(overrides = {}) {
  const calls = {
    readTile: [],
    readBounds: [],
    order: [],
    probe: [],
    encoded: [],
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
    encodeRasterTile: (surface, z, x, y) => {
      // Counted, then delegated to the production binding: several tests assert real payload
      // bytes (distinct payloads per address, byte-identical reproduction), so a stub here
      // would hollow them out. The count is the new observable, not a replacement encoder.
      calls.encoded.push(`${z}/${x}/${y}`);
      calls.order.push(`encoded:${z}/${x}/${y}`);
      return encodeRasterTile(surface, z, x, y);
    },
    writeArchive: (path, tiles, meta) => {
      calls.wrote.push(path);
      calls.order.push(`wrote:${path}`);
      calls.archived.push({ path, tiles, meta });
      return (
        overrides.writeArchive ??
        ((_p, _t, m) => ({
          entries: () =>
            m.distributable
              ? [
                  { path: "LICENSE", text: m.licenceText },
                  {
                    path: "metadata.json",
                    text: JSON.stringify({ ...m, licenceText: undefined }),
                  },
                ]
              : [
                  { path: "NOT-FOR-DISTRIBUTION", text: "dev" },
                  {
                    path: "metadata.json",
                    text: JSON.stringify({ ...m, licenceText: undefined }),
                  },
                ],
        }))
      )(path, tiles, meta);
    },
    finaliseArchive: (from, to) => {
      calls.order.push(`finalised:${to}`);
      calls.finalised.push([from, to]);
    },
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
      "contours",
      "archive",
    ]);
  });

  it("completes a build whose every obligation is met", async () => {
    const { deps, calls } = harness();
    withSnapshot(deps, ["N45E006"]);

    const report = await runBuild(PATHS, deps);

    expect(report.sourceCells).toEqual(["N45E006"]);
    expect(report.archives.map((a) => a.kind)).toEqual(["terrain", "contours"]);
    expect(report.lowest.tileId).toBe("N45E006");
    expect(report.lowest.elevationM).toBeGreaterThanOrEqual(REGION.minElevationM);
    // Written partial, then named as the archive only once every check has passed.
    // Both archives, and **every partial written before any is renamed**. A build that
    // finalised terrain and then failed on contours would leave a half-built stack that looks
    // complete.
    expect(calls.wrote).toEqual(["out.pmtiles.partial", "out-contours.pmtiles.partial"]);
    expect(calls.finalised).toEqual([
      ["out.pmtiles.partial", "out.pmtiles"],
      ["out-contours.pmtiles.partial", "out-contours.pmtiles"],
    ]);
    expect(calls.discarded).toEqual([]);
    expect(report.archives.map((a) => a.kind)).toEqual(["terrain", "contours"]);
    for (const archive of report.archives) expect(archive.tiles).toBeGreaterThan(0);
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
    const { deps, calls } = harness({ readTile: (id) => cropFor(id, REGION, ramp(REGION, 2400)) });
    withSnapshot(deps, ["N45E006"]);

    const error = await catchBuild(() => runBuild(PATHS, deps));

    expect(error.stage).toBe("elevation");
    expect(calls.wrote).toEqual([]);
  });

  it("encodes no raster tile before the floor has passed", async () => {
    // **The invariant the 2026-09-02 audit found real but unpinned.** "Expensive work must not
    // begin before a global rejection condition passes" is exactly what a harmless-looking
    // pipeline refactor regresses: a message-faithful mutant that deferred the floor comparison
    // past encoding survived the whole suite, because encoding was a static import observable
    // by nothing. The assertion is the encoder's invocation count — zero — not the stage label,
    // not the message, and not the archive writes, all of which the mutant reproduced.
    const { deps, calls } = harness({ readTile: (id) => cropFor(id, REGION, ramp(REGION, 2400)) });
    withSnapshot(deps, ["N45E006"]);

    const error = await catchBuild(() => runBuild(PATHS, deps));

    expect(error.stage).toBe("elevation");
    expect(calls.encoded, "raster tiles were encoded before the floor was judged").toEqual([]);
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
        return cropFor(id, SEAM_REGION, ramp(SEAM_REGION, 3000));
      },
    });

    const error = await catchBuild(() => runBuild(PATHS, deps));

    expect(error.stage).toBe("elevation");
    expect(calls.readTile).toEqual(["N45E006"]);
  });

  /**
   * **The instrument, end to end, through the build that actually fails.** (T8.1, issue #30.)
   *
   * The observation sites are spread across three files — the crop's construction here, several
   * points in `build.mjs` (each pass of `readCrops`, after the floor check, before the spacing
   * check), and `stitchSurface`'s own entry — and the unit tests for the trace call `observeCrop`
   * themselves, so deleting any one of those production call sites leaves them green. What is
   * asserted here is the wiring: that a real `runBuild` failure carries the **complete staged
   * path** for both crops — every stage, in order, under the indices the placement report uses,
   * including the first crop's observations from the pass that reads the second — with the
   * divergence named between the right pair of them.
   *
   * The overlap is **deterministic**, and it is the eastern crop that moves rather than the
   * western one. Moving the western crop east would take it out of the declared region, and the
   * build would then fail at the floor with no samples to judge — before it ever reached the
   * stitch. Moving the eastern crop onto the western origin leaves both cells contributing to
   * the floor and reproduces the arrangement issue #30 reports: two crops, one origin.
   */
  it("carries every observation of a crop into the failure the build reports", async () => {
    const westOrigin = 25154 * SPACING;
    const { deps } = seamHarness({
      readTile: (id) => {
        const crop = cropFor(id, SEAM_REGION, slope);
        // After construction, so the construction snapshot records what was built and the later
        // stages record what the stitch is handed. This is the shape of the failure, produced on
        // purpose; it is not a claim about how the intermittent one arises.
        if (id === "N45E007") crop.west = westOrigin;
        return crop;
      },
    });

    const error = await catchBuild(() => runBuild(PATHS, deps));

    expect(error.stage).toBe("tiles");
    const message = error.message;
    expect(message).toContain(
      "the crops do not tile their union: 0 sample(s) covered by none and 3955 by more than one",
    );
    // Every stage, for the crop that moved, naming the file each one lives in by what it knows.
    expect(message).toContain(
      `construction: tileId N45E007, clippedTo [7, 45.49066791484954, 7.009555121527778, ` +
        `45.5220216747714], col0 25200, row0 -163879, 35x113, origin (7, 45.52194444444444)`,
    );
    const ENVELOPE =
      "envelope [6.987026909722222, 45.49066791484954, 7.009555121527778, 45.5220216747714]";
    const moved = (stage) =>
      `${stage}: index 1, 35x113, origin (${String(westOrigin)}, 45.52194444444444)`;
    expect(message).toContain(
      `after readTile (reading N45E007): index 1, ${ENVELOPE}, 35x113, ` +
        `origin (${String(westOrigin)}, 45.52194444444444)`,
    );
    expect(message).toContain(moved("after regionWindow (reading N45E007)"));
    expect(message).toContain(moved("after samplesIn consumed (reading N45E007)"));
    expect(message).toContain(moved("after the floor check"));
    expect(message).toContain(moved("before the spacing check"));
    expect(message).toContain(moved("stitchSurface entry"));
    expect(message).toContain(
      `first divergence between "construction" and "after readTile (reading N45E007)": ` +
        `west 7 -> ${String(westOrigin)}`,
    );

    /**
     * **The crop that is not being read is observed too**, and this is the assertion that pins it.
     * The crop that moves in the real failure is the *first* one, which is read, judged and
     * consumed before the second cell is fetched at all — so an instrument that observed only the
     * pass's own crop would be blind to a change occurring while the second cell is read or its
     * samples consumed, which is exactly the span the probe pointed at.
     */
    const held = (stage) =>
      `${stage}: index 0, 46x113, origin (6.987222222222222, 45.52194444444444)`;
    expect(message).toContain(
      `after readTile (reading N45E007): index 0, ${ENVELOPE}, 46x113, ` +
        `origin (6.987222222222222, 45.52194444444444)`,
    );
    expect(message).toContain(held("after regionWindow (reading N45E007)"));
    expect(message).toContain(held("after samplesIn consumed (reading N45E007)"));

    // **Asserted in order, not merely present.** Two observations that both fire but in the wrong
    // sequence would print a trace whose divergence is attributed to the wrong span — which is the
    // only thing this instrument is for. The order is the order of the call sites, so it is the
    // call sites this pins.
    const inOrder = (lines) => {
      const at = lines.map((line) => message.indexOf(line));
      expect(at).not.toContain(-1);
      expect([...at].sort((a, b) => a - b)).toStrictEqual(at);
    };
    inOrder([
      "construction: tileId N45E007",
      "after readTile (reading N45E007): index 1",
      "after regionWindow (reading N45E007): index 1",
      "after samplesIn consumed (reading N45E007): index 1",
      "after the floor check: index 1",
      "before the spacing check: index 1",
      "stitchSurface entry: index 1",
    ]);
    // The first crop's whole path, both passes included and in pass order rather than interleaved.
    // Listed complete, not sampled: an ordering oracle that skips stages cannot notice a stage
    // that moved into one of the gaps it skipped.
    inOrder([
      "construction: tileId N45E006",
      "after readTile (reading N45E006): index 0",
      "after regionWindow (reading N45E006): index 0",
      "after samplesIn consumed (reading N45E006): index 0",
      "after readTile (reading N45E007): index 0",
      "after regionWindow (reading N45E007): index 0",
      "after samplesIn consumed (reading N45E007): index 0",
      "after the floor check: index 0",
      "before the spacing check: index 0",
      "stitchSurface entry: index 0",
    ]);

    // Ten observations of the crop read first, seven of the crop read second: the difference is
    // the first crop's second pass, which is the whole point of observing all of them.
    expect(message).toContain("[0] observed 10 time(s):");
    expect(message).toContain("[1] observed 7 time(s):");
    expect(message).toContain("no field changed between observations");
  });

  /**
   * **"Consumed" and "abandoned" are different stages, and the difference is asserted.**
   * (T8.1, issue #30.) The floor check stops at the first non-finite sample, which closes the
   * iterable early — and a report that labelled that "consumed" would tell a reader the crop's
   * samples had all been read when they had not, in the one span the evidence points at. Read off
   * the crop's own trace rather than off a failure message, because this build fails at the floor
   * and never reaches the stitch that prints one.
   */
  it("says when a crop's samples were abandoned rather than consumed", async () => {
    const read = [];
    const { deps } = seamHarness({
      readTile: (id) => {
        const crop = cropFor(id, SEAM_REGION, slope);
        // One sample's worth of payload for a 46x113 crop: the scan runs off the end, decodes a
        // non-finite value and the floor check stops there.
        if (id === "N45E006") crop.rgb = crop.rgb.subarray(0, 3);
        read.push(crop);
        return crop;
      },
    });

    const error = await catchBuild(() => runBuild(PATHS, deps));

    expect(error.stage).toBe("elevation");
    const stages = cropTrace(read[0]).map((snapshot) => snapshot.stage);
    expect(stages).toContain("after samplesIn abandoned (reading N45E006)");
    expect(stages).not.toContain("after samplesIn consumed (reading N45E006)");
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
        // In-region terrain must carry relief, or there are no contour levels and the build
        // refuses the fixture — flat ground genuinely has no contours.
        cropFor(id, region, (lon, lat) =>
          lon >= region.bounds[0] - SPACING / 2 &&
          lon < region.bounds[2] + SPACING / 2 &&
          lat >= region.bounds[1] - SPACING / 2 &&
          lat < region.bounds[3] + SPACING / 2
            ? ramp(region, 3000)(lon)
            : 200,
        ),
    });
    withSnapshot(deps, SEAM_CELLS);

    const report = await runBuild(PATHS, deps);

    expect(report.lowest.elevationM).toBeCloseTo(3000, 1);
  });
});

describe("what the build hands the writer", () => {
  it("writes and checks every archive before naming any of them", async () => {
    // The set-level version of "a failed build must not leave a usable-looking artifact". If
    // terrain were finalised before contours were even written, a contour failure would leave a
    // half-built stack that looks complete to anything reading the finalised paths. Asserted on
    // the interleaving, because the per-archive assertions pass either way.
    const { deps, calls } = harness();
    withSnapshot(deps, ["N45E006"]);

    await runBuild(PATHS, deps);

    const firstFinalise = calls.order.findIndex((e) => e.startsWith("finalised:"));
    const lastWrite = calls.order.map((e) => e.startsWith("wrote:")).lastIndexOf(true);
    const lastEncode = calls.order.map((e) => e.startsWith("encoded:")).lastIndexOf(true);
    // Four raster encodes, two writes, two finalises — and in that order. The encode entries
    // arrived with the encodeRasterTile seam; the exact length keeps this the test that notices
    // a new kind of work appearing in the pipeline at all.
    expect(calls.order).toHaveLength(8);
    expect(lastEncode).toBeLessThan(calls.order.findIndex((e) => e.startsWith("wrote:")));
    expect(lastWrite).toBeLessThan(firstFinalise);
  });

  it("derives the contour levels from the declared region, not from the envelope it read", async () => {
    // **Not observable in the tiles.** A level below the region's minimum traces a contour that
    // lies outside the region, and tiling clips it away — so region-derived and envelope-derived
    // levels produce byte-identical output and differ only in work done. The levels the build
    // reports are the only place the requirement can be seen, which is why it reports them.
    const { deps } = harness();
    withSnapshot(deps, ["N45E006"]);

    const report = await runBuild(PATHS, deps);
    const envelopeRange = { lowest: Infinity, highest: -Infinity };
    // The envelope reaches beyond the region on both sides, so its range strictly contains the
    // region's — asserted, so this cannot pass by the two happening to coincide.
    for (const lon of [report.envelope[0], report.envelope[2]]) {
      const value = slope(lon, (report.envelope[1] + report.envelope[3]) / 2);
      envelopeRange.lowest = Math.min(envelopeRange.lowest, value);
      envelopeRange.highest = Math.max(envelopeRange.highest, value);
    }
    expect(envelopeRange.lowest).toBeLessThan(Math.min(...report.contourLevels));
    expect(envelopeRange.highest).toBeGreaterThan(Math.max(...report.contourLevels));

    // Every reported level lies inside the region's own range.
    const region = { lowest: report.lowest.elevationM };
    for (const level of report.contourLevels) {
      expect(level).toBeGreaterThanOrEqual(region.lowest);
      expect(level % REGION.contourIntervalM).toBe(0);
    }
    expect(report.contourLevels.length).toBeGreaterThan(0);
  });

  it("unpublishes the first archive when a later promotion fails", async () => {
    // **Promotion is not atomic and cannot be made so**: renaming several files is several
    // operations. The earlier test fails *every* rename, so it only ever exercises the first and
    // says nothing about this — terrain renamed successfully and stayed published while contours
    // did not, leaving half a stack that looks complete to anything reading the finalised paths.
    let renames = 0;
    const { deps, calls } = harness({
      deps: {
        finaliseArchive: (from, to) => {
          renames += 1;
          calls.finalised.push([from, to]);
          if (renames === 2) throw new Error("rename failed");
        },
      },
    });
    withSnapshot(deps, ["N45E006"]);

    const error = await catchBuild(() => runBuild(PATHS, deps));

    expect(error.stage).toBe("archive");
    expect(renames).toBe(2); // the second was attempted, so the first had already published
    // Both the promoted final path and every partial are cleaned up.
    expect(calls.discarded).toContain("out.pmtiles");
    expect(calls.discarded).toContain("out.pmtiles.partial");
    expect(calls.discarded).toContain("out-contours.pmtiles.partial");
  });

  it("attempts every cleanup even when the first one fails", async () => {
    // A loop that awaited each discard in turn stopped at the first rejection, so a failure
    // cleaning up terrain left the contour partial on disk — the cleanup's own failure becoming
    // a second leak, silently.
    const attempted = [];
    const { deps } = harness({
      writeArchive: () => {
        throw new Error("disk full");
      },
      deps: {
        discardArchive: (path) => {
          attempted.push(path);
          if (attempted.length === 1) return Promise.reject(new Error("permission denied"));
          return Promise.resolve();
        },
      },
    });
    withSnapshot(deps, ["N45E006"]);

    const error = await catchBuild(() => runBuild(PATHS, deps));

    expect(attempted).toEqual(["out.pmtiles.partial", "out-contours.pmtiles.partial"]);
    // The build failure is still the story, with the cleanup failure kept alongside it.
    expect(error.stage).toBe("archive");
    expect(error.cause).toBeInstanceOf(AggregateError);
    expect(error.cause.errors[0].message).toBe("disk full");
  });

  it("refuses a region with too little relief to carry a contour at the declared interval", async () => {
    // Flat ground genuinely has no contours, and `levelsFor` says so by returning nothing. What
    // to do about that is the build's judgement: a fixture whose vector layer is empty does not
    // demonstrate contours, which is what the archive exists for. The message names the
    // declaration as the thing to change, since the terrain is not wrong.
    const { deps } = harness({ readTile: (id) => cropFor(id, REGION, () => 3000) });
    withSnapshot(deps, ["N45E006"]);

    const error = await catchBuild(() => runBuild(PATHS, deps));

    expect(error.stage).toBe("contours");
    expect(error.message).toContain("no multiple of the declared 100 m contour interval");
    expect(error.message).toContain("declare a smaller interval");
  });

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
    expect(calls.discarded).toEqual(["out.pmtiles.partial", "out-contours.pmtiles.partial"]);
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

    // Two archives, so two discards — and both must complete before the failure surfaces.
    expect(order).toEqual(["discarded", "discarded", "reported"]);
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
    // The build failure first, then **one entry per path that could not be cleaned up** — two,
    // because there are two archives and this discard rejects for both. Flat rather than nested,
    // so the reason the build failed is not buried under a wrapper describing the cleanup.
    // Each cleanup failure **names the path it could not remove**, with the raw rejection kept
    // as its cause: `discardArchive` is injected and nothing obliges its errors to identify
    // anything, so three bare "permission denied"s would say nothing about what is still there.
    expect(error.cause.errors[0].message).toBe("disk full");
    expect(error.cause.errors.slice(1).map((e) => e.message)).toEqual([
      "could not discard out.pmtiles.partial",
      "could not discard out-contours.pmtiles.partial",
    ]);
    for (const failure of error.cause.errors.slice(1)) {
      expect(failure.cause.message).toBe("permission denied");
    }
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
    const { deps } = harness({ readTile: (id) => cropFor(id, REGION, ramp(REGION, 2550)) });
    withSnapshot(deps, ["N45E006"]);

    expect((await runBuild(PATHS, deps)).lowest.elevationM).toBeCloseTo(2550, 2);
  });

  it("reports the breaching elevation in metres, so the failure is readable", async () => {
    const { deps } = harness({ readTile: (id) => cropFor(id, REGION, ramp(REGION, 2412.5)) });
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
    expect(report.archives.map((a) => a.path)).toEqual([
      "out.pmtiles.dev",
      "out-contours.pmtiles.dev",
    ]);
    expect(calls.finalised).toEqual([
      ["out.pmtiles.dev.partial", "out.pmtiles.dev"],
      ["out-contours.pmtiles.dev.partial", "out-contours.pmtiles.dev"],
    ]);
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
      writeArchive: (_p, _t, m) => ({
        entries: () => [{ path: "LICENSE", text: m.licenceText }],
      }),
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

  it("discards only the partials when the writer fails before promotion", async () => {
    // Promotion never begins, so a previous build's pair is untouched and still consistent with
    // itself. Removing it because an unrelated rebuild failed early would be gratuitous.
    const { deps, calls } = harness({
      writeArchive: () => {
        throw new Error("disk full");
      },
    });
    withSnapshot(deps, ["N45E006"]);

    await catchBuild(() => runBuild(PATHS, deps));

    expect(calls.discarded).toEqual(["out.pmtiles.partial", "out-contours.pmtiles.partial"]);
    expect(calls.finalised).toEqual([]);
  });

  it("discards only the partials when the first rename fails", async () => {
    // The transaction boundary, on its early side. A rename that **throws has modified
    // nothing**, so a previous build's pair is still whole — deleting it would destroy good
    // output over a failure that touched none of it. This is distinct from the writer failing:
    // here promotion was attempted and did not take.
    const { deps, calls } = harness({
      deps: {
        finaliseArchive: () => {
          throw new Error("rename failed");
        },
      },
    });
    withSnapshot(deps, ["N45E006"]);

    await catchBuild(() => runBuild(PATHS, deps));

    expect(calls.discarded).toEqual(["out.pmtiles.partial", "out-contours.pmtiles.partial"]);
  });

  it("discards every final and every partial once a rename has landed", async () => {
    // The late side. Once one rename succeeds the pair on disk is a mixture of this build and
    // the last, whatever happens next — so a failure leaves **no** archive. Removing only what
    // this build promoted would leave a previous counterpart published beside nothing, which is
    // the same half-built stack assembled from two builds.
    let renames = 0;
    const { deps, calls } = harness({
      deps: {
        finaliseArchive: (from, to) => {
          renames += 1;
          calls.finalised.push([from, to]);
          if (renames === 2) throw new Error("rename failed");
        },
      },
    });
    withSnapshot(deps, ["N45E006"]);

    await catchBuild(() => runBuild(PATHS, deps));

    expect(renames).toBe(2);
    // **Order is the assertion, not just membership.** Finals are the only paths a consumer can
    // see, so all of them go before any effort is spent on a `.partial` nothing reads — an
    // interleaved order leaves the contour archive visible for as long as the terrain partial's
    // removal takes.
    expect(calls.discarded).toEqual([
      "out.pmtiles",
      "out-contours.pmtiles",
      "out.pmtiles.partial",
      "out-contours.pmtiles.partial",
    ]);
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
          { path: "LICENSE", text: m.licenceText },
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

    expect(calls.discarded).toEqual(["out.pmtiles.partial", "out-contours.pmtiles.partial"]);
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
