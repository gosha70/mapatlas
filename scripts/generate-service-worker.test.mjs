// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  CACHE_PREFIX,
  WORKER_FILE,
  generateServiceWorker,
  readShell,
  shellUrl,
  workerSource,
} from "./generate-service-worker.mjs";

/**
 * The generator, tested against real directories.
 *
 * These are filesystem tests on purpose: the whole claim of the design is that the precache
 * inventory is *the emitted tree*, so a fake tree is the unit under test. Nothing here runs vite —
 * the default output directory is read from the vite config only by the entry point, and every
 * function below takes the directory it should read.
 */

/** @type {string[]} */
const scratch = [];
afterEach(async () => {
  await Promise.all(scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** @param {Record<string, string>} files */
async function tree(files) {
  const dir = await mkdtemp(join(tmpdir(), "mapatlas-sw-"));
  scratch.push(dir);
  for (const [name, content] of Object.entries(files)) {
    const at = join(dir, name);
    await mkdir(join(at, ".."), { recursive: true });
    await writeFile(at, content);
  }
  return dir;
}

const built = {
  "index.html": "<!doctype html><script src=/assets/app-AAA.js></script>",
  "assets/app-AAA.js": "console.log(1)",
  "assets/style-BBB.css": "body{}",
};

describe("readShell", () => {
  it("takes the inventory from the emitted files, with the root first", async () => {
    const shell = await readShell(await tree(built));

    expect(shell.urls).toStrictEqual([
      "/",
      "/assets/app-AAA.js",
      "/assets/style-BBB.css",
      "/index.html",
    ]);
  });

  it("refuses a tree with no index.html", async () => {
    await expect(readShell(await tree({ "assets/app-AAA.js": "x" }))).rejects.toThrow(
      /not a built application shell/,
    );
  });

  it("refuses a tree that emitted nothing to load", async () => {
    // index.html alone is the shape mutation 3 produces: a document that boots into nothing.
    await expect(readShell(await tree({ "index.html": "<!doctype html>" }))).rejects.toThrow(
      /no assets/,
    );
  });

  it("changes the build digest when an asset's bytes change under the same name", async () => {
    // **The case a url list alone cannot see.** Vite's hashed names cover their own contents, but
    // `index.html` keeps its name across every edit — and so does any asset a future config emits
    // unhashed. If the digest did not fold the bytes in, such a build would produce a byte-identical
    // worker and the browser would keep serving the previous shell.
    const before = await readShell(await tree(built));
    const after = await readShell(
      await tree({ ...built, "index.html": `${built["index.html"]} ` }),
    );

    expect(after.build).not.toBe(before.build);
  });

  it("changes the build digest when a file is renamed but its bytes are not", async () => {
    const before = await readShell(await tree(built));
    const after = await readShell(
      await tree({
        "index.html": built["index.html"],
        "assets/app-ZZZ.js": built["assets/app-AAA.js"],
        "assets/style-BBB.css": built["assets/style-BBB.css"],
      }),
    );

    expect(after.build).not.toBe(before.build);
    expect(after.urls).toContain("/assets/app-ZZZ.js");
  });

  it("gives one build the same digest twice", async () => {
    // Otherwise every one of the assertions above would pass for the wrong reason.
    const dir = await tree(built);

    expect((await readShell(dir)).build).toBe((await readShell(dir)).build);
  });
});

describe("shellUrl", () => {
  it("encodes each segment, so no filename can carry structure into the url", () => {
    // A path separator is a separator here — the split happens before the encoding — so what this
    // guards is the *segment*: a filename containing `:`, `#`, a space or a `?` would otherwise
    // reach the browser as scheme, fragment or query rather than as part of a name.
    expect(shellUrl("assets/http:evil.js")).toBe("/assets/http%3Aevil.js");
    expect(shellUrl("assets/a b#c.js")).toBe("/assets/a%20b%23c.js");
    expect(shellUrl("assets/x?y.js")).toBe("/assets/x%3Fy.js");
  });

  it("refuses a path that is already absolute", () => {
    // The reachable half of the same-origin rule. Walking the tree yields relative paths, so this
    // cannot happen today; it is what stops a later caller from handing in an absolute path and
    // producing `//host/...`, which a browser reads as another origin.
    expect(() => shellUrl("/assets/app.js")).toThrow(/same-origin/);
  });

  it("keeps an ordinary emitted name readable", () => {
    expect(shellUrl("assets/index-D4GxQwRT.js")).toBe("/assets/index-D4GxQwRT.js");
  });
});

describe("workerSource", () => {
  it("carries the build digest in the cache name", () => {
    // The reason the worker is generated rather than static: an unchanged worker script gives the
    // browser no reason to install a new precache set.
    expect(workerSource(["/"], "abc123")).toContain(`"${CACHE_PREFIX}abc123"`);
  });

  it("embeds the urls rather than fetching a manifest", () => {
    expect(workerSource(["/", "/assets/app-AAA.js"], "abc123")).toContain('"/assets/app-AAA.js"');
  });

  it("never writes to a cache outside install", () => {
    // A cheap guard on the precache-only rule. The oracle that actually holds it is the browser
    // scenario, which enumerates Cache Storage *after* the map has been used — this one only
    // catches the mutation at its source.
    const source = workerSource(["/"], "abc123");

    expect(source).not.toMatch(/\.put\(/);
    expect(source.match(/addAll\(/g) ?? []).toHaveLength(1);
  });
});

describe("generateServiceWorker", () => {
  it("writes the worker into the tree and leaves it out of its own inventory", async () => {
    const dir = await tree(built);

    const first = await generateServiceWorker(dir);
    // The second run reads a directory that now contains `sw.js`. If the worker were part of the
    // inventory the digest would be a function of the previous run, and no two consecutive
    // generations of one build would agree.
    const second = await generateServiceWorker(dir);

    expect(second.build).toBe(first.build);
    expect(second.urls).not.toContain(`/${WORKER_FILE}`);
    expect(await readFile(join(dir, WORKER_FILE), "utf8")).toContain(
      `${CACHE_PREFIX}${first.build}`,
    );
  });
});
