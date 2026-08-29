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
   */
  expect(pattern: RegExp, reason: string, count?: number): void;
  /** Everything wrong with what reached the console: undeclared errors, and absent ones. */
  problems(): string[];
  /**
   * Whether every declared error has arrived.
   *
   * For polling. An expected error is usually the *end* of an asynchronous chain — a fetch,
   * a parse, a rejection — so a test that declares one has to wait for it, or it ends before
   * the thing it is claiming has happened and the declaration proves nothing.
   */
  satisfied(): boolean;
}

interface Declaration {
  readonly pattern: RegExp;
  readonly reason: string;
  readonly count: number | null;
  matched: number;
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

export function watchConsole(page: Page): ConsoleWatch {
  const undeclared: string[] = [];
  const declarations: Declaration[] = [];

  function record(line: string): void {
    // Against the declarations standing at the time the error arrived, so a declaration made
    // after the fact cannot retroactively excuse something already seen.
    const declaration = declarations.find((entry) => entry.pattern.test(line));
    if (declaration === undefined) undeclared.push(line);
    else declaration.matched += 1;
  }

  page.on("console", (message) => {
    if (message.type() === "error") record(message.text());
  });
  page.on("pageerror", (error) => {
    record(error.message);
  });

  const watch: ConsoleWatch = {
    expect: (pattern, reason, count) => {
      declarations.push({ pattern, reason, count: count ?? null, matched: 0 });
    },
    satisfied: () => declarations.every((entry) => entry.matched > 0),
    problems: () => {
      const problems = undeclared.map((line) => `unexpected console error: ${line}`);
      for (const { pattern, reason, count, matched } of declarations) {
        if (matched === 0) {
          problems.push(
            `expected a console error matching ${String(pattern)} (${reason}) — none arrived, ` +
              `so whatever was supposed to produce it did not run`,
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
