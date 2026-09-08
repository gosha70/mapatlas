// SPDX-License-Identifier: Apache-2.0

/**
 * Generate the demo's service worker **from the tree `vite build` actually emitted**.
 *
 * T7.1 increment 5c. The worker precaches the application shell so a document loaded with the
 * app's own origin unavailable still boots the real application — not a bare `index.html`, but
 * the built JavaScript, the stylesheet, and MapLibre's worker chunk.
 *
 * **The inventory is the filesystem, not a list and not the dev graph.** A hand-maintained array
 * is wrong the moment a chunk is renamed, and nothing would say so: the build succeeds, the
 * worker installs, and the failure appears only offline. Vite's `build.manifest` would be a
 * second-hand answer — it maps inputs to outputs and has to be recursed correctly to reach
 * things like the `?worker&url` chunk. The emitted directory answers "what did this build ship?"
 * directly, and it is the same tree `vite preview` serves.
 *
 * **The inventory is embedded in the worker, and the worker carries the build's digest.** Both
 * halves matter. If `sw.js` were static and fetched a precache manifest at install time, a new
 * application build could leave the worker script byte-for-byte identical — and a browser that
 * sees an unchanged worker has no reason to install anything, so the old shell would be served
 * for a build that no longer exists. Embedding the urls means a renamed chunk changes the worker;
 * hashing the emitted *bytes* into the cache name means a chunk whose contents changed under an
 * unchanged name does too.
 *
 * The output directory is read from the vite config itself rather than repeated here, so the
 * generator cannot be pointed at a directory the build did not write.
 */

import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolveConfig } from "vite";

const CONFIG_FILE = fileURLToPath(new URL("../apps/demo/vite.config.ts", import.meta.url));

/** The generated worker, named relative to the emitted tree it is written into. */
export const WORKER_FILE = "sw.js";

/** Cache names are prefixed so the worker can delete *its own* previous builds and no others. */
export const CACHE_PREFIX = "mapatlas-demo-shell-";

/**
 * Emitted files that are not part of the shell.
 *
 * `sw.js` is excluded because it is this generator's own output: including it would make the
 * digest a function of the previous run, so two consecutive generations over one build would
 * disagree. `.vite/` is build metadata (the manifest, when enabled) that the application never
 * requests.
 *
 * @param {string} relative
 */
const excluded = (relative) =>
  relative === WORKER_FILE || relative === ".vite" || relative.startsWith(".vite/");

/**
 * Every file under `dir`, as `/`-joined paths relative to it, in a stable order.
 *
 * **Sorted, and that is not cosmetic.** `readdir` order is filesystem-dependent, and the digest
 * below folds the paths in sequence — an unsorted walk would hash the same build differently on
 * a different machine, so the cache name would change without the build changing.
 *
 * @param {string} dir @param {string} prefix @returns {Promise<string[]>}
 */
async function emittedFiles(dir, prefix = "") {
  /** @type {string[]} */
  const out = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of [...entries].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (excluded(relative)) continue;
    if (entry.isDirectory()) out.push(...(await emittedFiles(join(dir, entry.name), relative)));
    else out.push(relative);
  }
  return out;
}

/**
 * The url the browser will ask for, from a path on disk.
 *
 * **Every segment is encoded, which is what makes a cross-origin url unreachable.** The segments
 * come from filenames, and `encodeURIComponent` escapes `:` and `/` — so no filename, however
 * hostile or merely odd, can widen a same-origin path into a scheme or an authority. The result
 * is always one leading slash followed by encoded segments.
 *
 * @param {string} relative
 */
export function shellUrl(relative) {
  const url = `/${relative.split("/").map(encodeURIComponent).join("/")}`;
  // Not decoration: it is the assertion that the rule above holds, checked on every path rather
  // than argued for once in a comment.
  if (!url.startsWith("/") || url.startsWith("//"))
    throw new Error(`refusing a shell url that is not same-origin: ${url}`);
  return url;
}

/**
 * Read the emitted tree and describe the shell it contains.
 *
 * @param {string} dir @returns {Promise<{ urls: string[], files: string[], build: string }>}
 */
export async function readShell(dir) {
  const files = await emittedFiles(dir);

  if (!files.includes("index.html"))
    throw new Error(`${dir} has no index.html — that is not a built application shell`);
  if (!files.some((file) => file.startsWith("assets/")))
    throw new Error(
      `${dir} emitted no assets/ — the shell would be index.html with nothing to load`,
    );

  /**
   * Path *and* bytes, in order.
   *
   * Hashing only the bytes would miss a rename; hashing only the names would miss an edit that
   * left every hashed filename intact — which is exactly what happens to `index.html` on any
   * change to the page's inline style.
   */
  const digest = createHash("sha256");
  for (const file of files) {
    digest.update(file);
    digest.update("\0");
    digest.update(await readFile(join(dir, file)));
  }

  return {
    // `/` first: a navigation to the root is requested as `/`, never as `/index.html`.
    urls: ["/", ...files.map(shellUrl)],
    files,
    build: digest.digest("hex").slice(0, 16),
  };
}

/**
 * The worker's source.
 *
 * **Precache only.** There is no `cache.put` anywhere below, no revalidation and no runtime
 * caching: what the worker serves is what it stored at install, and everything else — the map
 * archives above all — goes to the network untouched and stays outside its ownership. The map's
 * offline behaviour belongs to `MapAssetStore` and the PMTiles protocol (ADR-0035), and a worker
 * that also cached archives would make the two indistinguishable.
 *
 * @param {readonly string[]} urls @param {string} build
 */
export function workerSource(urls, build) {
  return `// SPDX-License-Identifier: Apache-2.0
// Generated by scripts/generate-service-worker.mjs from the emitted build. Do not edit.
//
// The url list and the cache name below are both functions of what the build emitted, so a
// changed application necessarily changes these bytes and the browser installs the new shell.

const CACHE = ${JSON.stringify(CACHE_PREFIX + build)};
const PREFIX = ${JSON.stringify(CACHE_PREFIX)};
const SHELL = ${JSON.stringify(urls, null, 2)};

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      // addAll is all-or-nothing: a shell missing one asset is not a shell, and failing here
      // leaves the previous worker in charge rather than installing a broken one.
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      // Only this generator's own caches, and only the older ones. The cache name carries the
      // build digest, so without this every build would leave one behind for ever.
      .then((names) =>
        Promise.all(
          names.filter((name) => name.startsWith(PREFIX) && name !== CACHE).map((name) => caches.delete(name)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  // Another origin is another party's: the map archives are served from one, and they are not
  // this worker's to answer for.
  if (url.origin !== self.location.origin) return;

  // A navigation is normalised to "/" so the demo's query string — which names the archives —
  // resolves to the cached document. Only the root: "/lab" is the fixture route and is not the
  // application shell, so it is left to the network rather than turned into an offline fallback.
  const key = request.mode === "navigate" ? (url.pathname === "/" ? "/" : undefined) : url.pathname;
  if (key === undefined || !SHELL.includes(key)) return;

  event.respondWith(
    caches
      .open(CACHE)
      .then((cache) => cache.match(key))
      .then((hit) => hit ?? fetch(request)),
  );
});
`;
}

/** @param {string} [dir] the emitted tree; defaults to what the demo's vite config builds into. */
export async function generateServiceWorker(dir) {
  const target = dir ?? (await resolveConfig({ configFile: CONFIG_FILE }, "build")).build.outDir;
  const shell = await readShell(target);
  await writeFile(join(target, WORKER_FILE), workerSource(shell.urls, shell.build));
  return { ...shell, dir: target };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const shell = await generateServiceWorker();
  process.stdout.write(
    `service worker: ${String(shell.urls.length)} shell urls, build ${shell.build}\n`,
  );
}
