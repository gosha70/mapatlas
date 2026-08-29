// SPDX-License-Identifier: Apache-2.0

/**
 * Does the published artifact actually work for a consumer?
 *
 * Every other gate runs inside this workspace, where npm hoists every dependency to one
 * `node_modules` and any import resolves whether or not the package declared it. That is the
 * one environment a consumer never has. This packs the real tarballs, installs them into a
 * scratch project with **`--install-strategy=nested`** so nothing is hoisted, and asks the
 * questions a consumer's resolver would ask.
 *
 * Nested is the point. Under hoisting, a transitive `maplibre-gl` sits at the application's
 * root and `maplibre-gl/dist/maplibre-gl.css` resolves by luck; under nesting it sits inside
 * `@mapatlas/maplibre` and does not — which is what pnpm and Yarn PnP do by design. Only a
 * peer dependency puts it where the application can reach it.
 */

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

/** Packed together because `@mapatlas/core` is a workspace version no registry can serve. */
const PACKAGES = ["packages/core", "packages/maplibre"];

/** What a consumer must be able to reach from their own project root. */
const CONSUMER_IMPORTS = ["@mapatlas/maplibre", "maplibre-gl/dist/maplibre-gl.css"];

/**
 * Renderer peers that must be pinned exactly, and the package whose devDependency says to
 * what. T0.1 admits no ranges for renderer dependencies, and the reason is not tidiness: the
 * browser lane exercises one version, so a range lets a consumer's fresh install resolve a
 * release nothing here has ever run. Checked against the *packed* manifest, because that is
 * the file a consumer's resolver reads.
 */
const EXACT_PEERS = [{ package: "@mapatlas/maplibre", peer: "maplibre-gl" }];

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function manifest(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** The three maps a lockfile records per workspace package, and must keep in step. */
const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "peerDependencies"];

/**
 * Does the lockfile still say what the manifests say?
 *
 * `npm ci` does **not** answer this. It validates that the resolution graph can be satisfied,
 * and a peer range is not part of that graph — so editing a manifest and forgetting to
 * reinstall leaves a lockfile contradicting the package it locks, and every gate stays green.
 * Verified rather than assumed: reverting the lockfile's peer to `^6.6.0` passes `npm ci`.
 *
 * Cheap and offline, so it runs before anything is packed: a lockfile that disagrees with the
 * manifests makes every result after it a statement about the wrong dependency graph.
 */
function lockfileDrift() {
  const lock = manifest(join(root, "package-lock.json"));
  const drift = [];

  for (const [location, locked] of Object.entries(lock.packages ?? {})) {
    if (!location.startsWith("packages/") && !location.startsWith("apps/")) continue;
    const declared = manifest(join(root, location, "package.json"));

    for (const field of DEPENDENCY_FIELDS) {
      const inLock = JSON.stringify(locked[field] ?? {});
      const inManifest = JSON.stringify(declared[field] ?? {});
      if (inLock !== inManifest) {
        drift.push(
          `package-lock.json records ${location} ${field} as ${inLock}, ` +
            `but its package.json declares ${inManifest} — run \`npm install\``,
        );
      }
    }
  }
  return drift;
}

/**
 * A command whose own diagnosis survives.
 *
 * `execFileSync` throws `Command failed: …` and a script stack, which says nothing about
 * *why*: a registry timeout, an auth failure, a cache permission error and a corrupt tarball
 * all look identical. The tool already explained itself on stderr, so the failure carries
 * that explanation rather than replacing it with a stack.
 */
class CommandFailed extends Error {
  constructor(command, args, cwd, cause) {
    super(`\`${[command, ...args].join(" ")}\` failed in ${cwd}`);
    this.name = "CommandFailed";
    this.status = typeof cause.status === "number" ? cause.status : null;
    // A spawn that never reached npm — a missing cwd, npm not on PATH — reports here and
    // nowhere else, since there is no tool output to relay.
    this.code = typeof cause.code === "string" ? cause.code : null;
    this.stdout = typeof cause.stdout === "string" ? cause.stdout : "";
    this.stderr = typeof cause.stderr === "string" ? cause.stderr : "";
  }

  report() {
    const exit = this.status === null ? "" : ` (exit ${String(this.status)})`;
    const sections = [`check:packaging — ${this.message}${exit}`];
    if (this.code !== null) sections.push(`  the command itself could not run: ${this.code}`);
    // stderr first: npm puts the actionable line there, and it is what a reader needs.
    if (this.stderr.trim() !== "") sections.push(`\n--- npm stderr ---\n${this.stderr.trimEnd()}`);
    if (this.stdout.trim() !== "") sections.push(`\n--- npm stdout ---\n${this.stdout.trimEnd()}`);
    return sections.join("\n");
  }
}

/**
 * `--loglevel=error` rather than `--silent`: stdout stays clean enough to read a tarball
 * filename off, while anything that actually goes wrong still reaches stderr, where the
 * failure path above can relay it.
 */
function run(command, args, cwd) {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw new CommandFailed(command, args, cwd, error ?? {});
  }
}

/** One voice for every failure, whether it stopped the run early or at the end. */
function report(failures) {
  console.error(
    "check:packaging — the dependency graph this repository would publish is not the one it declares:\n",
  );
  for (const failure of failures) console.error(`  ${failure}`);
  console.error(
    "\nConsumers resolve against exactly this; packages/maplibre/README.md says what they are told to import.",
  );
}

// Before anything is created, and fatal on its own. Everything below describes a dependency
// graph, so a lockfile disagreeing with the manifests makes every result after it a statement
// about the wrong one — and the work after it reaches the registry, where a failing gate would
// otherwise sit through npm's retry backoff to reach a conclusion it already has.
//
// Deliberately *before* the scratch directory exists: `process.exit` skips a pending `finally`,
// so exiting from inside the cleanup scope below would leave a temporary directory behind on
// every failure.
const drift = lockfileDrift();
if (drift.length > 0) {
  report(drift);
  process.exit(1);
}

const scratch = mkdtempSync(join(tmpdir(), "mapatlas-packaging-"));
const failures = [];

try {
  const tarballs = PACKAGES.map((directory) => {
    const output = run(
      "npm",
      ["pack", "--loglevel=error", "--pack-destination", scratch],
      join(root, directory),
    );
    return join(scratch, output.trim().split("\n").at(-1));
  });

  writeFileSync(
    join(scratch, "package.json"),
    `${JSON.stringify({ name: "consumer", private: true, version: "0.0.0", type: "module" }, null, 2)}\n`,
  );

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
    scratch,
  );

  const require = createRequire(join(scratch, "consumer.js"));
  for (const specifier of CONSUMER_IMPORTS) {
    try {
      require.resolve(specifier);
    } catch (error) {
      failures.push(
        `cannot resolve "${specifier}" — ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
      );
    }
  }

  // A renderer peer must name one version, and the same one this repository tests against.
  // Without this the whole gate passes on a `^` edit, which is exactly how the range got in.
  for (const { package: name, peer } of EXACT_PEERS) {
    const packed = manifest(join(scratch, "node_modules", name, "package.json"));
    const declared = packed.peerDependencies?.[peer];
    const tested = manifest(join(root, "packages/maplibre/package.json")).devDependencies?.[peer];

    if (declared === undefined) {
      failures.push(`${name} no longer declares "${peer}" as a peer dependency`);
    } else if (!EXACT_VERSION.test(declared)) {
      failures.push(
        `${name} pins "${peer}" as "${declared}" — renderer peers take an exact version, ` +
          `since the browser lane exercises exactly one (specs/tasks.md T0.1)`,
      );
    } else if (declared !== tested) {
      failures.push(
        `${name} pins "${peer}" at "${declared}" but this repository tests "${tested}" — ` +
          `a consumer would install a version nothing here has run`,
      );
    }
  }

  // The README ships, so the package has something to say on npm.
  if (!existsSync(join(scratch, "node_modules/@mapatlas/maplibre/README.md"))) {
    failures.push("the packed package carries no README.md");
  }

  // And the peer really is a peer: installed at the consumer's root, not nested inside us.
  if (!existsSync(join(scratch, "node_modules/maplibre-gl/package.json"))) {
    failures.push("maplibre-gl is not installed at the consumer root — it is not a peer");
  }
} catch (error) {
  // A gate that cannot say why it failed is a gate nobody trusts. npm's own diagnosis is
  // relayed verbatim rather than summarised into `Command failed`.
  console.error(
    error instanceof CommandFailed ? error.report() : `check:packaging — ${String(error)}`,
  );
  process.exitCode = 1;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

if (process.exitCode === 1) process.exit(1);

if (failures.length > 0) {
  report(failures);
  process.exit(1);
}

console.log(
  `check:packaging — clean (${CONSUMER_IMPORTS.length} consumer imports, ` +
    `${EXACT_PEERS.length} pinned peer, nested resolution)`,
);
