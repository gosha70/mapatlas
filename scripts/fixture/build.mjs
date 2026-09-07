// SPDX-License-Identifier: Apache-2.0

import { assertCoverage, assertSnapshotFresh, loadCoverageSnapshot } from "./coverage.mjs";
import {
  LICENCE_ENTRY_PATH,
  declaredText,
  assertArchiveCarriesAttribution,
  assertNotForDistribution,
  assertArchiveCarriesLicence,
  assertStringsBackedByLicence,
} from "./licence.mjs";
import { contourTiles, levelsFor, traceContours } from "./contour.mjs";
import { productionEnvelope, tilesInRange } from "./mercator.mjs";
import { assertMinimumElevation, parseRegionDeclaration } from "./region.mjs";
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
  "contours",
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
 * @param {{ regionPath: string, snapshotPath: string, licencePath: string, attributionPath: string, terrainArchivePath: string, contourArchivePath: string }} paths
 * @param {{
 *   readText: (path: string) => string,
 *   readJson: (path: string) => unknown,
 *   io: object,
 *   probe: (tileId: string) => { status: number } | Promise<{ status: number }>,
 *   readTile: (tileId: string, bounds: [number, number, number, number]) => Promise<object>,
 *   encodeRasterTile: (surface: object, z: number, x: number, y: number) => Uint8Array,
 *   writeArchive: (path: string, tiles: Array<{ z: number, x: number, y: number, bytes: Uint8Array }>, meta: object) => Promise<{ entries: () => Iterable<{ path: string, text: string }> }>,
 *   finaliseArchive: (from: string, to: string) => void | Promise<void>,
 *   discardArchive: (path: string) => void | Promise<void>,
 *   now: () => Date,
 * }} deps
 *
 * `writeArchive` receives canonical `z/x/y` tiles and one `meta` object carrying the bounds, the
 * zoom range, the payload type and compression, the distributable flag and the licence inputs —
 * rather than the positional licence arguments it took when there was one archive of one kind.
 *
 * `discardArchive` must tolerate a path that was never created, and **what it is called with
 * depends on how far promotion got**: before any rename has succeeded, only the partials, since a
 * previous build's finals are still whole and consistent; once one has landed, every final —
 * including paths written by a previous build — followed by every partial. It is never called
 * with nothing.
 *
 * @returns {Promise<{ roles: string[], distributable: boolean, region: string, envelope: number[], sourceCells: string[], contourLevels: number[], archives: Array<{ kind: string, path: string, tiles: number }>, lowest: object }>}
 */
export async function runBuild(paths, deps, options = {}) {
  const distributable = options.distributable ?? true;

  /**
   * Load one product's licence bundle: its documents, its declaration, its roles.
   *
   * **Per product, because obligations are per product** (ADR-0038). Copernicus declares four
   * roles against one document; the basemap declares three against three, and none of
   * Copernicus's four applies to it because ODbL has no words for them. A single shared pair of
   * paths could only ever express one of the two.
   */
  const loadBundle = async (spec) => {
    const documents = [];
    for (const doc of spec.documents) {
      documents.push({
        id: doc.id,
        entryPath: doc.entryPath,
        text: await at("licence", () => deps.readText(doc.path)),
      });
    }
    const declared = await at("licence", () => deps.readJson(spec.attributionPath));
    const texts = Object.fromEntries(documents.map((d) => [d.id, d.text]));
    const roles = await at("licence", () =>
      assertStringsBackedByLicence(
        /** @type {Record<string, unknown>} */ (declared),
        // One document keeps the single-text form, so its error messages still name the file
        // rather than an id the reader has never seen.
        documents.length === 1 ? documents[0].text : texts,
        documents.length === 1 ? documents[0].id : spec.name,
        spec.requiredRoles === undefined ? {} : { requiredRoles: spec.requiredRoles },
      ),
    );
    return { name: spec.name, documents, declared, roles };
  };

  const copernicus = distributable
    ? await loadBundle({
        name: "the Copernicus licence",
        documents: [
          { id: paths.licencePath, path: paths.licencePath, entryPath: LICENCE_ENTRY_PATH },
        ],
        attributionPath: paths.attributionPath,
      })
    : undefined;

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

  const addresses = [...tilesInRange(declaration.bounds, declaration.minZoom, declaration.maxZoom)];

  /**
   * The basemap, when the caller asked for one.
   *
   * **Optional, and absent is not a degraded build.** The terrain fixture predates it and its
   * tests declare no basemap paths; a stage that ran unconditionally would put a network read
   * into every one of them. `build-fixture.mjs` supplies the paths, so the committed entry point
   * always builds it and the suite reaches the same code through a synthetic upstream.
   */
  const basemap =
    paths.basemapArchivePath === undefined
      ? undefined
      : await at("basemap", async () => {
          const pin = deps.readJson(paths.basemapPinPath);
          const region = await deps.readBasemapRegion(pin, declaration.bounds);
          return { pin, ...region };
        });

  const basemapLicence =
    basemap === undefined || !distributable
      ? undefined
      : await loadBundle({
          name: "the basemap licence bundle",
          documents: paths.basemapLicenceDocuments,
          attributionPath: paths.basemapAttributionPath,
          requiredRoles: paths.basemapRoles,
        });

  /**
   * The notice the extract carries — ODbL §4.3, not §4.2 (ADR-0038).
   *
   * The licence documents back the declaration and are **not** archive payload: §4.2's "a copy of
   * this License or its URI" belongs to the clause about conveying a Database, and this extract is
   * a Produced Work. What §4.3 requires is a notice naming the source and the licence, which is
   * what this is.
   */
  const basemapNotice =
    basemap === undefined || !distributable
      ? undefined
      : await at("licence", () => deps.readJson(paths.basemapNoticePath));

  const { surface, rasterTiles } = await at("tiles", () => {
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
    const stitched = stitchSurface(crops);
    return {
      surface: stitched,
      rasterTiles: addresses.map(({ z, x, y }) => ({
        z,
        x,
        y,
        // Through the seam, not a static import. This is a testability seam for one pipeline
        // invariant — "no raster tile is encoded before the floor passes" — which a static
        // `encodePng` made observable by nothing: the audit's deferred-floor mutants survived
        // every assertion that was not about an unrelated difference. It is not a new
        // abstraction; production binds it to exactly the composition that used to sit here.
        bytes: deps.encodeRasterTile(stitched, z, x, y),
      })),
    };
  });

  const contours = await at("contours", () => {
    // **Levels come from the declared region; the surface stays the envelope.** Interpolation
    // and tiling need the wider grid — a contour crossing the region's edge has to be traced
    // from terrain on both sides of it — but a level is a statement about the region, and
    // deriving them from the envelope would generate lines for valley floors the fixture does
    // not cover, only to clip every one of them away.
    // No cross-check here against the floor stage's minimum. It was written — the two scan the
    // same samples by different routes — and removed, because no input this build can receive
    // makes them disagree: it would take a defect inside `stitchSurface`, which is not injectable
    // and is tested directly. A guard nothing can reach is a claim nobody can check.
    const range = regionRange(surface, declaration.bounds);
    const levels = levelsFor(range.lowestM, range.highestM, declaration.contourIntervalM);
    if (levels.length === 0) {
      // The declaration, not the terrain, is what is wrong here — and saying so is the whole
      // point of the message. A fixture whose contour layer is empty does not demonstrate
      // contours, which is what this archive exists for (ADR-0024, criterion 4).
      throw new Error(
        `the declared region spans ${(range.highestM - range.lowestM).toFixed(1)} m ` +
          `(${range.lowestM.toFixed(1)}..${range.highestM.toFixed(1)}), which contains no multiple ` +
          `of the declared ${String(declaration.contourIntervalM)} m contour interval — ` +
          `declare a smaller interval or a region with more relief`,
      );
    }
    // The levels are reported, not just used. Whether they came from the region or the envelope
    // is **invisible in the tiles**: an envelope-derived level below the region's minimum traces
    // a contour outside the region, which tiling then clips away. The output is identical and
    // the work is not — 43 levels against 23 on the real region — so the only place the
    // requirement can be observed is in what the build says it traced.
    return { levels, tiles: contourTiles(traceContours(surface, levels), addresses) };
  });

  // **Two archives, and neither is named until both have passed.** PMTiles v3 carries one
  // archive-level tile type and one compression, so raster terrain and vector contours cannot
  // share one (ADR-0025). They are still one fixture: a build that finalised terrain and then
  // failed on contours would leave `/lab` and the browser scenario a half-built stack that looks
  // complete, which is the same failure as leaving a licence-violating archive on disk, one level
  // up. So every partial is written and checked first, and only then are they all renamed.
  //
  // A development build is named so it cannot be mistaken for a shippable one, and the name is
  // not cosmetic: it is what stops a local run's output being read by anything that expects the
  // distributable path.
  const outputs = [
    {
      kind: "terrain",
      licence: copernicus,
      path: distributable ? paths.terrainArchivePath : `${paths.terrainArchivePath}.dev`,
      tiles: rasterTiles,
      tileType: "png",
      // PNG is already deflated; gzipping it again buys nothing and costs a decode.
      compression: "none",
    },
    {
      kind: "contours",
      licence: copernicus,
      path: distributable ? paths.contourArchivePath : `${paths.contourArchivePath}.dev`,
      tiles: contours.tiles,
      tileType: "mvt",
      // Vector tiles are protobuf and compress well; this is the whole reason the two cannot
      // share an archive even setting the tile type aside.
      compression: "gzip",
    },
    ...(basemap === undefined
      ? []
      : [
          {
            kind: "basemap",
            licence: basemapLicence,
            carriesDocuments: false,
            path: distributable ? paths.basemapArchivePath : `${paths.basemapArchivePath}.dev`,
            tiles: basemap.tiles,
            tileType: "mvt",
            // **Uncompressed, which is what was proved.** `getZxy` hands back the tile already
            // decompressed, and `basemap-roundtrip.mjs` established byte identity through a
            // `compression: "none"` write. Re-gzipping would be smaller and is not what the
            // round-trip measured, so it is a change to make against a fresh proof rather than
            // on the way past.
            compression: "none",
            // Upstream's whole metadata document travels: `vector_layers` is the v4 schema 4b's
            // style layers are written against, `attribution` is a licence obligation, and the
            // `planetiler:*` keys say which OSM replication these tiles came from. An extract
            // that dropped them would render identically and be untraceable (ADR-0038).
            // **`attribution` is a string.** PMTiles defines it as one, and upstream's is
            // `<a …>© OpenStreetMap</a>` — which omits "contributors" and so satisfies nothing
            // declared. Ours supersedes it and carries the §4.3 notice in one line; the
            // structured evidence lives under `mapatlas:` keys, where a role map belongs.
            attribution:
              `${basemapNotice.credit} — data available under the ` +
              `${basemapNotice.licence}, ${basemapNotice.licenceUri} — source ` +
              `${basemapNotice.sourceUri}`,
            extraMetadata: {
              ...basemap.metadata,
              "mapatlas:notice": basemapNotice,
              "mapatlas:attribution": Object.fromEntries(
                Object.entries(basemapLicence?.declared ?? {}).map(([role, value]) => [
                  role,
                  declaredText(value),
                ]),
              ),
              "mapatlas:source": {
                product: basemap.pin.product,
                key: basemap.pin.key,
                url: basemap.pin.url,
                version: basemap.pin.version,
                size: basemap.pin.size,
                blake3: basemap.pin.blake3,
              },
            },
          },
        ]),
  ].map((output) => ({ ...output, partialPath: `${output.path}.partial` }));

  /**
   * Whether any rename has **succeeded**, which decides what a failure has to clean up.
   *
   * Before promotion starts, a previous build's pair is untouched and still consistent with
   * itself — destroying it because an unrelated rebuild failed early would be gratuitous, and
   * a rename that *threw* has modified nothing, so it counts as early. Once one has landed, the
   * pair on disk is a mixture of two builds whatever happens next, and only removing all of it
   * restores an honest state.
   */
  let promotionStarted = false;

  try {
    for (const output of outputs) {
      // The writer is inside the `try` too: one that fails midway leaves a partial behind just
      // as a failing check does. The `.partial` suffix already keeps consumers from picking it
      // up, so this is tidiness rather than safety — but a leftover whose only protection is a
      // naming convention is one rename away from being a real one.
      const archive = await at("archive", () =>
        deps.writeArchive(output.partialPath, output.tiles, {
          // **The declared region, not the envelope.** The bounds advertise what a consumer
          // asked for and what a renderer should request tiles within; the envelope is an
          // implementation detail of how complete tiles were produced, and publishing it would
          // invite requests for tiles outside the region.
          bounds: declaration.bounds,
          ...(output.extraMetadata ?? {}),
          minzoom: output.kind === "basemap" ? basemap.pin.minZoom : declaration.minZoom,
          maxzoom: output.kind === "basemap" ? basemap.pin.maxZoom : declaration.maxZoom,
          tileType: output.tileType,
          compression: output.compression,
          // Passed rather than inferred from an empty licence: a writer guessing the mode from
          // whether a string is blank would put a development archive one truthiness bug away
          // from looking distributable.
          distributable,
          // Documents are archive payload only for a product whose terms require it
          // (Copernicus). The basemap carries a notice instead, so it declares none.
          licenceDocuments: output.carriesDocuments === false ? [] : output.licence?.documents,
          // Flattened for the archive: a consumer reads role → text. The document each string is
          // backed by is a property of the *declaration*, checked above, and is not something a
          // recipient needs in order to display a credit.
          attribution:
            output.attribution ??
            Object.fromEntries(
              Object.entries(output.licence?.declared ?? {}).map(([role, value]) => [
                role,
                declaredText(value),
              ]),
            ),
        }),
      );
      // **Both archives are derived works**, so both carry the notices. Checking only the one
      // that happens to hold the elevation data would ship contours traced from the same source
      // with no attribution at all.
      if (distributable) {
        // **Once per document.** A recipient bound by three documents needs all three; checking
        // only the first would ship an archive whose share-alike obligation travels with no text
        // to read it in.
        for (const doc of output.carriesDocuments === false ? [] : output.licence.documents) {
          await at("archive", () => assertArchiveCarriesLicence(archive, doc.text, doc.entryPath));
        }
        // The second half of obligation 1: the strings were checked against the documents above,
        // and this is where they are confirmed to have reached the archive rather than stopping
        // at the validation. **Every document is excluded**, or a string is found inside the very
        // document it was drawn from and the check passes with nothing emitted.
        await at("archive", () =>
          assertArchiveCarriesAttribution(
            archive,
            /** @type {Record<string, unknown>} */ (output.licence.declared),
            output.carriesDocuments === false
              ? []
              : output.licence.documents.map((d) => d.entryPath),
          ),
        );
      } else {
        await at("archive", () => assertNotForDistribution(archive));
      }
    }
    // Promotion is a sequence of renames, and a filesystem offers no way to make several of them
    // one operation — so if a later one fails, the earlier ones have already published. Tracked
    // and rolled back rather than left: half a stack on disk looks complete to anything reading
    // the finalised paths, which is the failure this whole dance exists to prevent.
    for (const output of outputs) {
      await at("archive", () => deps.finaliseArchive(output.partialPath, output.path));
      // **After the rename, not before.** A first rename that throws has modified nothing, so
      // the previous pair is still whole and consistent — setting the flag ahead of the call
      // deleted it anyway, which is exactly the case the flag exists to spare.
      promotionStarted = true;
    }
  } catch (error) {
    // **Every path is attempted, and failures are collected rather than thrown from inside the
    // loop.** A `for` that awaited each in turn stopped at the first rejection and left every
    // later partial on disk — the cleanup's own failure quietly becoming a second leak. Promoted
    // finals come first: they are the ones a consumer could already be reading.
    //
    // **Every final path, not only the ones this build renamed.** A rebuild finds both finals
    // already present; if terrain is replaced and contours then fails, removing only what this
    // build promoted leaves the *previous* contour archive published beside no terrain at all —
    // the same half-built stack, assembled from two builds instead of one. The invariant is
    // therefore: **once promotion has begun, a failure leaves no archive on disk.**
    const cleanupFailures = [];
    // **All finals first, then all partials** — not interleaved per archive. Finals are the only
    // paths a consumer can see, so every one of them goes before any effort is spent on a
    // `.partial` nothing reads. `flatMap` over the outputs produced terrain-final,
    // terrain-partial, contour-final, contour-partial, which leaves the contour archive visible
    // for as long as the terrain partial's removal takes — or forever, if it hangs.
    const doomed = promotionStarted
      ? [...outputs.map((output) => output.path), ...outputs.map((output) => output.partialPath)]
      : outputs.map((output) => output.partialPath);
    for (const path of doomed) {
      try {
        await deps.discardArchive(path);
      } catch (failure) {
        // Wrapped with the path it could not remove. `discardArchive` is injected and nothing
        // obliges its errors to name anything, so several raw `permission denied`s are
        // indistinguishable — and which archive is still on disk is the one thing a reader needs.
        cleanupFailures.push(new Error(`could not discard ${path}`, { cause: failure }));
      }
    }
    if (cleanupFailures.length > 0) {
      // A cleanup that fails must not become the story. `discardArchive` is `fs.rm` on a path a
      // failing build just wrote, so rejecting is entirely plausible — and letting it propagate
      // raw would replace "the archive carries no LICENSE" with "permission denied", losing both
      // the reason the build failed and the stage that names it. Everything is kept, flat and
      // original first: nesting these would bury the cause a reader needs under a wrapper.
      throw new BuildError(
        error.stage,
        new AggregateError(
          [error.cause, ...cleanupFailures],
          `the ${error.stage} stage failed and ${String(cleanupFailures.length)} archive path(s) ` +
            `could not be cleaned up`,
        ),
      );
    }
    throw error;
  }

  return {
    // The roles each product's declaration carried. Reported per product now that a build can
    // ship archives under different licences — a flat list would have said which obligations were
    // checked without saying whose.
    roles: copernicus?.roles ?? [],
    distributable,
    region: declaration.id,
    envelope,
    sourceCells,
    contourLevels: contours.levels,
    archives: outputs.map(({ kind, path, tiles }) => ({ kind, path, tiles: tiles.length })),
    ...(basemap === undefined
      ? {}
      : {
          basemap: {
            pin: basemap.pin.key,
            version: basemap.pin.version,
            tiles: basemap.tiles.length,
            absent: basemap.absent.length,
            rangeRequests: basemap.read.requests,
            rangeBytes: basemap.read.bytes,
          },
        }),
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
 * The lowest and highest samples of the declared region, read off the stitched surface.
 *
 * Scans the region rather than the envelope, because a contour level is a statement about the
 * region. The envelope reaches a tile's width beyond it, which around a summit means valley
 * floors — deriving levels from that generates lines for terrain the fixture does not cover, and
 * then throws every one of them away at tiling.
 *
 * @param {import("./resample.mjs").ElevationGrid} surface
 * @param {[west: number, south: number, east: number, north: number]} region
 * @returns {{ lowestM: number, highestM: number }}
 */
function regionRange(surface, region) {
  const window = regionWindow(surface, region);
  if (window === null) {
    throw new Error("the stitched surface does not cover the declared region");
  }
  let lowestM = Infinity;
  let highestM = -Infinity;
  for (let r = 0; r < window.rows; r += 1) {
    const base = (window.row0 + r) * surface.width + window.col0;
    for (let c = 0; c < window.cols; c += 1) {
      const value = surface.elevationsM[base + c];
      if (value < lowestM) lowestM = value;
      if (value > highestM) highestM = value;
    }
  }
  return { lowestM, highestM };
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
