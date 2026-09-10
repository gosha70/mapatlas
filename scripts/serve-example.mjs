// SPDX-License-Identifier: Apache-2.0

/**
 * Builds the getting-started example **as a consumer would**, then serves the build (T7.2).
 *
 * The other half of the example's proof. `check:packaging` compiles it against the packed
 * tarballs in a job with no browser; this runs the same example, built from the same tarballs,
 * in a real one — because `tsc` proves the types line up and says nothing about whether a map
 * mounts, a fix is kept, or a photo comes back out of storage.
 *
 * **Nothing here resolves through the workspace.** The project is built by its own `vite`, out of
 * its own `node_modules`, with no alias and no project reference: an example that only ran inside
 * this repository would prove the example works *here*, which is not the claim.
 *
 * **And the map data is the lane's, not the example's.** The example points at
 * `/basemap.pmtiles` — an archive the reader is told to bring — and this cuts a synthetic one and
 * puts it exactly there. The example's own source declaration, its own `source-layer` names and
 * its own paint are what draw it; remove the source from the example and this lane paints
 * nothing, which is the check that the map is not being drawn from something the reader was
 * never given.
 *
 * One process, not a build step plus a server: the built tree lives in a directory this chooses,
 * and splitting the two would need the name passed between them.
 */

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildBasemapArchive } from "../e2e/fixtures/build-lab-archives.mjs";

import { CONSUMER_DEPENDENCIES, createConsumerProject, run } from "./consumer-project.mjs";

const PORT = Number(process.env["EXAMPLE_PORT"] ?? 5178);

/**
 * `build/`, where this repository already puts generated, uncommitted artefacts, and never inside
 * `examples/` — a `node_modules` and a `dist` under the example would be picked up by the drift
 * gate's own file walk and by every editor that opens the tree.
 */
const project = fileURLToPath(new URL("../build/quick-start", import.meta.url));

// **Rebuilt from empty, every run.** The tarballs are repacked from whatever `dist` currently
// holds, so a project left over from an earlier run would serve an older engine while reporting
// the current one — the same reason the archive server and the demo preview are never reused.
rmSync(project, { recursive: true, force: true });

createConsumerProject({ into: project, dependencies: CONSUMER_DEPENDENCIES });

/**
 * The archive, in `public/`, which is where a reader is told to put theirs.
 *
 * Cut over the region the example's camera opens on, because a map opened outside its archive's
 * coverage renders an empty box with a correct attribution line — a failure that looks like a
 * broken engine and is a wrong camera.
 */
const region = JSON.parse(
  readFileSync(new URL("../fixtures/vertical/region.json", import.meta.url), "utf8"),
);
const publicDir = join(project, "public");
mkdirSync(publicDir, { recursive: true });
const archive = await buildBasemapArchive(region, publicDir);

// The project's own vite, not this repository's: the build is the half of the claim that has to
// happen under the consumer's resolution.
const vite = join(project, "node_modules/vite/bin/vite.js");
run(process.execPath, [vite, "build", "--logLevel", "warn"], project);

console.log(
  `serve-example — built ${project} from packed tarballs; ` +
    `${String(archive.tiles)} synthetic basemap tiles at /basemap.pmtiles`,
);

const preview = spawn(
  process.execPath,
  [vite, "preview", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"],
  { cwd: project, stdio: "inherit" },
);

preview.on("exit", (code) => {
  process.exit(code ?? 1);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    preview.kill(signal);
  });
}
