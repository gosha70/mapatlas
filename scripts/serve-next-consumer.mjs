// SPDX-License-Identifier: Apache-2.0

/**
 * Builds the Next 14 / React 18 consumer **from packed tarballs**, then serves it (ADR-0043).
 *
 * The quick-start lane proves the engine where this repository develops it: React 19, Vite. The
 * first real consumer lives somewhere else — Next 14's App Router, webpack, server rendering, and
 * React 18 — and `@mapatlas/react` declares `react: ">=18"`. Until this lane, nothing ran the
 * bindings on 18, so the range was a claim. This makes it a tested one, in a browser.
 *
 * **The versions are the fixture's, not the root manifest's, and that is the point.** The quick
 * start reads every third-party version from the root `package.json` so its project cannot drift
 * from what the repository runs. This project must differ — React 18, Next 14 — so it reads them
 * from `examples/next14-react18/versions.json`, held to the same rule: one exact version each,
 * no ranges, or the lane would test whatever the registry offered that day.
 *
 * **Commit-pinned.** The engine is installed from tarballs packed from this checkout's `dist`, and
 * the build directory records the commit, whether the tree was dirty, and each tarball's SHA-256 —
 * so a result from this lane names the exact engine it ran.
 *
 * Rebuilt from empty every run, and never reused by Playwright, for the quick start's reason: a
 * leftover project would serve an older engine while reporting the current one.
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildBasemapArchive } from "../e2e/fixtures/build-lab-archives.mjs";

import { EXACT_VERSION, ROOT, packWorkspacePackages, run } from "./consumer-project.mjs";

const PORT = Number(process.env["NEXT_CONSUMER_PORT"] ?? 5179);
const FIXTURE = join(ROOT, "examples/next14-react18");
const FIXTURE_FILES = ["app", "next.config.mjs", "tsconfig.json"];
const project = fileURLToPath(new URL("../build/next14-react18", import.meta.url));

/** No telemetry from the consumer's framework either (SECURITY.md: no egress nobody configured). */
const ENV = { ...process.env, NEXT_TELEMETRY_DISABLED: "1" };

const versions = JSON.parse(readFileSync(join(FIXTURE, "versions.json"), "utf8"));
for (const [name, version] of Object.entries(versions)) {
  if (!EXACT_VERSION.test(version)) {
    throw new Error(
      `examples/next14-react18/versions.json declares "${name}" as "${version}", which is a ` +
        `range — the lane would run a release nobody chose`,
    );
  }
}

rmSync(project, { recursive: true, force: true });
mkdirSync(project, { recursive: true });
writeFileSync(
  join(project, "package.json"),
  `${JSON.stringify({ name: "mapatlas-next-consumer", private: true, version: "0.0.0", dependencies: versions }, null, 2)}\n`,
);

const tarballs = packWorkspacePackages(project);
// Nested, as the quick start installs: only a declared dependency or a peer resolves.
run(
  "npm",
  [
    "install",
    "--install-strategy=nested",
    "--no-audit",
    "--no-fund",
    "--loglevel=error",
    ...tarballs,
  ],
  project,
);

const commit = run("git", ["rev-parse", "HEAD"], ROOT).trim();
const dirty = run("git", ["status", "--porcelain", "--", "packages"], ROOT).trim() !== "";
const pin = {
  commit,
  // Packed from a tree with uncommitted package changes: the result is not reproducible from the
  // commit alone, and saying so is the difference between a pin and a label.
  packagesDirty: dirty,
  tarballs: Object.fromEntries(
    tarballs.map((path) => [
      basename(path),
      createHash("sha256").update(readFileSync(path)).digest("hex"),
    ]),
  ),
};
writeFileSync(join(project, "ENGINE_PIN.json"), `${JSON.stringify(pin, null, 2)}\n`);

for (const entry of FIXTURE_FILES) {
  cpSync(join(FIXTURE, entry), join(project, entry), { recursive: true });
}

const region = JSON.parse(readFileSync(join(ROOT, "fixtures/vertical/region.json"), "utf8"));
const publicDir = join(project, "public");
mkdirSync(publicDir, { recursive: true });

/**
 * **The consumer's own step, done here the way a webpack-based app has to do it.** MapLibre resolves
 * its worker relative to its own module URL, which a bundler rewrites; under Next 14's webpack the
 * worker is created from the page URL, loads HTML, and no tile is ever built — a blank map with no
 * error (api.md §0, "the two lines MapLibre needs"). Vite's answer is `?worker&url`; webpack's is to
 * serve the worker from the application's own origin and pass that URL to `setWorkerUrl`. The worker
 * imports exactly one sibling, `maplibre-gl-shared.mjs`, so both are copied — from the consumer's own
 * installed `maplibre-gl`, the version the peer declaration placed.
 */
const maplibreDist = join(project, "node_modules/maplibre-gl/dist");
mkdirSync(join(publicDir, "maplibre"), { recursive: true });
for (const file of ["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"]) {
  cpSync(join(maplibreDist, file), join(publicDir, "maplibre", file));
}
await buildBasemapArchive(region, publicDir);

const next = join(project, "node_modules/next/dist/bin/next");
const build = spawnSync(process.execPath, [next, "build"], {
  cwd: project,
  env: ENV,
  encoding: "utf8",
});
if (build.status !== 0) {
  console.error(
    `next build failed (exit ${String(build.status)})\n${build.stderr}\n${build.stdout}`,
  );
  process.exit(1);
}

console.log(
  `serve-next-consumer — built ${project} with next ${versions.next}, react ${versions.react}; ` +
    `engine ${commit.slice(0, 7)}${dirty ? " (packages dirty)" : ""}`,
);

const server = spawn(process.execPath, [next, "start", "-p", String(PORT), "-H", "127.0.0.1"], {
  cwd: project,
  env: ENV,
  stdio: "inherit",
});
server.on("exit", (code) => {
  process.exit(code ?? 1);
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.kill(signal);
  });
}
