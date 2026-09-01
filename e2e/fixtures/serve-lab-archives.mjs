// SPDX-License-Identifier: Apache-2.0

/**
 * Builds the synthetic archive pair and serves it over HTTP with range support (T4.6).
 *
 * **One process, not a setup step plus a server.** The archives live in a temporary directory
 * whose name is chosen at build time, so splitting the two would need the name passed between
 * them through a file or an environment variable — a coordination step that can go stale and
 * leave a scenario serving yesterday's archives. Building where they are served removes it.
 *
 * Range support is the point: PMTiles is read by range request, so a server that ignored `Range`
 * would make every tile read fetch the whole archive and would hide a reader that never asked
 * for a range at all.
 */

import { createReadStream, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

import { buildLabArchives } from "./build-lab-archives.mjs";

const PORT = Number(process.env["LAB_ARCHIVE_PORT"] ?? 5176);
const region = JSON.parse(
  readFileSync(new URL("../../fixtures/vertical/region.json", import.meta.url), "utf8"),
);

const built = await buildLabArchives(region);

const server = createServer((request, response) => {
  // Resolved inside the archive directory and checked, so a `..` in a URL cannot read the repo.
  const name = normalize(decodeURIComponent((request.url ?? "/").split("?")[0] ?? "")).replace(
    /^(\.\.[/\\])+/,
    "",
  );
  const path = join(built.dir, name);
  if (!path.startsWith(built.dir)) {
    response.writeHead(403).end();
    return;
  }

  let size;
  try {
    size = statSync(path).size;
  } catch {
    response.writeHead(404).end();
    return;
  }

  const headers = {
    "content-type": "application/octet-stream",
    "accept-ranges": "bytes",
    // The scenario forbids egress, and a cached archive would let a broken read look successful
    // on a rerun.
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
  };

  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? "");
  if (range === null) {
    response.writeHead(200, { ...headers, "content-length": String(size) });
    createReadStream(path).pipe(response);
    return;
  }

  const start = range[1] === "" ? 0 : Number(range[1]);
  const end = range[2] === "" ? size - 1 : Math.min(Number(range[2]), size - 1);
  if (start > end || start >= size) {
    response.writeHead(416, { ...headers, "content-range": `bytes */${String(size)}` }).end();
    return;
  }
  response.writeHead(206, {
    ...headers,
    "content-length": String(end - start + 1),
    "content-range": `bytes ${String(start)}-${String(end)}/${String(size)}`,
  });
  createReadStream(path, { start, end }).pipe(response);
});

server.listen(PORT, "127.0.0.1", () => {
  // Printed so a human running this by hand knows what was built; Playwright waits on the port.
  process.stdout.write(
    `${JSON.stringify({
      port: PORT,
      dir: built.dir,
      terrain: `http://127.0.0.1:${String(PORT)}/terrain.pmtiles`,
      contours: `http://127.0.0.1:${String(PORT)}/contours.pmtiles`,
      terrainTiles: built.terrainTiles,
      contourTiles: built.contourTiles,
    })}\n`,
  );
});

/**
 * Remove the temporary archives on the way out.
 *
 * Each run cuts about 1.7 MB into a fresh directory, so a browser lane run repeatedly leaves a
 * pile of them behind. Registered for both signals Playwright uses to stop a web server.
 */
let cleaned = false;
function cleanUp() {
  if (cleaned) return;
  cleaned = true;
  rmSync(built.dir, { recursive: true, force: true });
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    cleanUp();
    process.exit(0);
  });
process.on("exit", cleanUp);

// Referenced so the module is not flagged as having an unused import under lint.
export const ARCHIVE_SERVER_ENTRY = fileURLToPath(import.meta.url);
