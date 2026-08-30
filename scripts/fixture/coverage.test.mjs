// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CoverageError,
  assertCoverage,
  assertSnapshotFresh,
  loadCoverageSnapshot,
  requiredTiles,
  tileId,
} from "./coverage.mjs";

const MANIFEST = "fixtures/vertical/coverage-snapshot.json";
const io = {
  readFileSync,
  dirname,
  join,
  sha256: (text) => createHash("sha256").update(text).digest("hex"),
};

/** A snapshot with a hand-written membership, so classification tests state their own facts. */
const snapshotOf = (published, overrides = {}) => ({
  source: "test",
  retrievedAt: "2026-08-01",
  maxAgeDays: 365,
  published: new Set(published),
  ...overrides,
});

describe("tile naming", () => {
  it.each([
    { south: 45, west: 6, id: "N45E006" },
    { south: 0, west: 0, id: "N00E000" },
    { south: -90, west: -180, id: "S90W180" },
    { south: -3, west: -2, id: "S03W002" },
  ])("names the cell at $south,$west as $id", ({ south, west, id }) => {
    expect(tileId(south, west)).toBe(id);
  });
});

describe("which tiles a cut requires", () => {
  it("takes one tile for a cut inside one cell", () => {
    expect(requiredTiles([6.825, 45.815, 6.905, 45.865])).toEqual(["N45E006"]);
  });

  it("takes every cell a cut spans, in a stable order", () => {
    expect(requiredTiles([6.5, 45.5, 8.5, 46.5])).toEqual([
      "N45E006",
      "N45E007",
      "N45E008",
      "N46E006",
      "N46E007",
      "N46E008",
    ]);
  });

  it("treats an upper bound on a cell edge as belonging to the cell below it", () => {
    // A cut whose north edge is exactly 46 has zero width in N46, and its samples at that
    // latitude are the top row of N45. Demanding N46 would fail a build over a neighbour the
    // cut never reads — and at the poles or a coast that neighbour may not exist at all.
    expect(requiredTiles([6, 45, 7, 46])).toEqual(["N45E006"]);
    expect(requiredTiles([6, 45, 7, 46.0001])).toEqual(["N45E006", "N46E006"]);
  });

  it("names southern and western cells for their south-west corner", () => {
    expect(requiredTiles([-1.5, -2.5, -0.5, -1.5])).toEqual([
      "S03W002",
      "S03W001",
      "S02W002",
      "S02W001",
    ]);
  });
});

describe("an absent tile is classified, not merely detected", () => {
  const BOUNDS = [6.5, 45.5, 6.6, 45.6];

  it.each([
    { status: 200, note: "a whole-object read" },
    { status: 206, note: "a range read, which is what the build actually performs" },
  ])("accepts $status — $note", ({ status }) => {
    // Measured against the live release on 2026-08-30: a one-byte range GET on N45E006
    // answers 206. Coverage is discovered during the COG range reads the build has to make
    // anyway, so accepting only 200 would reject every successful read it performs.
    expect(assertCoverage(BOUNDS, () => ({ status }), snapshotOf(["N45E006"]))).toEqual([
      "N45E006",
    ]);
  });

  it("reads a 404 for an unlisted tile as the release not publishing it", () => {
    // "Choose another region." The 404 and the snapshot agree, so the region is the problem.
    const error = catchCoverage(() =>
      assertCoverage(BOUNDS, () => ({ status: 404 }), snapshotOf([])),
    );
    expect(error.kind).toBe("unpublished");
    expect(error.message).toContain("N45E006");
  });

  it("reads a 404 for a listed tile as the source having changed, not the region", () => {
    // Same status code, opposite action. Only the snapshot separates them, which is the whole
    // reason it is not optional — detection alone cannot tell these two apart.
    const error = catchCoverage(() =>
      assertCoverage(BOUNDS, () => ({ status: 404 }), snapshotOf(["N45E006"])),
    );
    expect(error.kind).toBe("unexpected");
    expect(error.message).toContain("N45E006");
    expect(error.message).toContain("has changed");
  });

  it("reads anything else as a transport failure that does not implicate the region", () => {
    const error = catchCoverage(() =>
      assertCoverage(BOUNDS, () => ({ status: 503 }), snapshotOf(["N45E006"])),
    );
    expect(error.kind).toBe("unreachable");
    expect(error.message).toContain("503");
  });

  it("classifies a probe that throws as a transport failure, not as an absence", () => {
    // A timeout, a reset socket or a DNS failure is the same class as a 5xx and must arrive
    // as one. Escaping raw would hand the only caller that distinguishes these three cases an
    // error carrying no `kind`.
    const error = catchCoverage(() =>
      assertCoverage(
        BOUNDS,
        () => {
          throw new Error("socket hang up");
        },
        snapshotOf(["N45E006"]),
      ),
    );
    expect(error.kind).toBe("unreachable");
    expect(error.message).toContain("socket hang up");
    expect(error.message).toContain("N45E006");
  });

  it("refuses bounds that would enumerate no tiles at all", () => {
    // The vacuous pass: invalid bounds enumerate nothing, the loop runs zero times, and
    // coverage reports success having probed nothing. Rejected by validating the box with the
    // same rule the region declaration uses.
    for (const bounds of [
      [Number.NaN, 45, 7, 46],
      [7, 45, 6, 46],
      [6, 46, 7, 45],
      [6, 45, 7],
    ]) {
      let probed = 0;
      expect(() =>
        assertCoverage(
          bounds,
          () => {
            probed += 1;
            return { status: 200 };
          },
          snapshotOf([]),
        ),
      ).toThrow();
      expect(probed, JSON.stringify(bounds)).toBe(0);
    }
  });

  it("always requires at least one tile for any box it accepts", () => {
    // The other half of the same claim: with the box validated, an empty enumeration is not
    // reachable, so there is no need for a separate emptiness guard downstream.
    for (const bounds of [
      [6, 45, 7, 46],
      [6.825, 45.815, 6.905, 45.865],
      [-180, -90, 180, 90],
      [-0.001, -0.001, 0.001, 0.001],
    ]) {
      expect(requiredTiles(bounds).length, JSON.stringify(bounds)).toBeGreaterThan(0);
    }
  });

  it("probes every required tile rather than stopping at the first", () => {
    const asked = [];
    assertCoverage(
      [6.5, 45.5, 7.5, 46.5],
      (id) => {
        asked.push(id);
        return { status: 200 };
      },
      snapshotOf([]),
    );
    expect(asked).toEqual(["N45E006", "N45E007", "N46E006", "N46E007"]);
  });

  it("has no path that fills or skips an absent tile", () => {
    // The refusal is the absence of a branch rather than a guard around one: there is no
    // argument, flag or status that makes this return a tile it could not read.
    // 204 is deliberately here rather than among the accepted statuses: it is a success code
    // carrying no bytes, and treating "success" as presence would let an empty answer stand in
    // for a tile.
    for (const status of [204, 301, 403, 404, 500, 503]) {
      expect(() => assertCoverage(BOUNDS, () => ({ status }), snapshotOf([]))).toThrow(
        CoverageError,
      );
    }
  });
});

describe("the snapshot's own freshness", () => {
  it("passes inside its declared window", () => {
    expect(() =>
      assertSnapshotFresh(
        snapshotOf([], { retrievedAt: "2026-08-01", maxAgeDays: 365 }),
        new Date("2026-09-01"),
      ),
    ).not.toThrow();
  });

  it("fails past it, rather than leaving a reader to judge a date", () => {
    // A retrieval date alone asks someone to do arithmetic and then make a call they have no
    // basis for. The threshold is declared, so the check fires instead of the reader.
    const error = catchCoverage(() =>
      assertSnapshotFresh(
        snapshotOf([], { retrievedAt: "2024-01-01", maxAgeDays: 365 }),
        new Date("2026-08-30"),
      ),
    );
    expect(error.message).toContain("365-day limit");
  });

  it("refuses a retrievedAt that is not a date", () => {
    expect(() =>
      assertSnapshotFresh(snapshotOf([], { retrievedAt: "recently" }), new Date("2026-08-30")),
    ).toThrow(CoverageError);
  });

  it("refuses a retrievedAt in the future, which would never expire", () => {
    const error = catchCoverage(() =>
      assertSnapshotFresh(snapshotOf([], { retrievedAt: "2027-01-01" }), new Date("2026-08-30")),
    );
    expect(error.message).toContain("in the future");
  });

  it.each([
    { maxAgeDays: undefined, note: "missing" },
    { maxAgeDays: Number.NaN, note: "not a number" },
    { maxAgeDays: 0, note: "zero" },
    { maxAgeDays: -1, note: "negative" },
  ])("refuses a $note maximum age instead of silently never expiring", ({ maxAgeDays }) => {
    // `Number(undefined)` is NaN and `ageDays > NaN` is false for every age, so an unusable
    // limit switches expiry off rather than loosening it — a check that can never fire, which
    // is indistinguishable from a check that always passes.
    expect(() =>
      assertSnapshotFresh(
        snapshotOf([], { retrievedAt: "2020-01-01", maxAgeDays }),
        new Date("2026-08-30"),
      ),
    ).toThrow(CoverageError);
  });
});

describe("the checked-in snapshot", () => {
  it("loads, and its digest matches the list it names", () => {
    const snapshot = loadCoverageSnapshot(MANIFEST, io);
    expect(snapshot.published.size).toBe(26_450);
    expect(snapshot.source).toContain("tileList.txt");
  });

  it("agrees with tiles probed against the live release", () => {
    // Measured on 2026-08-30: these four answered 200 and these two answered 404. The list is
    // derived from the source's own `tileList.txt`, so this is two independent readings of the
    // same fact agreeing — the list could be stale, but not silently wrong about these.
    const snapshot = loadCoverageSnapshot(MANIFEST, io);
    for (const id of ["N45E006", "N45E007", "N46E006", "S90W180"]) {
      expect(snapshot.published.has(id), id).toBe(true);
    }
    for (const id of ["N90E000", "N00E000"]) {
      expect(snapshot.published.has(id), id).toBe(false);
    }
  });

  it("covers the declared region's cut", () => {
    const snapshot = loadCoverageSnapshot(MANIFEST, io);
    const declaration = JSON.parse(readFileSync("fixtures/vertical/region.json", "utf8"));
    for (const id of requiredTiles(declaration.bounds)) {
      expect(snapshot.published.has(id), id).toBe(true);
    }
  });

  it("records enough upstream provenance to tie the local list to its source", () => {
    // The digest proves the manifest and the list agree with each other; it cannot prove the
    // list was derived from upstream, because it is a digest of the *normalised* file. These
    // three fields are what close that gap: the source object's own ETag and byte count, and
    // the transformation applied to it.
    const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
    expect(manifest.sourceEtag).toMatch(/^[0-9a-f]{32}$/);
    expect(manifest.sourceBytes).toBeGreaterThan(0);
    expect(manifest.normalization).toContain("Copernicus_DSM_COG_10_");
    expect(manifest.normalization).toContain("sort -u");
  });

  it("refuses a manifest whose maxAgeDays could not expire anything", () => {
    const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
    const broken = {
      ...io,
      readFileSync: (p, enc) =>
        p === MANIFEST
          ? JSON.stringify({ ...manifest, maxAgeDays: "a year" })
          : readFileSync(p, enc),
    };
    expect(() => loadCoverageSnapshot(MANIFEST, broken)).toThrow(/finite positive number of days/);
  });

  it("refuses a manifest whose digest no longer matches its list", () => {
    // Two files that must agree. Editing one alone leaves a snapshot whose date and provenance
    // describe a list it no longer refers to, and every later classification speaks for the
    // wrong release with full confidence.
    const drifted = { ...io, sha256: () => "0".repeat(64) };
    expect(() => loadCoverageSnapshot(MANIFEST, drifted)).toThrow(/drifted apart/);
  });
});

/** @returns {CoverageError} */
function catchCoverage(fn) {
  try {
    fn();
  } catch (error) {
    if (error instanceof CoverageError) return error;
    throw error;
  }
  throw new Error("expected a CoverageError, but nothing was thrown");
}
