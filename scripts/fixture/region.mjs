// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";

/**
 * @typedef {object} RegionDeclaration
 * @property {string} id
 * @property {[west: number, south: number, east: number, north: number]} bounds
 * @property {number} minElevationM
 * @property {string} minElevationJustification
 * @property {number} minZoom
 * @property {number} maxZoom
 * @property {string} zoomJustification
 * @property {number} contourIntervalM
 * @property {string} contourIntervalJustification
 */

/**
 * @typedef {object} ElevationTile
 * @property {string} tileId
 * @property {Iterable<number>} elevationsM
 */

export class RegionDeclarationError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "RegionDeclarationError";
  }
}

export class ElevationFloorError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "ElevationFloorError";
  }
}

/** @param {unknown} value */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Validate a `[west, south, east, north]` box.
 *
 * Exported so coverage checking uses the *same* rule rather than a second copy of it. A box is
 * the input to both obligations, and two validators would drift — the one that drifted being
 * whichever is exercised less.
 *
 * @param {unknown} bounds
 * @param {string} source
 * @returns {[west: number, south: number, east: number, north: number]}
 */
export function parseBounds(bounds, source) {
  if (!Array.isArray(bounds) || bounds.length !== 4 || !bounds.every(Number.isFinite)) {
    throw new RegionDeclarationError(
      `${source}: bounds must be four finite numbers in [west, south, east, north] order`,
    );
  }
  const [west, south, east, north] = bounds;
  if (west < -180 || east > 180 || south < -90 || north > 90) {
    throw new RegionDeclarationError(`${source}: bounds must lie within WGS84 longitude/latitude`);
  }
  if (west >= east || south >= north) {
    throw new RegionDeclarationError(
      `${source}: west must precede east and south must precede north`,
    );
  }
  return [west, south, east, north];
}

/**
 * Validate the checked-in boundary between the region-selection decision and the build.
 *
 * The justification is data, not a comment: changing the box without reconsidering why its
 * floor means "above the treeline" must leave an obvious declaration to review.
 *
 * @param {unknown} value
 * @param {string} [source]
 * @returns {RegionDeclaration}
 */
export function parseRegionDeclaration(value, source = "region declaration") {
  if (!isRecord(value)) {
    throw new RegionDeclarationError(`${source}: expected an object`);
  }

  const {
    id,
    bounds,
    minElevationM,
    minElevationJustification,
    minZoom,
    maxZoom,
    contourIntervalM,
  } = value;
  if (typeof id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
    throw new RegionDeclarationError(`${source}: id must be a non-empty kebab-case string`);
  }
  const [west, south, east, north] = parseBounds(bounds, source);
  if (!Number.isFinite(minElevationM)) {
    throw new RegionDeclarationError(`${source}: minElevationM must be a finite number`);
  }
  // **Every declared choice carries its reason, and every reason is validated and returned.**
  // Two of these were declared in the JSON and silently dropped by this parser, which is the
  // worst of both worlds: the file looks reviewable and the value reaches nothing that could
  // check it. A justification nobody parses is a comment wearing a field's clothing.
  const justifications = {
    minElevationJustification: "explain why the floor is above the treeline",
    zoomJustification: "explain what the zoom range is chosen against",
    contourIntervalJustification: "explain what the contour interval is chosen against",
  };
  for (const [field, expectation] of Object.entries(justifications)) {
    if (typeof value[field] !== "string" || value[field].trim() === "") {
      throw new RegionDeclarationError(`${source}: ${field} must ${expectation}`);
    }
  }

  // The zoom range is a **declared input**, not a product policy, because it decides which
  // source cells the build must have: this region's z11 tiles reach past 7°E and z10's would
  // cross 46°N. Baking a default in would make a coverage requirement change silently with a
  // resolution preference.
  for (const [name, zoom] of [
    ["minZoom", minZoom],
    ["maxZoom", maxZoom],
  ]) {
    if (!Number.isInteger(zoom) || zoom < 0 || zoom > 24) {
      throw new RegionDeclarationError(`${source}: ${name} must be an integer in 0..24`);
    }
  }
  if (maxZoom < minZoom) {
    throw new RegionDeclarationError(
      `${source}: maxZoom ${String(maxZoom)} precedes minZoom ${String(minZoom)}`,
    );
  }

  // Declared like the zoom range, and for the same reason: a contour interval decides what the
  // vector layer *is*, and inferring one from the terrain's range would make two fixtures over
  // neighbouring regions disagree about where their lines are.
  if (!Number.isFinite(contourIntervalM) || contourIntervalM <= 0) {
    throw new RegionDeclarationError(
      `${source}: contourIntervalM must be a positive number of metres`,
    );
  }

  return {
    id,
    bounds: [west, south, east, north],
    minElevationM,
    minElevationJustification,
    minZoom,
    maxZoom,
    zoomJustification: value.zoomJustification,
    contourIntervalM,
    contourIntervalJustification: value.contourIntervalJustification,
  };
}

/**
 * @param {string} path
 * @returns {RegionDeclaration}
 */
export function loadRegionDeclaration(path) {
  const source = readFileSync(path, "utf8");
  let value;
  try {
    value = JSON.parse(source);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new RegionDeclarationError(`${path}: invalid JSON: ${detail}`);
  }
  return parseRegionDeclaration(value, path);
}

/**
 * Fail unless every decoded sample in a cut region is at or above its declared floor.
 *
 * This accepts tile-grouped iterables so the eventual build can feed each decoded COG window
 * through without retaining the whole cut in memory. It scans the complete cut before reporting
 * a violation so the error names the true lowest sample rather than whichever low value happened
 * to be encountered first.
 *
 * **Async-iterable**, because the real reader fetches. `for await` pulls one tile at a time, so
 * a build over many source tiles still holds one crop in memory rather than all of them — the
 * streaming property this signature was chosen for in the first place, preserved rather than
 * traded away for the convenience of resolving every read up front. Each tile's own samples stay
 * a plain iterable: a crop arrives whole, so there is nothing to stream inside one.
 *
 * @param {RegionDeclaration} declaration
 * @param {AsyncIterable<ElevationTile> | Iterable<ElevationTile>} tiles
 * @returns {Promise<{ elevationM: number, tileId: string, sampleIndex: number }>}
 */
export async function assertMinimumElevation(declaration, tiles) {
  const region = parseRegionDeclaration(declaration);
  if (
    tiles === null ||
    tiles === undefined ||
    (typeof tiles[Symbol.asyncIterator] !== "function" &&
      typeof tiles[Symbol.iterator] !== "function")
  ) {
    throw new ElevationFloorError(`region "${region.id}": elevation tiles must be iterable`);
  }

  /** @type {{ elevationM: number, tileId: string, sampleIndex: number } | null} */
  let lowest = null;
  let tileCount = 0;

  for await (const tile of tiles) {
    tileCount += 1;
    if (!isRecord(tile) || typeof tile.tileId !== "string" || tile.tileId.trim() === "") {
      throw new ElevationFloorError(
        `region "${region.id}": elevation tile ${String(tileCount)} must have a non-empty tileId`,
      );
    }
    if (
      tile.elevationsM === null ||
      tile.elevationsM === undefined ||
      typeof tile.elevationsM[Symbol.iterator] !== "function"
    ) {
      throw new ElevationFloorError(
        `region "${region.id}": ${tile.tileId} elevationsM must be iterable`,
      );
    }

    let sampleCount = 0;
    for (const elevationM of tile.elevationsM) {
      if (!Number.isFinite(elevationM)) {
        // Reported at first encounter rather than after the full scan, unlike a floor
        // violation. The scan-before-report rule exists to name the *true* lowest sample, and
        // a non-finite value has no place in that ordering — it is a decode or read failure,
        // a different class from "this region is too low", and continuing past one would mean
        // ranking samples against a value that is not a number.
        throw new ElevationFloorError(
          `region "${region.id}": ${tile.tileId}[${String(sampleCount)}] is not a finite elevation: ${String(elevationM)}`,
        );
      }
      // Strictly less-than, so the **first** sample holding the minimum is the one reported.
      // Ties are otherwise arbitrary, and "the failure names the tile" is an obligation: with
      // an equal minimum in two tiles, first-encountered is a rule someone can predict, where
      // last-encountered would change the named tile on an unrelated reordering of the cut.
      if (lowest === null || elevationM < lowest.elevationM) {
        lowest = { elevationM, tileId: tile.tileId, sampleIndex: sampleCount };
      }
      sampleCount += 1;
    }
    if (sampleCount === 0) {
      throw new ElevationFloorError(
        `region "${region.id}": ${tile.tileId} contains no elevation samples`,
      );
    }
  }

  if (tileCount === 0) {
    throw new ElevationFloorError(
      `region "${region.id}": cannot check the declared floor without elevation samples`,
    );
  }
  // `lowest` is set by here: every tile either threw (no samples, non-iterable, unnamed) or
  // ran the loop at least once. A `lowest === null` arm was unobservable — removing it left
  // the suite green — and `scripts/` is not in `tsconfig.tests.json`, so it was not narrowing
  // a type either. An unreachable guard is a claim nobody can check.
  const deepest = /** @type {{ elevationM: number, tileId: string, sampleIndex: number }} */ (
    lowest
  );
  if (deepest.elevationM < region.minElevationM) {
    throw new ElevationFloorError(
      `region "${region.id}": lowest sample ${String(deepest.elevationM)} m at ` +
        `${deepest.tileId}[${String(deepest.sampleIndex)}] is below the declared floor ` +
        `${String(region.minElevationM)} m`,
    );
  }

  return deepest;
}
