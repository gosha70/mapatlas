// SPDX-License-Identifier: Apache-2.0

/**
 * Coverage: which source tiles a cut requires, and what an absent one means (T4.6, obligations
 * 2 and 3).
 *
 * Two facts about GLO-30 Public shape everything here. Its tiles are 1°×1° cells named for
 * their **south-west** corner, and its public release is a deliberate subset — some countries'
 * tiles are not published and there are no ocean tiles at all (ADR-0024, criterion 1). So a
 * region can be partially covered with no country-level list saying so, and coverage has to be
 * checked per tile.
 *
 * Absence was measured rather than assumed: an unpublished tile answers **404**, which the
 * transport layer already distinguishes from a 5xx or a timeout. What it does not distinguish
 * is an *expected* 404 from an *unexpected* one, and those demand opposite actions — a tile
 * that was never published means "choose another region", while a 404 for a tile the snapshot
 * lists means the layout or the release changed and re-picking the region would be wrong. That
 * is what the snapshot classifies, and it is why detection being free does not make it
 * optional.
 *
 * Nothing here fetches. The probe is injected, so the whole obligation is testable against
 * constructed inputs with no network, and the one part that cannot be — whether a given tile is
 * published today — stays at the build's edge.
 *
 * The snapshot lists what **is** published rather than what is not, and the reason is
 * provenance rather than size. The release publishes 26,450 of the 64,800 possible 1° cells, so
 * an absence list would hold 38,350 — larger, but only by about 1.45×, which on its own would
 * not decide anything. What decides it is that the positive list is the artifact the source
 * itself ships (`tileList.txt`), while an absence list could only be produced by subtracting it
 * from an enumeration nobody publishes. One is derived from an authoritative file; the other is
 * a table somebody computed and would have to recompute.
 */

import { parseBounds } from "./region.mjs";

/** Degrees per source tile, both axes. GLO-30 Public ships 1°×1° cells. */
const TILE_DEGREES = 1;

/**
 * Statuses that mean "the tile is there".
 *
 * 206 is not a nicety: the build discovers coverage during the COG **range** reads it has to
 * make anyway, and a range read of a present tile answers 206, not 200. Accepting only 200
 * would reject every successful read the real build performs. Enumerated rather than accepting
 * 2xx generally — 204 is a success status carrying no tile bytes, and treating it as presence
 * would let an empty answer stand in for data.
 */
const PRESENT_STATUSES = new Set([200, 206]);

export class CoverageError extends Error {
  /**
   * @param {string} message
   * @param {"unpublished" | "unexpected" | "unreachable"} kind
   */
  constructor(message, kind) {
    super(message);
    this.name = "CoverageError";
    this.kind = kind;
  }
}

/**
 * The tile id for a cell's south-west corner, in the source's own naming.
 *
 * @param {number} south
 * @param {number} west
 * @returns {string}
 */
export function tileId(south, west) {
  const ns = south < 0 ? "S" : "N";
  const ew = west < 0 ? "W" : "E";
  return `${ns}${String(Math.abs(south)).padStart(2, "0")}${ew}${String(Math.abs(west)).padStart(3, "0")}`;
}

/**
 * Every source tile a cut needs, in a stable order.
 *
 * The upper edges are **half-open**: a cut whose north edge is exactly 46 needs no `N46` tile,
 * because its samples at that latitude are the top row of `N45`, and demanding a tile for a
 * line of zero width would fail a build over a neighbour it never reads. The lower edges are
 * closed for the same reason in reverse.
 *
 * @param {[west: number, south: number, east: number, north: number]} bounds
 * @returns {string[]}
 */
export function requiredTiles(bounds) {
  // The same validator the region declaration uses, not a second copy: invalid bounds would
  // otherwise enumerate nothing, and a cut requiring no tiles discharges coverage without
  // probing anything — a check passing because it had nothing to check.
  const [west, south, east, north] = parseBounds(bounds, "required tiles");
  const first = (v) => Math.floor(v / TILE_DEGREES) * TILE_DEGREES;
  // `- 1` where a bound lands exactly on a cell edge: that edge belongs to the cell below it.
  const last = (v) => (Number.isInteger(v / TILE_DEGREES) ? v - TILE_DEGREES : first(v));

  const ids = [];
  for (let lat = first(south); lat <= last(north); lat += TILE_DEGREES) {
    for (let lon = first(west); lon <= last(east); lon += TILE_DEGREES) {
      ids.push(tileId(lat, lon));
    }
  }
  return ids;
}

/**
 * @typedef {object} CoverageSnapshot
 * @property {string} source Where the list came from.
 * @property {string} retrievedAt ISO date the published list was read.
 * @property {number} maxAgeDays Beyond this the snapshot fails the build on its own.
 * @property {Set<string>} published Tile ids the release listed at that date.
 */

/**
 * Fail unless the snapshot is fresh enough to classify anything.
 *
 * A retrieval date alone asks a reader to judge staleness with no basis for the judgement, so
 * the threshold is declared and enforced rather than left to whoever reads the failure. It can
 * be generous precisely because the snapshot is not load-bearing for the archive's correctness:
 * a stale one yields a less useful message, never a wrong archive.
 *
 * @param {CoverageSnapshot} snapshot
 * @param {Date} now
 */
export function assertSnapshotFresh(snapshot, now) {
  const retrieved = new Date(snapshot.retrievedAt);
  if (Number.isNaN(retrieved.getTime())) {
    throw new CoverageError(
      `coverage snapshot: retrievedAt ${JSON.stringify(snapshot.retrievedAt)} is not a date`,
      "unreachable",
    );
  }
  const ageDays = (now.getTime() - retrieved.getTime()) / 86_400_000;
  if (ageDays < 0) {
    // A snapshot dated in the future never expires, and would keep classifying against a
    // release nobody has read. A wrong clock is a reason to stop, not to trust the file.
    throw new CoverageError(
      `coverage snapshot: retrievedAt ${snapshot.retrievedAt} is in the future — the snapshot ` +
        `or the clock is wrong, and either way its age cannot be judged`,
      "unreachable",
    );
  }
  if (!Number.isFinite(snapshot.maxAgeDays) || snapshot.maxAgeDays <= 0) {
    throw new CoverageError(
      `coverage snapshot: maxAgeDays ${String(snapshot.maxAgeDays)} cannot expire anything`,
      "unreachable",
    );
  }
  if (ageDays > snapshot.maxAgeDays) {
    throw new CoverageError(
      `coverage snapshot: retrieved ${snapshot.retrievedAt}, ${ageDays.toFixed(0)} days ago, ` +
        `past its declared ${String(snapshot.maxAgeDays)}-day limit — re-read the published ` +
        `tile list before trusting it to classify an absent tile`,
      "unreachable",
    );
  }
}

/**
 * Load the snapshot manifest and the tile list it names, refusing a pair that has drifted.
 *
 * The manifest carries the list's digest because they are two files that must agree: editing
 * one without the other would leave a snapshot whose date and provenance describe a list it no
 * longer refers to, and every classification after that would be confidently wrong about which
 * release it was speaking for.
 *
 * @param {string} manifestPath
 * @param {{ readFileSync: (p: string, enc: string) => string, dirname: (p: string) => string, join: (...p: string[]) => string, sha256: (s: string) => string }} io
 * @returns {CoverageSnapshot}
 */
export function loadCoverageSnapshot(manifestPath, io) {
  let manifest;
  try {
    manifest = JSON.parse(io.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new CoverageError(`${manifestPath}: invalid JSON: ${detail}`, "unreachable");
  }

  const listPath = io.join(io.dirname(manifestPath), String(manifest.tileListFile));
  const listText = io.readFileSync(listPath, "utf8");
  const digest = io.sha256(listText);
  if (digest !== manifest.tileListSha256) {
    throw new CoverageError(
      `${listPath}: sha256 ${digest} does not match the ${manifest.tileListSha256} recorded in ` +
        `${manifestPath} — the list and the snapshot describing it have drifted apart`,
      "unreachable",
    );
  }

  const published = new Set(
    listText
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== ""),
  );
  if (published.size !== manifest.tileCount) {
    throw new CoverageError(
      `${listPath}: holds ${String(published.size)} distinct tiles, not the ` +
        `${String(manifest.tileCount)} recorded in ${manifestPath}`,
      "unreachable",
    );
  }

  // Validated here rather than trusted at the comparison. `Number(undefined)` is `NaN`, and
  // `ageDays > NaN` is false for every age — a missing or mistyped limit would not loosen
  // expiry, it would switch it off, silently, leaving a check that can never fire.
  const maxAgeDays = Number(manifest.maxAgeDays);
  if (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0) {
    throw new CoverageError(
      `${manifestPath}: maxAgeDays must be a finite positive number of days, not ` +
        `${JSON.stringify(manifest.maxAgeDays)} — an unusable limit disables expiry rather ` +
        `than relaxing it`,
      "unreachable",
    );
  }

  return {
    source: String(manifest.source),
    retrievedAt: String(manifest.retrievedAt),
    maxAgeDays,
    published,
  };
}

/**
 * Check every tile a cut requires, and classify any that is not there.
 *
 * There is no fill path and no skip path: this returns the tiles or it throws. The build's
 * refusal to invent a tile is the absence of a branch rather than a guard around one, so there
 * is nothing here to relax under pressure.
 *
 * @param {[west: number, south: number, east: number, north: number]} bounds
 * @param {(id: string) => { status: number }} probe
 * @param {CoverageSnapshot} snapshot
 * @returns {string[]} the tile ids, all confirmed present
 */
export function assertCoverage(bounds, probe, snapshot) {
  const required = requiredTiles(bounds);

  for (const id of required) {
    let status;
    try {
      ({ status } = probe(id));
    } catch (error) {
      // A probe that throws — a timeout, a DNS failure, a socket reset — is a transport
      // failure like a 5xx, and must arrive as one. Letting it escape raw would mean the one
      // caller that distinguishes these three cases receives an error with no `kind` on it.
      throw new CoverageError(
        `tile ${id} could not be read: ${error instanceof Error ? error.message : String(error)} ` +
          `— a transport failure rather than an absence, so the region is not implicated`,
        "unreachable",
      );
    }
    if (PRESENT_STATUSES.has(status)) continue;

    if (status === 404 && !snapshot.published.has(id)) {
      throw new CoverageError(
        `no published tile at ${id}: the release listed at ${snapshot.retrievedAt} does not ` +
          `include it, so this region cannot be archived — choose bounds that avoid it`,
        "unpublished",
      );
    }
    if (status === 404) {
      throw new CoverageError(
        `no tile at ${id}, but the coverage snapshot (${snapshot.retrievedAt}) lists it as ` +
          `published — the release, the bucket layout or the naming has changed since, so ` +
          `neither retrying nor re-picking the region is the fix`,
        "unexpected",
      );
    }
    throw new CoverageError(
      `tile ${id} could not be read: HTTP ${String(status)} — a transport failure rather than ` +
        `an absence, so the region is not implicated`,
      "unreachable",
    );
  }

  return required;
}
