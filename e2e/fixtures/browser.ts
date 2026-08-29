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

/** Console output a test knowingly provokes, and everything else, which is a failure. */
export interface ConsoleWatch {
  /** Declare an error this test expects, with the reason it is expected. */
  allow(pattern: RegExp): void;
  /** Every error seen that no `allow` covers. */
  unexpected(): string[];
}

export function watchConsole(page: Page): ConsoleWatch {
  const seen: string[] = [];
  const allowed: RegExp[] = [];

  page.on("console", (message) => {
    if (message.type() === "error") seen.push(message.text());
  });
  page.on("pageerror", (error) => seen.push(error.message));

  return {
    allow: (pattern) => allowed.push(pattern),
    unexpected: () => seen.filter((line) => !allowed.some((pattern) => pattern.test(line))),
  };
}
