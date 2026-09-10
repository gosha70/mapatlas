// SPDX-License-Identifier: Apache-2.0
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CONSUMER_DEPENDENCIES,
  EXAMPLE,
  EXAMPLE_FILES,
  PACKAGES,
  ROOT,
  consumerManifest,
  pinnedVersions,
} from "./consumer-project.mjs";

const root = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

describe("pinnedVersions", () => {
  it("takes the version this repository runs rather than a range", () => {
    expect(pinnedVersions({ devDependencies: { react: "19.2.8" } }, ["react"])).toStrictEqual({
      react: "19.2.8",
    });
  });

  it("falls back to dependencies, since either field is a pin", () => {
    expect(pinnedVersions({ dependencies: { vite: "8.2.2" } }, ["vite"])).toStrictEqual({
      vite: "8.2.2",
    });
  });

  /**
   * The failure that matters: an unpinned name would otherwise resolve to whatever the registry
   * offers today, and the example would be compiled and run against a version nothing else in
   * this repository has seen — invisibly, because the install would succeed.
   */
  it("refuses a name the root manifest does not pin", () => {
    expect(() => pinnedVersions({ devDependencies: {} }, ["react"])).toThrow(
      /does not pin "react"/,
    );
  });

  /**
   * **A range is the worse half of the same failure**, because it reads as checked. `^19.2.8`
   * installs 19.3 the day it ships, into a project nothing else here builds, while this
   * function, the gate and ADR-0041 all go on calling the version pinned.
   */
  it.each(["^19.2.8", "~19.2.8", ">=19", "19.x", "latest", "*"])(
    "refuses %s, which names more than one release",
    (range) => {
      expect(() => pinnedVersions({ devDependencies: { react: range } }, ["react"])).toThrow(
        /is a range/,
      );
    },
  );

  it("accepts a prerelease, which still names exactly one release", () => {
    expect(pinnedVersions({ devDependencies: { vite: "8.2.2-beta.1" } }, ["vite"])).toStrictEqual({
      vite: "8.2.2-beta.1",
    });
  });
});

describe("consumerManifest", () => {
  it("is private and unpublishable, and names only what a consumer installs itself", () => {
    const manifest = consumerManifest({ devDependencies: { react: "19.2.8" } }, ["react"]);
    expect(manifest.private).toBe(true);
    expect(manifest.type).toBe("module");
    expect(manifest.dependencies).toStrictEqual({ react: "19.2.8" });
  });

  /**
   * **`maplibre-gl` must not appear.** It reaches a consumer project through
   * `@mapatlas/maplibre`'s peer dependency, and `check:packaging` asserts it lands at the
   * project root as proof that the peer declaration is real. Declaring it here would satisfy
   * that assertion trivially and the gate would stop being able to fail.
   */
  it("never declares the renderer peer", () => {
    expect(CONSUMER_DEPENDENCIES).not.toContain("maplibre-gl");
  });
});

describe("the consumer project this repository builds", () => {
  it("pins every third-party dependency the example needs", () => {
    expect(() => pinnedVersions(root, CONSUMER_DEPENDENCIES)).not.toThrow();
  });

  /**
   * The whole publish graph, not just the packages the example imports: `@mapatlas/react`
   * depends on `@mapatlas/recorder-web`, and omitting one would leave the install trying to
   * fetch `0.0.0` from a registry that has never heard of it.
   */
  it("packs every workspace package the example's imports can reach", () => {
    const reachable = new Set();
    const visit = (directory) => {
      if (reachable.has(directory)) return;
      reachable.add(directory);
      const manifest = JSON.parse(readFileSync(join(ROOT, directory, "package.json"), "utf8"));
      for (const name of Object.keys(manifest.dependencies ?? {})) {
        if (!name.startsWith("@mapatlas/")) continue;
        visit(`packages/${name.slice("@mapatlas/".length)}`);
      }
    };
    for (const directory of PACKAGES) visit(directory);
    expect([...reachable].sort()).toStrictEqual([...PACKAGES].sort());
  });

  /**
   * And the list is held to the example rather than only to itself: an example that imported a
   * package nobody packs would fail deep inside an npm install, as a `0.0.0` the registry has
   * never heard of, rather than here with the specifier named.
   */
  it("packs every @mapatlas package the example imports", () => {
    const sources = readdirSync(join(ROOT, EXAMPLE, "src"))
      .filter((name) => name.endsWith(".ts") || name.endsWith(".tsx"))
      .map((name) => readFileSync(join(ROOT, EXAMPLE, "src", name), "utf8"));
    const imported = new Set(
      sources.flatMap((source) =>
        [...source.matchAll(/from "(@mapatlas\/[^"]+)"/g)].map((m) => m[1]),
      ),
    );
    expect(imported.size).toBeGreaterThan(0);
    const packed = new Set(
      PACKAGES.map((directory) => `@mapatlas/${directory.slice("packages/".length)}`),
    );
    expect([...imported].filter((name) => !packed.has(name))).toStrictEqual([]);
  });

  it("copies no manifest into the project, because the manifest is generated", () => {
    expect(EXAMPLE_FILES).not.toContain("package.json");
  });
});
