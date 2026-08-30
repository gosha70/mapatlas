// SPDX-License-Identifier: Apache-2.0

import { assertCoverage, assertSnapshotFresh, loadCoverageSnapshot } from "./coverage.mjs";
import {
  LICENCE_ENTRY_PATH,
  assertArchiveCarriesAttribution,
  assertArchiveCarriesLicence,
  assertStringsBackedByLicence,
} from "./licence.mjs";
import { assertMinimumElevation, parseRegionDeclaration } from "./region.mjs";
import { decodeElevation } from "./terrarium.mjs";

/**
 * The fixture build, as an ordering of the four obligations (T4.6).
 *
 * **The order is the design.** Each obligation can fail, and what a failing build tells someone
 * depends entirely on which one fails first, so they run cheapest-and-most-decisive first:
 *
 *   1. `licence`  — a property of two checked-in documents. No network, no data, milliseconds.
 *   2. `region`   — a property of one checked-in document. Same.
 *   3. `snapshot` — the coverage list's own integrity and freshness. Same.
 *   4. `coverage` — one cheap request per required tile. Network, but no bytes to speak of.
 *   5. `elevation`— reads and decodes every tile. Minutes, and the first expensive stage.
 *   6. `archive`  — writes the result, checks the licence and the attribution travelled with
 *                   it, and only then names it as the archive.
 *
 * A build that spends twenty minutes encoding and then fails comparing a string is correct and
 * infuriating; every check that *can* run before the expensive stage does. Note that this puts
 * the licence check first even though its inputs are the ones most likely to be missing — that
 * is the point, not an accident: the cheapest failure should be the earliest.
 *
 * Nothing here performs I/O directly. The probe, the tile reader, the clock and the writer are
 * injected, so the assembled ordering is testable without a network — which matters because the
 * properties worth testing here are the ones that live *between* the checks rather than inside
 * any one of them.
 */

/** The stages, in the order they run. Exported so a test asserts the order rather than assuming it. */
export const BUILD_STAGES = Object.freeze([
  "licence",
  "region",
  "snapshot",
  "coverage",
  "elevation",
  "archive",
]);

export class BuildError extends Error {
  /**
   * @param {string} stage
   * @param {unknown} cause
   */
  constructor(stage, cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`fixture build failed at stage "${stage}": ${detail}`);
    this.name = "BuildError";
    this.stage = stage;
    // Kept, not flattened. The coverage checks distinguish three kinds of absence and the whole
    // point of that distinction is the action it implies; a wrapper that discarded the cause
    // would collapse them back into "the build failed" at exactly the boundary where they stop
    // being visible.
    this.cause = cause;
  }
}

/**
 * @param {string} stage
 * @param {() => T} work
 * @returns {T}
 * @template T
 */
function at(stage, work) {
  try {
    return work();
  } catch (error) {
    throw new BuildError(stage, error);
  }
}

/**
 * Run the obligations in order and report what each established.
 *
 * @param {{ regionPath: string, snapshotPath: string, licencePath: string, attributionPath: string, archivePath: string }} paths
 * @param {{
 *   readText: (path: string) => string,
 *   readJson: (path: string) => unknown,
 *   io: object,
 *   probe: (tileId: string) => { status: number },
 *   readTile: (tileId: string) => Iterable<[number, number, number]>,
 *   writeArchive: (path: string, tiles: string[], licenceText: string, attribution: Record<string, string>) => { entries: () => Iterable<{ path: string, text: string }> },
 *   finaliseArchive: (from: string, to: string) => void,
 *   discardArchive: (path: string) => void,
 *   now: () => Date,
 * }} deps
 *
 * `discardArchive` must tolerate a path that was never created: it is called whenever the
 * archive stage fails, including when the writer itself threw before producing anything.
 */
export function runBuild(paths, deps) {
  const licenceText = at("licence", () => deps.readText(paths.licencePath));
  const attribution = at("licence", () => deps.readJson(paths.attributionPath));
  const roles = at("licence", () =>
    assertStringsBackedByLicence(
      /** @type {Record<string, string>} */ (attribution),
      licenceText,
      paths.licencePath,
    ),
  );

  // `parseRegionDeclaration` rather than `loadRegionDeclaration`: the latter reads the file
  // itself, which would put I/O inside a stage this module promises to keep injectable. Reading
  // here and parsing there also means the build has exactly one place that touches the disk.
  const declaration = at("region", () =>
    parseRegionDeclaration(deps.readJson(paths.regionPath), paths.regionPath),
  );

  const snapshot = at("snapshot", () => {
    const loaded = loadCoverageSnapshot(paths.snapshotPath, deps.io);
    assertSnapshotFresh(loaded, deps.now());
    return loaded;
  });

  // `assertCoverage` distinguishes an unpublished tile from an unexpected one from a transport
  // failure, and those three imply different actions. Wrapping in `at` is safe because
  // `BuildError` keeps the cause — but nothing between the probe and the classifier may catch a
  // `CoverageError` and recast it as a generic gap, or the three collapse into "the build
  // failed" exactly where the distinction stops being visible.
  const tiles = at("coverage", () => assertCoverage(declaration.bounds, deps.probe, snapshot));

  const lowest = at("elevation", () =>
    assertMinimumElevation(
      declaration,
      tiles.map((tileId) => ({
        tileId,
        elevationsM: decodeTile(deps.readTile(tileId)),
      })),
    ),
  );

  // Written to a partial path and only named as the archive once it has passed. A build that
  // fails its licence checks after writing leaves a licence-violating archive on disk, which
  // `/lab` or the browser scenario would then pick up — a failed build producing a usable-looking
  // artifact is worse than one producing nothing.
  const partialPath = `${paths.archivePath}.partial`;
  try {
    // The writer is inside the `try` too: one that fails midway leaves a partial behind just as
    // a failing check does. The `.partial` suffix already keeps `/lab` and the browser scenario
    // from picking it up, so this is tidiness rather than safety — but a leftover whose only
    // protection is a naming convention is one rename away from being a real one.
    const archive = at("archive", () =>
      deps.writeArchive(partialPath, tiles, licenceText, attribution),
    );
    at("archive", () => assertArchiveCarriesLicence(archive, licenceText, LICENCE_ENTRY_PATH));
    // The second half of obligation 1: the strings were checked against the document above, and
    // this is where they are confirmed to have reached the archive rather than stopping at the
    // validation.
    at("archive", () =>
      assertArchiveCarriesAttribution(
        archive,
        /** @type {Record<string, string>} */ (attribution),
        LICENCE_ENTRY_PATH,
      ),
    );
    at("archive", () => deps.finaliseArchive(partialPath, paths.archivePath));
  } catch (error) {
    deps.discardArchive(partialPath);
    throw error;
  }

  return { roles, region: declaration.id, tiles, lowest };
}

/**
 * Decode a tile's pixels lazily, so a cut larger than memory is still one pass.
 *
 * @param {Iterable<[number, number, number]>} pixels
 * @returns {Iterable<number>}
 */
function* decodeTile(pixels) {
  for (const [r, g, b] of pixels) yield decodeElevation(r, g, b);
}
