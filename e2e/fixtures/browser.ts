// SPDX-License-Identifier: Apache-2.0

import { deflateSync } from "node:zlib";

import type { Page } from "@playwright/test";

/**
 * Tiles the browser lane can actually fetch, and a console it can actually trust.
 *
 * Before MapLibre's worker was wired up, nothing was ever requested, so the invented hosts in
 * these specs cost nothing. With it working, every map test now fetches — and a green run
 * emitted several hundred lines of `AJAXError`. Noise on that scale is not merely untidy: it
 * is where a real failure hides, and a lane that always prints errors cannot fail on one.
 *
 * So the fixtures are served rather than the errors ignored, and anything unexpected on the
 * console fails the test that produced it.
 */

/** A crc32 table, for the PNG chunk checksums. */
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  const typed = Buffer.concat([Buffer.from(type, "ascii"), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

/**
 * A real PNG, built here rather than checked in.
 *
 * 256×256 so it matches the tile size the sources declare; a mismatch would be a second
 * variable in every test that draws one. Flat grey, since nothing asserts on tile pixels —
 * the assertions are about the engine's own layers, which are drawn over these.
 */
/** Exported so a scenario needing *a real, decodable image* reuses the one MapLibre already
 *  renders, rather than hand-writing PNG bytes that only look like a PNG. */
export function fixturePng(): Buffer {
  return tilePng();
}

function tilePng(): Buffer {
  const size = 256;
  const stride = size * 3 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * stride] = 0; // filter: none
    raw.fill(0xd8, y * stride + 1, (y + 1) * stride);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const TILE_PNG = tilePng();

/** Serve the hosts these specs invent, so the lane fetches successfully instead of failing. */
export async function serveMapFixtures(page: Page): Promise<void> {
  await page.route("**/tiles.invalid/**", async (route) => {
    const url = route.request().url();

    if (url.endsWith(".json")) {
      // A TileJSON document pointing back at the raster fixture, so `transport: "tilejson"`
      // sources resolve the same way `template` ones do.
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          tilejson: "2.2.0",
          tiles: ["https://tiles.invalid/{z}/{x}/{y}.png"],
          minzoom: 0,
          maxzoom: 16,
        }),
      });
      return;
    }

    if (url.endsWith(".pbf")) {
      // An empty vector tile is an empty body: the renderer reads it as a tile with no
      // features, which is what these fixtures want — the layers exist, nothing is drawn from
      // them, and the engine's own geometry is what the assertions are about.
      await route.fulfill({ contentType: "application/x-protobuf", body: "" });
      return;
    }

    await route.fulfill({ contentType: "image/png", body: TILE_PNG });
  });

  // The PMTiles archive host. Answered rather than left to fail DNS, so the only error the
  // archive tests see is the one they are about — the client rejecting bytes that are not an
  // archive — instead of that plus a name-resolution failure underneath it. A real archive is
  // deliberately not served: those tests prove the protocol handler is registered and reached,
  // and serving one would test the `pmtiles` package instead of the engine's wiring to it.
  await page.route("**/cdn.invalid/**", async (route) => {
    await route.fulfill({ contentType: "application/octet-stream", body: "not an archive" });
  });
}

/**
 * Console output a test knowingly provokes — and everything else, which is a failure.
 *
 * Declaring an expected error is an **expectation, not a suppression**. A declaration that
 * merely permitted an error would let a test claiming "exactly one error proves the handler
 * was reached" pass in the case where the handler was never reached and no error occurred at
 * all — the claim quietly inverted into its own opposite. So a declared error that never
 * arrives is reported just as loudly as an undeclared one that does.
 */
export interface ConsoleWatch {
  /**
   * Declare an error this test expects, and why.
   *
   * The reason is required because it is the part a later reader needs: an unexplained
   * pattern is indistinguishable from a silenced defect. `count` pins an exact number where
   * the test can rely on one; by default any number of matches will do, but at least one must.
   * A count is judged exactly by {@link ConsoleWatch.problems}; {@link ConsoleWatch.settled}
   * merely stops waiting once it is reached, so a test polling on it waits for the whole
   * chain rather than its first link.
   *
   * Throws on a pattern this watch cannot use reliably, and on a count below one — see
   * {@link watchConsole}.
   */
  expect(pattern: RegExp, reason: string, count?: number): void;
  /** Everything wrong with what reached the console: undeclared errors, and absent ones. */
  problems(): string[];
  /**
   * How many errors have been recorded, whatever became of them.
   *
   * For the watch's own tests. Console messages arrive over a different channel from an
   * `evaluate` response, so their ordering relative to it is conventional rather than
   * guaranteed; a test that emits errors and reads the result immediately is asserting
   * against delivery timing. Polling this to the number emitted removes that.
   */
  seen(): number;
  /**
   * Whether waiting any longer could still help.
   *
   * For polling, and deliberately **not** the same question as {@link ConsoleWatch.problems}.
   * An expected error is usually the *end* of an asynchronous chain — a fetch, a parse, a
   * rejection — so a test that declares one has to wait for it, or it ends before the thing
   * it claims has happened.
   *
   * A counted declaration settles at `>= count`, not at `== count`. Equality looks stricter
   * and is worse: a count that grows towards a final value passes *through* its expected
   * number, so a poll sampling at the wrong moment sees equality hold transiently and lets
   * the test proceed on a premise that is about to stop being true. And past the count,
   * equality never holds again, so the poll runs to a timeout that says "still waiting"
   * about something that already overshot.
   *
   * So settling ends the wait and `problems()` judges the outcome. Overshoot is settled *and*
   * a problem — which is the point: the wait stops, and the failure says what actually
   * happened.
   */
  settled(): boolean;
}

interface Declaration {
  readonly pattern: RegExp;
  readonly reason: string;
  readonly count: number | null;
  matched: number;
}

/** One error, and which declaration absorbed it — so a later report can explain a zero. */
interface Record_ {
  readonly line: string;
  readonly absorbedBy: Declaration | null;
}

/**
 * The watch belonging to a page.
 *
 * Keyed by page rather than held in a module variable: Playwright gives each test its own
 * page, and a shared variable would leak one test's expectations into another the moment the
 * lane runs more than one worker.
 */
const watches = new WeakMap<Page, ConsoleWatch>();

/** The watch for a page, for an `afterEach` that only has the fixture to go on. */
export function consoleFor(page: Page): ConsoleWatch {
  const watch = watches.get(page);
  if (watch === undefined) throw new Error("no console watch for this page — call watchConsole");
  return watch;
}

/**
 * Build the watch for a page.
 *
 * Two things are rejected at declaration time rather than coped with at report time, because
 * a guard that quietly does the wrong thing is the failure mode this whole file exists to
 * prevent — and it applies to what the guard is *handed*, not only to what reaches it.
 */
export function watchConsole(page: Page): ConsoleWatch {
  const records: Record_[] = [];
  const declarations: Declaration[] = [];

  function record(line: string): void {
    // Against the declarations standing at the time the error arrived, so a declaration made
    // after the fact cannot retroactively excuse something already seen.
    const declaration = declarations.find((entry) => entry.pattern.test(line)) ?? null;
    if (declaration !== null) declaration.matched += 1;
    records.push({ line, absorbedBy: declaration });
  }

  page.on("console", (message) => {
    if (message.type() === "error") record(message.text());
  });
  page.on("pageerror", (error) => {
    record(error.message);
  });

  const watch: ConsoleWatch = {
    expect: (pattern, reason, count) => {
      if (pattern.global || pattern.sticky) {
        // `test()` on a `g` or `y` pattern advances `lastIndex`, so the same pattern matches,
        // then misses, then matches. A counted declaration would settle on whichever way the
        // stride happened to fall. Nothing here uses one today, which is exactly why one
        // would be added later without anyone thinking about it.
        throw new Error(
          `console watch: ${String(pattern)} is global or sticky, and \`test\` on one advances ` +
            `lastIndex — matches would alternate. Declare it without the g or y flag.`,
        );
      }
      if (count !== undefined && !Number.isSafeInteger(count)) {
        // `NaN`, a fraction and `Infinity` all slip past a `< 1` test and then declare an
        // expectation that can never resolve: a fraction can never be matched exactly, an
        // infinite one can never be reached, and `NaN` compares false against everything, so
        // the wait never settles and the shortfall can never be named. A count is a number
        // of lines, so it is a whole, finite one.
        throw new Error(
          `console watch: a count of ${String(count)} is not a whole finite number of lines, ` +
            `so nothing could ever satisfy it. Use a positive integer.`,
        );
      }
      if (count !== undefined && count < 1) {
        // "Match this and expect none of it" is a suppression wearing a count, and not what
        // the parameter is for: an undeclared error is already a failure, so nothing needs
        // declaring in order to be forbidden.
        throw new Error(
          `console watch: a count of ${String(count)} declares an error that must not happen, ` +
            `which is what *not* declaring it already does. Use a count of one or more.`,
        );
      }
      declarations.push({ pattern, reason, count: count ?? null, matched: 0 });
    },
    seen: () => records.length,
    // `>=`, so overshoot ends the wait rather than extending it to a timeout. Judging the
    // count is `problems()`'s job; this one only answers whether waiting could still help.
    settled: () =>
      declarations.every((entry) =>
        entry.count === null ? entry.matched > 0 : entry.matched >= entry.count,
      ),
    problems: () => {
      const problems = records
        .filter((entry) => entry.absorbedBy === null)
        .map((entry) => `unexpected console error: ${entry.line}`);

      for (const declaration of declarations) {
        const { pattern, reason, count, matched } = declaration;
        if (matched === 0) {
          // Why it matched nothing matters more than that it did. An earlier declaration
          // whose pattern also covers these lines took them first, so the subject ran fine
          // and the report would otherwise accuse it of not running — the exact
          // misdiagnosis this file exists to prevent, reachable with two declarations.
          const shadow = records.find(
            (entry) =>
              entry.absorbedBy !== null &&
              entry.absorbedBy !== declaration &&
              pattern.test(entry.line),
          );
          problems.push(
            shadow === undefined
              ? `expected a console error matching ${String(pattern)} (${reason}) — none ` +
                  `arrived, so whatever was supposed to produce it did not run`
              : `expected a console error matching ${String(pattern)} (${reason}) — it matched ` +
                  `nothing because ${String(shadow.absorbedBy?.pattern)} was declared first and ` +
                  `absorbed "${shadow.line}". Declarations are first-match-wins; narrow the ` +
                  `earlier one or declare this one before it.`,
          );
        } else if (count !== null && matched !== count) {
          problems.push(
            `expected ${String(count)} console error(s) matching ${String(pattern)} ` +
              `(${reason}) — saw ${String(matched)}`,
          );
        }
      }
      return problems;
    },
  };
  watches.set(page, watch);
  return watch;
}
