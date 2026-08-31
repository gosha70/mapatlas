// SPDX-License-Identifier: Apache-2.0

import { assertCoverage, assertSnapshotFresh, loadCoverageSnapshot } from "./coverage.mjs";
import {
  LICENCE_ENTRY_PATH,
  assertArchiveCarriesAttribution,
  assertNotForDistribution,
  assertArchiveCarriesLicence,
  assertStringsBackedByLicence,
} from "./licence.mjs";
import { productionEnvelope, tilesInRange } from "./mercator.mjs";
import { encodePng } from "./png.mjs";
import { assertMinimumElevation, parseRegionDeclaration } from "./region.mjs";
import { TILE_SIZE } from "./mercator.mjs";
import { renderTerrariumTile } from "./resample.mjs";
import { SOURCE_SAMPLE_SPACING_DEG } from "./source.mjs";
import { stitchSurface } from "./surface.mjs";
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
 * infuriating; every check that *can* run before the expensive stage does.
 *
 * **The licence gate is on distribution, not on execution.** The obligation is about
 * redistributing a derived work, so it belongs at the boundary where an archive becomes
 * downloadable — not in front of every local run. A `distributable: false` build skips the
 * licence stage, writes to a `.dev` path and must carry a not-for-distribution marker instead;
 * a distributable build cannot skip it by any flag. Gating execution on a legal input meant a
 * missing string blocked the writer, the tile reader and the contour source, none of which
 * redistribute anything. That was a design mistake, corrected here.
 *
 * Nothing here performs I/O directly. The probe, the tile reader, the clock and the writer are
 * injected, so the assembled ordering is testable without a network — which matters because the
 * properties worth testing here are the ones that live *between* the checks rather than inside
 * any one of them.
 *
 * **The build is async because two of those seams really fetch.** The probe is an HTTP request
 * and the reader is a range read, so every stage is awaited. A dropped `await` is the failure
 * mode this shape introduces, and it is quiet in a specific way: the value flowing on is a
 * pending promise rather than a result, so the build continues and fails somewhere else, or
 * — worse — a rejection escapes the `try` that would have named the stage it came from.
 * `scripts/fixture/deps.mjs` binds the real implementations behind these seams.
 */

/** The stages, in the order they run. Exported so a test asserts the order rather than assuming it. */
export const BUILD_STAGES = Object.freeze([
  "licence",
  "region",
  "snapshot",
  "coverage",
  "elevation",
  "tiles",
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
 * Run one stage, labelling anything it throws — or rejects with — as that stage's failure.
 *
 * `return await work()` rather than `return work()`, and the difference is the whole point: the
 * bare return settles the promise *outside* this `try`, so an async stage's rejection escapes
 * unlabelled and every `error.stage` assertion in the suite reads `undefined`. It is the one
 * place where the redundant-looking `await` is load-bearing.
 *
 * @param {string} stage
 * @param {() => T | Promise<T>} work
 * @returns {Promise<T>}
 * @template T
 */
async function at(stage, work) {
  try {
    return await work();
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
 *   probe: (tileId: string) => { status: number } | Promise<{ status: number }>,
 *   readTile: (tileId: string, bounds: [number, number, number, number]) => Promise<object>,
 *   writeArchive: (path: string, tiles: string[], licenceText: string, attribution: Record<string, string>) => { entries: () => Iterable<{ path: string, text: string }> },
 *   finaliseArchive: (from: string, to: string) => void,
 *   discardArchive: (path: string) => void,
 *   now: () => Date,
 * }} deps
 *
 * `discardArchive` must tolerate a path that was never created: it is called whenever the
 * archive stage fails, including when the writer itself threw before producing anything.
 *
 * @returns {Promise<{ roles: string[], distributable: boolean, outputPath: string, region: string, tiles: string[], lowest: object }>}
 */
export async function runBuild(paths, deps, options = {}) {
  const distributable = options.distributable ?? true;
  let licenceText = "";
  let attribution = {};
  let roles = [];
  if (distributable) {
    licenceText = await at("licence", () => deps.readText(paths.licencePath));
    attribution = await at("licence", () => deps.readJson(paths.attributionPath));
    roles = await at("licence", () =>
      assertStringsBackedByLicence(
        /** @type {Record<string, string>} */ (attribution),
        licenceText,
        paths.licencePath,
      ),
    );
  }

  // `parseRegionDeclaration` rather than `loadRegionDeclaration`: the latter reads the file
  // itself, which would put I/O inside a stage this module promises to keep injectable. Reading
  // here and parsing there also means the build has exactly one place that touches the disk.
  const declaration = await at("region", () =>
    parseRegionDeclaration(deps.readJson(paths.regionPath), paths.regionPath),
  );

  const snapshot = await at("snapshot", () => {
    const loaded = loadCoverageSnapshot(paths.snapshotPath, deps.io);
    assertSnapshotFresh(loaded, deps.now());
    return loaded;
  });

  // **Coverage is checked over the production envelope, not the declared region.** Output tiles
  // are complete rasters, so the build reads every intersecting tile's full footprint plus the
  // interpolation halo — which for this region reaches past 7°E and therefore needs a source
  // cell the declaration never touches. Admitting cells by the declaration and then reading the
  // envelope would read a tile coverage never checked, which is the whole point of the check.
  const envelope = await at("region", () =>
    productionEnvelope(
      declaration.bounds,
      declaration.minZoom,
      declaration.maxZoom,
      SOURCE_SAMPLE_SPACING_DEG,
    ),
  );

  // `assertCoverage` distinguishes an unpublished tile from an unexpected one from a transport
  // failure, and those three imply different actions. Wrapping in `at` is safe because
  // `BuildError` keeps the cause — but nothing between the probe and the classifier may catch a
  // `CoverageError` and recast it as a generic gap, or the three collapse into "the build
  // failed" exactly where the distinction stops being visible.
  const sourceCells = await at("coverage", () => assertCoverage(envelope, deps.probe, snapshot));

  // Read once, used twice. The floor check wants samples one at a time and the surface wants
  // whole crops; re-reading a 42 MB object per use to avoid holding a few megabytes would be a
  // poor trade. This does mean the envelope must be resident — a real limit of resampling at
  // all, since a reprojection cannot stream its input in the order its output needs.
  const crops = [];
  const lowest = await at("elevation", () =>
    assertMinimumElevation(
      declaration,
      readCrops(sourceCells, deps.readTile, envelope, declaration.bounds, crops),
    ),
  );

  const rasterTiles = await at("tiles", () => {
    for (const crop of crops) {
      if (crop.pixelScaleDeg !== SOURCE_SAMPLE_SPACING_DEG) {
        // The halo was sized from the declared spacing before any header was read. A source at
        // a different spacing makes it the wrong width, and a halo that is too small is a build
        // that samples outside the envelope it had admitted.
        throw new Error(
          `source sample spacing is ${String(crop.pixelScaleDeg)}, but the production envelope ` +
            `was computed for ${String(SOURCE_SAMPLE_SPACING_DEG)}`,
        );
      }
    }
    const surface = stitchSurface(crops);
    return [...tilesInRange(declaration.bounds, declaration.minZoom, declaration.maxZoom)].map(
      ({ z, x, y }) => ({
        z,
        x,
        y,
        bytes: encodePng(TILE_SIZE, TILE_SIZE, renderTerrariumTile(surface, z, x, y)),
      }),
    );
  });

  // Written to a partial path and only named as the archive once it has passed. A build that
  // fails its licence checks after writing leaves a licence-violating archive on disk, which
  // `/lab` or the browser scenario would then pick up — a failed build producing a usable-looking
  // artifact is worse than one producing nothing.
  // A development archive is named so it cannot be mistaken for a shippable one, and the name
  // is not cosmetic: it is what stops a local run's output being picked up by `/lab` or the
  // browser scenario, which read the distributable path.
  const outputPath = distributable ? paths.archivePath : `${paths.archivePath}.dev`;
  const partialPath = `${outputPath}.partial`;
  try {
    // The writer is inside the `try` too: one that fails midway leaves a partial behind just as
    // a failing check does. The `.partial` suffix already keeps `/lab` and the browser scenario
    // from picking it up, so this is tidiness rather than safety — but a leftover whose only
    // protection is a naming convention is one rename away from being a real one.
    const archive = await at("archive", () =>
      deps.writeArchive(partialPath, rasterTiles, {
        // **The declared region, not the envelope.** The bounds advertise what a consumer asked
        // for and what a renderer should request tiles within; the envelope is an implementation
        // detail of how complete tiles were produced, and publishing it would invite requests
        // for tiles outside the region.
        bounds: declaration.bounds,
        minzoom: declaration.minZoom,
        maxzoom: declaration.maxZoom,
        // Passed rather than inferred from an empty licence: a writer guessing the mode from
        // whether a string is blank would put a development archive one truthiness bug away
        // from looking distributable.
        distributable,
        licenceText,
        attribution,
      }),
    );
    if (distributable) {
      await at("archive", () =>
        assertArchiveCarriesLicence(archive, licenceText, LICENCE_ENTRY_PATH),
      );
      // The second half of obligation 1: the strings were checked against the document above,
      // and this is where they are confirmed to have reached the archive rather than stopping
      // at the validation.
      await at("archive", () =>
        assertArchiveCarriesAttribution(
          archive,
          /** @type {Record<string, string>} */ (attribution),
          LICENCE_ENTRY_PATH,
        ),
      );
    } else {
      await at("archive", () => assertNotForDistribution(archive));
    }
    await at("archive", () => deps.finaliseArchive(partialPath, outputPath));
  } catch (error) {
    try {
      await deps.discardArchive(partialPath);
    } catch (cleanupError) {
      // A cleanup that fails must not become the story. `discardArchive` is `fs.rm` on a path a
      // failing build just wrote, so rejecting is entirely plausible — and letting it propagate
      // raw would replace "the archive carries no LICENSE" with "permission denied", losing both
      // the reason the build failed and the stage that names it. Both are kept: the stage stands,
      // and the cause becomes the pair, original first.
      throw new BuildError(
        error.stage,
        new AggregateError(
          [error.cause, cleanupError],
          `the ${error.stage} stage failed and the partial at ${partialPath} could not be discarded`,
        ),
      );
    }
    throw error;
  }

  return {
    roles,
    distributable,
    outputPath,
    region: declaration.id,
    envelope,
    sourceCells,
    tileCount: rasterTiles.length,
    lowest,
  };
}

/**
 * Read and decode each required tile, one at a time.
 *
 * An async generator rather than a `map`: `map` would start every read at once and hold every
 * crop, which is the opposite of what `assertMinimumElevation` accepts an iterable *for*. Here
 * a tile is fetched only when the floor check asks for the next one, so a cut over many source
 * tiles holds one crop at a time.
 *
 * Each tile is read by **its own id**. That reads as too obvious to state until the loop is
 * written with an index, at which point reading `tiles[0]` every time produces a build that
 * checks one tile's samples as many times as there are tiles and reports the others' names
 * against them.
 *
 * @param {string[]} tiles
 * @param {(tileId: string) => Iterable<[number, number, number]> | Promise<Iterable<[number, number, number]>>} readTile
 * @returns {AsyncIterable<{ tileId: string, elevationsM: Iterable<number> }>}
 */
async function* readCrops(tileIds, readTile, envelope, region, collected) {
  for (const tileId of tileIds) {
    // Read against the **envelope**. Coverage admitted these cells over it, so reading them
    // against anything narrower asks a cell east of the declared region for a box that does not
    // intersect it.
    const crop = await readTile(tileId, envelope);
    collected.push(crop);

    // Judge the floor against the **declared region**. The envelope exists so that output tiles
    // are complete rasters, and it reaches a tile's width beyond the region — which around any
    // summit means valley floors. Checking it would turn "this region is above the treeline"
    // into "everything within a tile of it is", a condition no mountain satisfies; the real
    // build first failed at 554 m on exactly that. ADR-0024 makes the declared region the
    // subject, and the archive advertises those same bounds.
    const window = regionWindow(crop, region);
    if (window === null) continue;
    yield { tileId, elevationsM: samplesIn(crop, window) };
  }
  // No count of contributing cells is kept. The envelope contains the region by construction, so
  // at least one crop always intersects it — and were that ever false, yielding nothing reaches
  // `assertMinimumElevation`'s own "cannot check the declared floor without elevation samples",
  // which is tested. A guard here would have been a claim no input could reach.
}

/**
 * The part of a crop lying inside the declared region, or `null` if none does.
 *
 * Half-open at east and south, like every other window in this build, so a sample on a shared
 * edge is counted once. A cell can legitimately contribute nothing: the envelope pulls in cells
 * the region never touches, and for this fixture `N45E007` is entirely outside it.
 *
 * @param {{ width: number, height: number, west: number, north: number, pixelScaleDeg: number }} crop
 * @param {[west: number, south: number, east: number, north: number]} region
 */
function regionWindow(crop, region) {
  const scale = crop.pixelScaleDeg;
  const first = (v) => Math.ceil(v / scale - 1e-6);
  const col0 = Math.max(0, first(region[0] - crop.west));
  const colEnd = Math.min(crop.width, first(region[2] - crop.west));
  const row0 = Math.max(0, first(crop.north - region[3]));
  const rowEnd = Math.min(crop.height, first(crop.north - region[1]));
  if (colEnd <= col0 || rowEnd <= row0) return null;
  return { col0, cols: colEnd - col0, row0, rows: rowEnd - row0 };
}

/**
 * @param {{ width: number, rgb: Uint8Array }} crop
 * @param {{ col0: number, cols: number, row0: number, rows: number }} window
 * @returns {Iterable<number>}
 */
function* samplesIn(crop, window) {
  for (let r = 0; r < window.rows; r += 1) {
    const base = (window.row0 + r) * crop.width + window.col0;
    for (let c = 0; c < window.cols; c += 1) {
      const i = (base + c) * 3;
      yield decodeElevation(crop.rgb[i], crop.rgb[i + 1], crop.rgb[i + 2]);
    }
  }
}
