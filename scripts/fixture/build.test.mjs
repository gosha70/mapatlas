// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { BUILD_STAGES, BuildError, runBuild } from "./build.mjs";
import { CoverageError } from "./coverage.mjs";
import { LICENCE_ENTRY_PATH } from "./licence.mjs";
import { ElevationFloorError } from "./region.mjs";
import { encodeElevation } from "./terrarium.mjs";

const LICENCE = "Produced under terms. No liability. No endorsement. Recipients are bound.";
const ATTRIBUTION = {
  derivedWorksNotice: "Produced under terms.",
  liabilityStatement: "No liability.",
  noEndorsement: "No endorsement.",
  downstreamBinding: "Recipients are bound.",
};
const REGION = {
  id: "test-region",
  bounds: [6.5, 45.5, 6.6, 45.6],
  minElevationM: 2500,
  minElevationJustification: "above the reported treeline",
};
/**
 * A cut spanning two source cells.
 *
 * Every other case here uses a single-tile region, and a single tile cannot observe the two
 * mistakes that matter most in the read loop: reading only the first tile, and reading the
 * first tile's bytes under every tile's name. Both produce a build that passes.
 */
const REGION_TWO_TILES = { ...REGION, bounds: [6.5, 45.5, 7.5, 45.6] };
const TWO_TILES = ["N45E006", "N45E007"];

const PATHS = {
  regionPath: "region.json",
  snapshotPath: "snapshot.json",
  licencePath: "LICENCE.txt",
  attributionPath: "attribution.json",
  archivePath: "out.pmtiles",
};

/** A tile of pixels that decode to the given metres — the codec and the floor, actually wired. */
const tileAt = (...metres) => metres.map((m) => encodeElevation(m));

function harness(overrides = {}) {
  const calls = { readTile: [], probe: [], wrote: [], finalised: [], discarded: [] };
  const files = {
    "LICENCE.txt": LICENCE,
    "region.json": JSON.stringify(REGION),
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
    readTile: async (id) => {
      calls.readTile.push(id);
      return (overrides.readTile ?? (() => tileAt(2600, 2700)))(id);
    },
    writeArchive: (path, tiles, licenceText, attribution) => {
      calls.wrote.push(path);
      return (
        overrides.writeArchive ??
        ((_p, _t, text, declared) => ({
          entries: () => [
            { path: "LICENSE", text },
            { path: "metadata.json", text: Object.values(declared).join(" ") },
          ],
        }))
      )(path, tiles, licenceText, attribution);
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
      "archive",
    ]);
  });

  it("completes a build whose every obligation is met", async () => {
    const { deps, calls } = harness();
    withSnapshot(deps, ["N45E006"]);

    const report = await runBuild(PATHS, deps);

    expect(report.tiles).toEqual(["N45E006"]);
    expect(report.lowest).toEqual({ elevationM: 2600, tileId: "N45E006", sampleIndex: 0 });
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
    const { deps, calls } = harness({ readTile: () => tileAt(2600, 2400) });
    withSnapshot(deps, ["N45E006"]);

    const error = await catchBuild(() => runBuild(PATHS, deps));

    expect(error.stage).toBe("elevation");
    expect(calls.wrote).toEqual([]);
  });
});

describe("every declared tile is read, and read as itself", () => {
  /** @param {object} overrides */
  function twoTileHarness(overrides = {}) {
    const { deps, calls } = harness({
      ...overrides,
      files: { "region.json": JSON.stringify(REGION_TWO_TILES), ...overrides.files },
    });
    withSnapshot(deps, TWO_TILES);
    return { deps, calls };
  }

  it("reads each required tile once, by its own id, in the order coverage returned them", async () => {
    const { deps, calls } = twoTileHarness();

    const report = await runBuild(PATHS, deps);

    expect(calls.readTile).toEqual(TWO_TILES);
    expect(report.tiles).toEqual(TWO_TILES);
  });

  it("fails on a floor breach that exists only in the second tile", async () => {
    // The assertion that a first-tile-only read cannot survive. Reading N45E006 twice — or
    // reading it once and stopping — sees nothing below the floor, and the build passes.
    const { deps } = twoTileHarness({
      readTile: (id) => (id === "N45E007" ? tileAt(2600, 2400) : tileAt(3000, 3100)),
    });

    const error = await catchBuild(() => runBuild(PATHS, deps));

    expect(error.stage).toBe("elevation");
    expect(error.message).toContain("N45E007");
    expect(error.message).toContain("2400 m");
  });

  it("attributes each tile's samples to that tile", async () => {
    // The other half of the same mistake: reading the first tile's bytes under the second
    // tile's name reports a correct-looking minimum against the wrong tile, which sends a
    // reader to inspect a tile that never held the sample.
    const { deps } = twoTileHarness({
      readTile: (id) => (id === "N45E007" ? tileAt(3000, 2550) : tileAt(2900, 2800)),
    });

    expect((await runBuild(PATHS, deps)).lowest).toEqual({
      elevationM: 2550,
      tileId: "N45E007",
      sampleIndex: 1,
    });
  });

  it("reads one tile at a time rather than fetching the whole cut up front", async () => {
    // The streaming property `assertMinimumElevation` accepts an iterable *for*. An eager
    // `map` or `Promise.all` would read both tiles before the first is examined, so the second
    // read happens even though the first tile already ended the build. Observable only because
    // an empty tile fails *within* its own tile rather than after the full scan — a floor
    // breach deliberately does not stop early, since the error must name the true lowest.
    const { deps, calls } = twoTileHarness({
      readTile: (id) => (id === "N45E006" ? [] : tileAt(3000)),
    });

    const error = await catchBuild(() => runBuild(PATHS, deps));

    expect(error.message).toContain("N45E006 contains no elevation samples");
    expect(calls.readTile).toEqual(["N45E006"]);
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

    await expect(runBuild(PATHS, deps)).resolves.toMatchObject({ tiles: ["N45E006"] });
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
    const { deps } = harness({ readTile: () => tileAt(2600, 3100, 2550) });
    withSnapshot(deps, ["N45E006"]);

    expect((await runBuild(PATHS, deps)).lowest.elevationM).toBe(2550);
  });

  it("reports the breaching elevation in metres, so the failure is readable", async () => {
    const { deps } = harness({ readTile: () => tileAt(2600, 2412.5) });
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
      writeArchive: (_p, _t, text) => ({ entries: () => [{ path: "LICENSE", text }] }),
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
      writeArchive: (_p, _t, text, declared) => {
        received = declared;
        return {
          entries: () => [
            { path: "LICENSE", text },
            { path: "meta", text: Object.values(declared).join(" ") },
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
      writeArchive: (_p, _t, text, declared) => ({
        entries: () => [
          { path: LICENCE_ENTRY_PATH, text },
          { path: "meta", text: Object.values(declared).join(" ") },
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
