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
    probe: (id) => {
      calls.probe.push(id);
      return (overrides.probe ?? (() => ({ status: 200 })))(id);
    },
    readTile: (id) => {
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

  it("completes a build whose every obligation is met", () => {
    const { deps, calls } = harness();
    withSnapshot(deps, ["N45E006"]);

    const report = runBuild(PATHS, deps);

    expect(report.tiles).toEqual(["N45E006"]);
    expect(report.lowest).toEqual({ elevationM: 2600, tileId: "N45E006", sampleIndex: 0 });
    // Written partial, then named as the archive only once every check has passed.
    expect(calls.wrote).toEqual(["out.pmtiles.partial"]);
    expect(calls.finalised).toEqual([["out.pmtiles.partial", "out.pmtiles"]]);
    expect(calls.discarded).toEqual([]);
  });

  it("fails at the licence before touching the network or any tile", () => {
    // The ordering claim, asserted by what did *not* happen. A build that reaches the
    // expensive stage and then fails comparing a string is correct and infuriating.
    const { deps, calls } = harness({
      files: { "attribution.json": JSON.stringify({ ...ATTRIBUTION, noEndorsement: "Invented." }) },
    });
    withSnapshot(deps, ["N45E006"]);

    const error = catchBuild(() => runBuild(PATHS, deps));

    expect(error.stage).toBe("licence");
    expect(calls.probe).toEqual([]);
    expect(calls.readTile).toEqual([]);
    expect(calls.wrote).toEqual([]);
  });

  it("fails at coverage before reading a single tile", () => {
    const { deps, calls } = harness({ probe: () => ({ status: 404 }) });
    withSnapshot(deps, []);

    const error = catchBuild(() => runBuild(PATHS, deps));

    expect(error.stage).toBe("coverage");
    expect(calls.probe).toEqual(["N45E006"]);
    expect(calls.readTile).toEqual([]);
  });

  it("writes nothing when the floor is breached", () => {
    const { deps, calls } = harness({ readTile: () => tileAt(2600, 2400) });
    withSnapshot(deps, ["N45E006"]);

    const error = catchBuild(() => runBuild(PATHS, deps));

    expect(error.stage).toBe("elevation");
    expect(calls.wrote).toEqual([]);
  });
});

describe("the classification seam between coverage and the gap rule", () => {
  // The property that only exists *between* the checks: a withheld tile and a broken fetch
  // must take different paths through the assembled build, not merely through `assertCoverage`
  // in isolation. If anything between here and the classifier catches a CoverageError and
  // recasts it, the three cases collapse into "the build failed" exactly where the distinction
  // stops being visible — and the snapshot that exists to draw it becomes decorative.
  it("carries a withheld tile through as unpublished", () => {
    const { deps } = harness({ probe: () => ({ status: 404 }) });
    withSnapshot(deps, []);

    const error = catchBuild(() => runBuild(PATHS, deps));

    expect(error.stage).toBe("coverage");
    expect(error.cause).toBeInstanceOf(CoverageError);
    expect(error.cause.kind).toBe("unpublished");
  });

  it("carries a listed-but-missing tile through as unexpected", () => {
    const { deps } = harness({ probe: () => ({ status: 404 }) });
    withSnapshot(deps, ["N45E006"]);

    const error = catchBuild(() => runBuild(PATHS, deps));

    expect(error.cause.kind).toBe("unexpected");
  });

  it("carries a broken fetch through as unreachable, not as an absence", () => {
    const { deps } = harness({
      probe: () => {
        throw new Error("socket hang up");
      },
    });
    withSnapshot(deps, ["N45E006"]);

    const error = catchBuild(() => runBuild(PATHS, deps));

    expect(error.cause.kind).toBe("unreachable");
  });

  it("gives the three cases three different kinds from one status and one exception", () => {
    // Stated as one assertion because the claim is about the *set*: same 404 twice, different
    // kinds, and a thrown probe distinct from both. Any collapse shows up here as a duplicate.
    const kinds = [
      [() => ({ status: 404 }), []],
      [() => ({ status: 404 }), ["N45E006"]],
      [
        () => {
          throw new Error("reset");
        },
        ["N45E006"],
      ],
    ].map(([probe, published]) => {
      const { deps } = harness({ probe });
      withSnapshot(deps, published);
      return catchBuild(() => runBuild(PATHS, deps)).cause.kind;
    });

    expect(kinds).toEqual(["unpublished", "unexpected", "unreachable"]);
    expect(new Set(kinds).size).toBe(3);
  });
});

describe("the codec and the floor are actually wired together", () => {
  // Neither module's own suite can reach this: `terrarium` never sees a floor and `region`
  // never sees a pixel. The build is where they meet, so a missing decode — feeding raw RGB
  // to the floor — is invisible until here. RGB(128,0,0) is sea level, so undecoded bytes
  // would compare as ~128 m and breach a 2,500 m floor with a nonsense number.
  it("compares decoded metres against the declared floor, not raw channel values", () => {
    const { deps } = harness({ readTile: () => tileAt(2600, 3100, 2550) });
    withSnapshot(deps, ["N45E006"]);

    expect(runBuild(PATHS, deps).lowest.elevationM).toBe(2550);
  });

  it("reports the breaching elevation in metres, so the failure is readable", () => {
    const { deps } = harness({ readTile: () => tileAt(2600, 2412.5) });
    withSnapshot(deps, ["N45E006"]);

    const error = catchBuild(() => runBuild(PATHS, deps));

    expect(error.cause).toBeInstanceOf(ElevationFloorError);
    expect(error.message).toContain("2412.5 m");
    expect(error.message).toContain("2500 m");
  });
});

describe("the archive must carry what it was built under", () => {
  it("fails when the writer omits the LICENSE", () => {
    const { deps } = harness({ writeArchive: () => ({ entries: () => [] }) });
    withSnapshot(deps, ["N45E006"]);

    const error = catchBuild(() => runBuild(PATHS, deps));

    expect(error.stage).toBe("archive");
    expect(error.message).toContain("carries no LICENSE");
  });

  it("fails when the strings were validated but never emitted", () => {
    // The half of obligation 1 that a validate-only build satisfies on paper: the declaration
    // is checked against the licence and then dropped, leaving recipients no attribution while
    // every earlier check passes. Only an assertion over what the archive *emits* catches it.
    const { deps } = harness({
      writeArchive: (_p, _t, text) => ({ entries: () => [{ path: "LICENSE", text }] }),
    });
    withSnapshot(deps, ["N45E006"]);

    const error = catchBuild(() => runBuild(PATHS, deps));

    expect(error.stage).toBe("archive");
    expect(error.message).toContain("never reaches the archive");
    expect(error.message).toContain("only LICENSE");
  });

  it("hands the writer the attribution as well as the licence", () => {
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

    runBuild(PATHS, deps);

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
  ])("discards the partial when $note", ({ overrides }) => {
    const { deps, calls } = harness(overrides);
    withSnapshot(deps, ["N45E006"]);

    catchBuild(() => runBuild(PATHS, deps));

    expect(calls.discarded).toEqual(["out.pmtiles.partial"]);
    expect(calls.finalised).toEqual([]);
  });

  it("uses one licence entry name for both halves of the obligation", () => {
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

    expect(() => runBuild(PATHS, deps)).not.toThrow();
    expect(paths).toEqual([]);
  });

  it("discards the partial archive rather than leaving a failing one on disk", () => {
    // A failed build that leaves a usable-looking artifact is worse than one that leaves
    // nothing: `/lab` and the browser scenario would pick up an archive whose licence checks
    // did not pass.
    const { deps, calls } = harness({ writeArchive: () => ({ entries: () => [] }) });
    withSnapshot(deps, ["N45E006"]);

    catchBuild(() => runBuild(PATHS, deps));

    expect(calls.discarded).toEqual(["out.pmtiles.partial"]);
    expect(calls.finalised).toEqual([]);
  });
});

/** @returns {BuildError} */
function catchBuild(fn) {
  try {
    fn();
  } catch (error) {
    if (error instanceof BuildError) return error;
    throw error;
  }
  throw new Error("expected a BuildError, but nothing was thrown");
}
