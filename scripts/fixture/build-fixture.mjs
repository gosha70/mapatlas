// SPDX-License-Identifier: Apache-2.0

/**
 * The committed entry point for the vertical fixture's archives (T4.6).
 *
 * **Why this file exists at all.** Every obligation had been met end to end against the real
 * release before it did — but from a scratchpad runner, so nothing in the repository reproduced
 * it. An obligation discharged by a script nobody else can run is a claim about one afternoon,
 * not a property of the build. This is what turns that into something a reader can re-run.
 *
 * It composes and nothing else: real filesystem, real S3 probe, real range reads, real writer.
 * Every one of them is injectable, so the assembled path is exercised in the suite against a
 * synthetic source with no network — which is a different claim from "the release still has the
 * data", and only the latter needs the network.
 *
 * Not run by `npm run verify` or by CI: it fetches, and it writes archives. `*.pmtiles*` is
 * ignored by git, so the repository never carries map tiles (`CLAUDE.md`).
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { runBuild } from "./build.mjs";
import { createArchiveWriter, createSourceDeps, encodeRasterTile } from "./deps.mjs";

/** Where the checked-in inputs live, relative to the repository root. */
export const DEFAULT_PATHS = Object.freeze({
  regionPath: "fixtures/vertical/region.json",
  snapshotPath: "fixtures/vertical/coverage-snapshot.json",
  licencePath: "fixtures/vertical/licence/COP-DEM-GLO-30.txt",
  attributionPath: "fixtures/vertical/attribution.json",
  // Two archives, because PMTiles v3 carries one tile type and one compression per file
  // (ADR-0025). A renderer wants them as two sources in any case.
  terrainArchivePath: "build/fixture/terrain.pmtiles",
  contourArchivePath: "build/fixture/contours.pmtiles",
});

/**
 * Build the fixture's archives — terrain and contours, two files by ADR-0025.
 *
 * @param {{
 *   paths?: typeof DEFAULT_PATHS,
 *   distributable?: boolean,
 *   fetchImpl?: typeof globalThis.fetch,
 *   io?: object,
 *   now?: () => Date,
 * }} [options]
 * @returns {Promise<object>} the build report, with each archive's size in bytes.
 */
export async function buildFixture(options = {}) {
  const {
    paths = DEFAULT_PATHS,
    distributable = true,
    fetchImpl = globalThis.fetch,
    io = defaultIo(),
    now = () => new Date(),
  } = options;

  for (const path of [paths.terrainArchivePath, paths.contourArchivePath]) {
    io.mkdirSync(dirname(path), { recursive: true });
  }
  const source = createSourceDeps({ fetchImpl });
  const report = await runBuild(
    paths,
    {
      readText: (path) => io.readFileSync(path, "utf8"),
      readJson: (path) => JSON.parse(io.readFileSync(path, "utf8")),
      io,
      probe: source.probe,
      readTile: source.readTile,
      encodeRasterTile,
      // The build chooses each archive's payload type and compression per call; the writer holds
      // no opinion about which archives exist.
      writeArchive: createArchiveWriter(),
      // The archive is named only once every check has passed; until then it is a `.partial`
      // that `/lab` and the browser scenario do not read.
      finaliseArchive: (from, to) => io.renameSync(from, to),
      // Must tolerate a path that was never created: the writer may have thrown first.
      discardArchive: (path) => io.rmSync(path, { force: true }),
      now,
    },
    { distributable },
  );

  return {
    ...report,
    archives: report.archives.map((archive) => ({
      ...archive,
      bytes: io.statSync(archive.path).size,
    })),
  };
}

/** The real filesystem, as one injectable object. */
function defaultIo() {
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

/**
 * Run as a command.
 *
 * Compared against `process.argv[1]` rather than a bundler flag so the module can be imported by
 * the suite without building anything.
 */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const distributable = !process.argv.includes("--not-for-distribution");
  try {
    const report = await buildFixture({ distributable });
    process.stdout.write(
      `${JSON.stringify(
        {
          region: report.region,
          sourceCells: report.sourceCells,
          envelope: report.envelope.map((v) => Number(v.toFixed(6))),
          lowestM: Number(report.lowest.elevationM.toFixed(3)),
          archives: report.archives,
          totalBytes: report.archives.reduce((n, a) => n + a.bytes, 0),
          distributable: report.distributable,
        },
        null,
        2,
      )}\n`,
    );
  } catch (error) {
    // The stage is the first thing worth knowing, and it is the field a `BuildError` carries.
    const stage =
      error instanceof Error && "stage" in error ? ` at stage "${String(error.stage)}"` : "";
    process.stderr.write(
      `fixture build failed${stage}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
