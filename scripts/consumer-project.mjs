// SPDX-License-Identifier: Apache-2.0

/**
 * A project that resolves MAP-ATLAS the way a consumer's does: from packed tarballs, with no
 * workspace underneath it.
 *
 * Two gates need one, for different questions. `check:packaging` asks whether the published
 * dependency graph is the one this repository declares, and now also whether the getting-started
 * example **compiles** against it. The browser lane asks whether that same example **runs**. They
 * cannot be one gate — `check:packaging` runs in a job with no Chromium and deletes its scratch
 * project when it is done — so the project they each build is described here once instead of
 * twice.
 *
 * **Nothing here may reach a workspace alias.** No `paths` entry, no project reference, no vite
 * alias: an example that only compiles inside this repository proves that the example works
 * *here*, which is exactly what nobody is asking. That is the same reason `check:packaging`
 * packs tarballs rather than reading `package.json` in place.
 */

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * Packed together because these are workspace versions no registry can serve.
 *
 * The **whole publish graph** of anything installed below, not just the packages an example
 * names: `@mapatlas/react` depends on `@mapatlas/recorder-web`, so omitting it would leave the
 * install trying to fetch `0.0.0` from npm and failing for a reason that has nothing to do with
 * what the gate is asking.
 */
export const PACKAGES = [
  "packages/core",
  "packages/recorder-web",
  "packages/maplibre",
  "packages/react",
  "packages/storage-idb",
];

/**
 * One version and no range.
 *
 * Shared with `check:packaging`'s renderer-peer check rather than written twice: both ask the same
 * question — *does this name one release?* — and two copies of a version regexp are two chances
 * for one of them to be loosened alone.
 */
export const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** The getting-started example, relative to the repository root. */
export const EXAMPLE = "examples/quick-start";

/**
 * What a consumer project installs for itself, beyond the engine.
 *
 * `react` and `react-dom` are the application's; `typescript` and the two `@types` packages are
 * what compiling the example needs; `vite` is what building and serving it needs. **One list for
 * both lanes**, so the project `check:packaging` compiles and the project the browser lane runs
 * are the same project — two lists would let the two lanes drift into proving things about
 * different dependency graphs.
 *
 * **`maplibre-gl` is deliberately absent.** It is a peer dependency of `@mapatlas/maplibre`, and
 * letting the peer mechanism place it is what makes `check:packaging`'s "installed at the
 * consumer root, so it really is a peer" assertion mean something. Declaring it here would
 * satisfy that check trivially.
 */
export const CONSUMER_DEPENDENCIES = [
  "react",
  "react-dom",
  "typescript",
  "@types/react",
  "@types/react-dom",
  "vite",
];

/** What is copied into a consumer project. A generated manifest is not among them — see below. */
export const EXAMPLE_FILES = ["index.html", "tsconfig.json", "src"];

/**
 * A command whose own diagnosis survives.
 *
 * `execFileSync` throws `Command failed: …` and a script stack, which says nothing about *why*:
 * a registry timeout, an auth failure, a cache permission error and a corrupt tarball all look
 * identical. The tool already explained itself on stderr, so the failure carries that
 * explanation rather than replacing it with a stack.
 */
export class CommandFailed extends Error {
  constructor(command, args, cwd, cause) {
    super(`\`${[command, ...args].join(" ")}\` failed in ${cwd}`);
    this.name = "CommandFailed";
    this.status = typeof cause.status === "number" ? cause.status : null;
    // A spawn that never reached the tool — a missing cwd, npm not on PATH — reports here and
    // nowhere else, since there is no tool output to relay.
    this.code = typeof cause.code === "string" ? cause.code : null;
    this.stdout = typeof cause.stdout === "string" ? cause.stdout : "";
    this.stderr = typeof cause.stderr === "string" ? cause.stderr : "";
  }

  report() {
    const exit = this.status === null ? "" : ` (exit ${String(this.status)})`;
    const sections = [`${this.message}${exit}`];
    if (this.code !== null) sections.push(`  the command itself could not run: ${this.code}`);
    // stderr first: npm puts the actionable line there, and it is what a reader needs.
    if (this.stderr.trim() !== "") sections.push(`\n--- stderr ---\n${this.stderr.trimEnd()}`);
    if (this.stdout.trim() !== "") sections.push(`\n--- stdout ---\n${this.stdout.trimEnd()}`);
    return sections.join("\n");
  }
}

/**
 * `--loglevel=error` rather than `--silent`: stdout stays clean enough to read a tarball
 * filename off, while anything that actually goes wrong still reaches stderr, where the failure
 * path above can relay it.
 */
export function run(command, args, cwd) {
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

export function manifest(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * The versions this repository actually runs, for the third-party packages a consumer project
 * has to install itself.
 *
 * **Read, never written down here.** A version repeated into this file is a version that can
 * disagree with the one every other gate exercises, and the disagreement would be invisible: the
 * example would compile and run against a React or a TypeScript nothing else here has seen.
 *
 * An absent name throws rather than defaulting to a range, and **so does a range**. `npm install
 * react` resolves whatever the registry offers today; so does `^19.2.8`, on the day 19.3 ships.
 * Either would leave the consumer project running a release nothing else here has exercised while
 * this function, the gate and ADR-0041 all went on calling the versions pinned — which is worse
 * than an unpinned dependency, because it reads as checked.
 *
 * The check is on the selector this repository declares, not on what npm resolved: a lockfile can
 * be regenerated, and the manifest is the statement of intent.
 *
 * @param {Record<string, Record<string, string>>} root the root `package.json`
 * @param {string[]} names
 */
export function pinnedVersions(root, names) {
  const pinned = {};
  for (const name of names) {
    const version = root.devDependencies?.[name] ?? root.dependencies?.[name];
    if (version === undefined) {
      throw new Error(
        `the root package.json does not pin "${name}", so a consumer project cannot install ` +
          `the version this repository runs`,
      );
    }
    if (!EXACT_VERSION.test(version)) {
      throw new Error(
        `the root package.json declares "${name}" as "${version}", which is a range — a consumer ` +
          `project built from it can install a release this repository has never run`,
      );
    }
    pinned[name] = version;
  }
  return pinned;
}

/**
 * The consumer project's own manifest.
 *
 * **Generated rather than shipped beside the example.** A checked-in `package.json` would name
 * `@mapatlas/*` at versions no registry can serve — the workspace versions are `0.0.0` — so an
 * install from it would either fail or, worse, resolve something else. The engine packages
 * arrive as tarballs instead, and everything a consumer really would install is pinned from the
 * root manifest above.
 *
 * Everything lands in `dependencies`: the project is private, never published, and thrown away
 * when the gate finishes, so a dev/production split here would describe nothing.
 */
export function consumerManifest(root, names) {
  return {
    name: "mapatlas-consumer",
    private: true,
    version: "0.0.0",
    type: "module",
    dependencies: pinnedVersions(root, names),
  };
}

/** Pack every workspace package into `into`, and return the tarball paths. */
export function packWorkspacePackages(into) {
  return PACKAGES.map((directory) => {
    const output = run(
      "npm",
      ["pack", "--loglevel=error", "--pack-destination", into],
      join(ROOT, directory),
    );
    return join(into, output.trim().split("\n").at(-1));
  });
}

/** Copy the example's real files — the same bytes the document shows — into a project. */
export function copyExample(into) {
  for (const entry of EXAMPLE_FILES) {
    cpSync(join(ROOT, EXAMPLE, entry), join(into, entry), { recursive: true });
  }
}

/**
 * Build a consumer project at `into`: the manifest, the packed engine, and the example.
 *
 * `--install-strategy=nested` because that is the layout a consumer's resolver may impose.
 * Under npm's hoisting any import resolves whether or not the package declared it; under
 * nesting — and under pnpm and Yarn PnP, which nesting approximates — only a declared dependency
 * or a peer does.
 *
 * @param {{ into: string, dependencies: string[] }} options
 */
export function createConsumerProject({ into, dependencies }) {
  mkdirSync(into, { recursive: true });
  writeFileSync(
    join(into, "package.json"),
    `${JSON.stringify(consumerManifest(manifest(join(ROOT, "package.json")), dependencies), null, 2)}\n`,
  );
  const tarballs = packWorkspacePackages(into);
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
    into,
  );
  copyExample(into);
  return { tarballs };
}
