// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { rangeOf, resolveRequest, serveArchives } from "./serve-archives.mjs";

/**
 * The two decisions this server makes, tested without a socket.
 *
 * **Range handling is the reason it exists.** A server that ignores `Range` answers 200 with the
 * whole file, and the pinned `pmtiles` 4.5.0 refuses it — it compares content-length against the
 * request and throws about HTTP Byte Serving. So the demo fails loudly rather than silently; the
 * cases below are about it not failing at all.
 */

describe("rangeOf", () => {
  it("passes through a request with no range, so the whole file is served", () => {
    expect(rangeOf(undefined, 1000)).toBeNull();
  });

  it("reads a normal interval", () => {
    expect(rangeOf("bytes=0-15", 1000)).toStrictEqual({ start: 0, end: 15 });
  });

  it("clamps an interval that reaches past the end", () => {
    // Legitimate: a reader asking for a 16 KB window over a smaller object. Refusing it would
    // fail on the last window of every archive.
    expect(rangeOf("bytes=990-2000", 1000)).toStrictEqual({ start: 990, end: 999 });
  });

  it("serves to the end when no end is given", () => {
    expect(rangeOf("bytes=990-", 1000)).toStrictEqual({ start: 990, end: 999 });
  });

  it("reads a suffix range", () => {
    expect(rangeOf("bytes=-16", 1000)).toStrictEqual({ start: 984, end: 999 });
  });

  it("refuses a range starting past the end rather than serving the whole file", () => {
    // **The dangerous fallback.** Treating this as "no range" answers 200 with the entire
    // archive — the client asked for a window that does not exist and would be handed 1.5 MB.
    expect(rangeOf("bytes=5000-", 1000)).toBe("unsatisfiable");
  });

  it("refuses a reversed interval", () => {
    expect(rangeOf("bytes=500-100", 1000)).toBe("unsatisfiable");
  });

  it("ignores a header it cannot parse, rather than guessing at one", () => {
    // Multi-range and unit-less forms are not supported; serving the whole file is the honest
    // answer, and a reader that needed a window will ask again with one this understands.
    expect(rangeOf("bytes=0-10,20-30", 1000)).toBeNull();
    expect(rangeOf("items=0-10", 1000)).toBeNull();
  });
});

describe("resolveRequest", () => {
  const dir = "build/fixture";

  it("refuses to escape the served directory", () => {
    // Checked after resolving, so an encoding that only becomes traversal once decoded is caught
    // too — checking the requested string would not be.
    for (const attempt of ["/../package.json", "/%2e%2e/package.json", "/a/../../package.json"]) {
      expect(resolveRequest(dir, attempt).kind, attempt).not.toBe("file");
    }
  });

  it("refuses traversal that carries no leading slash", () => {
    // **The case that reaches the containment check.** A path beginning with `/` is normalised
    // to the root before the strip, so `/../x` becomes `x` and simply is not found — the
    // containment branch never runs. Without the leading slash, `a/../../x` survives
    // normalisation as `../x` and only containment refuses it. Testing solely the first shape
    // left that branch unexercised, which a mutation removing it proved.
    expect(resolveRequest(dir, "a/../../package.json").kind).toBe("forbidden");
    expect(resolveRequest(dir, "../package.json").kind).toBe("forbidden");
  });

  it("refuses an absolute path", () => {
    expect(resolveRequest(dir, "//etc/passwd").kind).not.toBe("file");
  });

  it("refuses a directory, rather than trying to serve one", () => {
    expect(resolveRequest(".", "/scripts").kind).toBe("not-found");
  });

  it("reports a bad encoding as a bad request", () => {
    expect(resolveRequest(dir, "/%E0%A4%A").kind).toBe("bad-request");
  });

  it("finds a file that is there, and reports its size", () => {
    const found = resolveRequest(".", "/package.json");

    expect(found.kind).toBe("file");
    expect(found.size).toBeGreaterThan(0);
  });

  it("ignores a query string", () => {
    expect(resolveRequest(".", "/package.json?cache=1").kind).toBe("file");
  });
});

/**
 * The server itself, over a real socket.
 *
 * **The parsers above are not the server.** Everything before this stops at two pure functions,
 * and a handler that ignored the interval they returned, answered the wrong status, sliced the
 * wrong bytes or dropped `Content-Range` would pass every one of them. So these open a port,
 * make requests, and read what came back.
 */
describe("serveArchives, over a socket", () => {
  const body = Buffer.from("0123456789abcdefghijklmnopqrstuvwxyz");
  let dir;
  let server;
  let origin;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "mapatlas-serve-"));
    writeFileSync(join(dir, "a.bin"), body);
    // Port 0: the OS picks a free one, so the suite cannot collide with a running demo.
    server = await serveArchives({ dir, port: 0 });
    origin = `http://127.0.0.1:${String(server.address().port)}`;
  });

  afterAll(() => {
    server?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("serves the whole file when nothing asked for a range", async () => {
    const response = await fetch(`${origin}/a.bin`);

    expect(response.status).toBe(200);
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(Buffer.from(await response.arrayBuffer())).toStrictEqual(body);
  });

  it("serves exactly the requested bytes, with the range it served", async () => {
    // The slice is compared byte for byte: a handler off by one, or one that returned the right
    // count from the wrong offset, is the failure that decodes as valid data in the wrong place.
    const response = await fetch(`${origin}/a.bin`, { headers: { Range: "bytes=10-19" } });

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(`bytes 10-19/${String(body.length)}`);
    expect(response.headers.get("content-length")).toBe("10");
    // **The browser requirement, which node's fetch does not enforce.** The app is served from
    // 5175 and reads archives from 5176, so every archive read is cross-origin. Deleting this
    // header breaks the demo in a browser and changes nothing about the assertions above.
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(Buffer.from(await response.arrayBuffer())).toStrictEqual(body.subarray(10, 20));
  });

  it("clamps a range reaching past the end rather than failing it", async () => {
    const response = await fetch(`${origin}/a.bin`, { headers: { Range: "bytes=30-999" } });

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(
      `bytes 30-${String(body.length - 1)}/${String(body.length)}`,
    );
    expect(Buffer.from(await response.arrayBuffer())).toStrictEqual(body.subarray(30));
  });

  it("refuses a range past the end with 416, not the whole file", async () => {
    // **The dangerous fallback.** Answering 200 here hands the client an entire archive it never
    // asked for, and the pinned reader rejects it for exceeding the request.
    const response = await fetch(`${origin}/a.bin`, { headers: { Range: "bytes=500-" } });

    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe(`bytes */${String(body.length)}`);
  });

  it("answers 404 for a file that is not there and 403 for one outside the directory", async () => {
    expect((await fetch(`${origin}/nope.bin`)).status).toBe(404);
    expect((await fetch(`${origin}/a/../../package.json`)).status).toBe(404);
  });

  it("reports an occupied port in words someone can act on", async () => {
    // Without this the `error` event is unhandled and node prints an EADDRINUSE dump — which
    // tells someone running one command to see a demo nothing they can do about it.
    const port = server.address().port;

    await expect(serveArchives({ dir, port })).rejects.toThrow(
      /port \d+ is already in use.*run the command again/s,
    );
  });
});
