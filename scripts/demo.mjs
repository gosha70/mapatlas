// SPDX-License-Identifier: Apache-2.0

/**
 * `npm run demo` — start the demo app, in one command, with one thing to click.
 *
 * **This exists because the demo could not be demonstrated.** Every seam was tested and the app
 * was reachable only by someone who already knew to run vite on one port, a *range-capable*
 * static server on another, and to hand-assemble a query string naming three archives. A demo
 * that takes insider knowledge to start demonstrates that the repository works, not that the
 * packages do — which is the failure `CLAUDE.md` says this app exists to avoid.
 *
 * In order: build the packages, cut the archives if they are missing, serve them with range
 * support, start the app, **wait until it answers**, and print one URL. Ctrl-C stops everything.
 *
 * **Nothing is bundled.** The archives are cut locally into `build/fixture/`, which git ignores;
 * the repository never carries map tiles.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";

import { serveArchives } from "./serve-archives.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ARCHIVE_DIR = "build/fixture";
const ARCHIVE_PORT = 5176;
const APP_PORT = 5175;

/** The three archives the demo draws, by the query parameter each is named with. */
export const ARCHIVES = Object.freeze({
  basemap: "basemap.pmtiles",
  terrain: "terrain.pmtiles",
  contours: "contours.pmtiles",
});

export const demoUrl = (appPort = APP_PORT, archivePort = ARCHIVE_PORT) =>
  `http://127.0.0.1:${String(appPort)}/?${Object.entries(ARCHIVES)
    .map(
      ([name, file]) =>
        `${name}=${encodeURIComponent(`http://127.0.0.1:${String(archivePort)}/${file}`)}`,
    )
    .join("&")}`;

/** Run a command to completion, failing on a non-zero exit. */
function runToCompletion(command, args, { cwd = ROOT, stdio = "inherit" } = {}) {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { cwd, stdio, shell: false });
    child.on("error", fail);
    child.on("exit", (code) =>
      code === 0 ? done() : fail(new Error(`${command} ${args[0] ?? ""} exited ${String(code)}`)),
    );
  });
}

/**
 * Wait until the app answers, **or until the child says it never will**.
 *
 * `spawn` returning is not the app listening. Printing a URL at that moment hands someone a dead
 * link for as long as vite takes to boot — and if the child is about to die, one that will never
 * work at all. So the child's `error` and early `exit` are watched alongside the probe.
 *
 * **Recorded, not raced** — see the note inside. An earlier version put the child's rejection
 * into a `Promise.race` against the probe, and this comment described that design after it had
 * been replaced.
 */
export async function waitForApp(child, probe, { attempts = 100, pause = 150 } = {}) {
  /**
   * Recorded, not raced.
   *
   * The first version put the child's rejection into a `Promise.race` against the probe. It never
   * fired: `probe()` resolves in a microtask queued before the watch's, so "not ready" won every
   * iteration and an exited process was polled until the timeout — reported as "did not answer",
   * which blames the port rather than the process that died on it. A recorded failure checked
   * either side of each wait is deterministic, and the tests exercise both orderings.
   */
  let failure;
  child.once("error", (error) => {
    failure = error;
  });
  child.once("exit", (code) => {
    failure ??= new Error(`the app exited (${String(code)}) before it was ready`);
  });

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (failure !== undefined) throw failure;
    // **The result is captured, not acted on.** Returning straight from a truthy probe skipped
    // the check below, so a probe that overlapped the child's exit — or one answered by a server
    // that is not ours — reported ready for a process that had already died.
    const answered = await probe().catch(() => false);
    if (failure !== undefined) throw failure;
    if (answered) return;
    await new Promise((tick) => setTimeout(tick, pause));
  }
  if (failure !== undefined) throw failure;
  throw new Error(`the app did not answer on port ${String(APP_PORT)} in time`);
}

/**
 * Refuse to start when something already holds the app's port.
 *
 * **Readiness has to belong to this launch.** Vite is started with `--strictPort`, so an
 * incumbent server makes it exit — while that incumbent goes on answering `200`. Without this the
 * runner would see a healthy probe, print a URL, and hand someone a page served by a process it
 * does not own and cannot stop. Checked *before* anything is bound, so a refusal leaves nothing
 * behind.
 */
export function assertPortFree(port, host = "127.0.0.1") {
  return new Promise((free, fail) => {
    const probe = createServer();
    probe.once("error", (error) =>
      fail(
        error.code === "EADDRINUSE"
          ? new Error(
              `port ${String(port)} is already in use, so the app cannot start there. Stop ` +
                `whatever is listening on it and run the command again.`,
            )
          : error,
      ),
    );
    probe.listen(port, host, () => {
      probe.close(() => {
        free();
      });
    });
  });
}

const reachable = (url) =>
  fetch(url)
    .then((response) => response.ok)
    .catch(() => false);

/**
 * @param {object} [deps] injected so the orchestration is testable without building or spawning.
 */
export async function startDemo(deps = {}) {
  const {
    run = runToCompletion,
    serve = serveArchives,
    spawnApp = () =>
      spawn(
        "npx",
        [
          "vite",
          "--config",
          "apps/demo/vite.config.ts",
          "--port",
          String(APP_PORT),
          "--strictPort",
        ],
        { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"], shell: false },
      ),
    ready = waitForApp,
    probe = () => reachable(`http://127.0.0.1:${String(APP_PORT)}/`),
    archivePresent = (name) => existsSync(`${ROOT}${ARCHIVE_DIR}/${name}`),
    checkAppPort = assertPortFree,
    out = (text) => process.stdout.write(text),
  } = deps;

  /**
   * **Built every run, not only when `dist` is missing.**
   *
   * Vite resolves every `@mapatlas` import to a package's built `dist`, which `npm install` does
   * not create and git does not track — so a fresh clone has none of it and the demo would fail on
   * an unresolvable import. Rebuilding only when absent is no better: a `dist` left by an older
   * checkout demonstrates yesterday's source while looking entirely current. `tsc --build` is
   * incremental, so the cost of always running it is a second on an unchanged tree.
   */
  await run("npm", ["run", "build"]);

  const missing = Object.values(ARCHIVES).filter((name) => !archivePresent(name));
  if (missing.length > 0) {
    // Cut once, not fetched at run time: the build reads a pinned upstream and writes local
    // archives. It needs the network and takes about a minute, so say so rather than appear hung.
    out(
      `\nCutting the demo's map archives — this needs the network once, and takes about a minute.\n` +
        `Missing: ${missing.join(", ")}\n\n`,
    );
    await run("node", ["scripts/fixture/build-fixture.mjs"]);
  }

  // Before anything is bound, so a refusal leaves no port held and no child running.
  await checkAppPort(APP_PORT);

  const archives = await serve({ dir: `${ROOT}${ARCHIVE_DIR}`, port: ARCHIVE_PORT });
  const app = spawnApp();

  try {
    await ready(app, probe);
  } catch (error) {
    // **Both are released.** A failed start that left the archive port bound would make the very
    // next attempt fail for a different reason, and the message would blame the wrong thing.
    app.kill("SIGTERM");
    archives.close();
    throw error;
  }

  out(
    `\n  MAP-ATLAS demo\n\n  Open:  ${demoUrl()}\n\n` +
      `  Record a trip, tap the map to drop an event, attach a photo, stop to review, export GeoJSON.\n` +
      `  Ctrl-C stops both servers.\n\n`,
  );
  return { app, archives };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const started = await startDemo().catch((error) => {
    // One line, not a stack: whoever ran `npm run demo` wants to know what to do next.
    process.stderr.write(
      `\n  Could not start the demo: ${error instanceof Error ? error.message : String(error)}\n\n`,
    );
    process.exitCode = 1;
    return undefined;
  });
  if (started !== undefined) {
    const stop = () => {
      started.app.kill("SIGTERM");
      started.archives.close();
      process.exit(0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    started.app.on("exit", (code) => {
      started.archives.close();
      process.exit(code ?? 0);
    });
  }
}
