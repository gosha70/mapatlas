// SPDX-License-Identifier: Apache-2.0

/**
 * A static file server with **HTTP range support**, for serving the demo's cut archives.
 *
 * **Range support is the whole reason this exists.** PMTiles is read by range request: the client
 * fetches a header, learns where a tile lives, and asks for those bytes. A server that ignores
 * `Range` and answers `200` with the whole file is **refused** by the pinned reader — `pmtiles`
 * 4.5.0 checks the response's content-length against what it asked for and throws *"Server
 * returned no content-length header or content-length exceeding request. Check that your storage
 * backend supports HTTP Byte Serving."* So the failure is loud rather than silent; what it is
 * not is *actionable* by someone who was told to "just serve the folder", which is exactly what
 * `python3 -m http.server` does.
 *
 * Deliberately tiny and dependency-free: it serves one directory read-only over loopback for a
 * demo, and nothing here should be mistaken for a production file server.
 */

import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { isAbsolute, join, normalize, resolve, sep } from "node:path";

/** What a request resolved to, or why it did not. */
export function resolveRequest(dir, url) {
  const root = resolve(dir);
  const raw = (url ?? "/").split("?")[0] ?? "/";
  let decoded;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return { kind: "bad-request" };
  }
  // **Contained, and checked after resolving.** `..` segments and absolute paths are both refused
  // by comparing the resolved path against the root — checking the *requested* string instead
  // would be defeated by encodings that only become traversal once decoded.
  const relative = normalize(decoded).replace(/^[/\\]+/, "");
  if (relative === "" || isAbsolute(relative)) return { kind: "not-found" };
  const path = resolve(join(root, relative));
  if (path !== root && !path.startsWith(root + sep)) return { kind: "forbidden" };
  let size;
  try {
    const stats = statSync(path);
    if (!stats.isFile()) return { kind: "not-found" };
    size = stats.size;
  } catch {
    return { kind: "not-found" };
  }
  return { kind: "file", path, size };
}

/**
 * The byte interval a `Range` header asks for, clamped to the representation.
 *
 * Returns `null` for no range (serve the whole file) and `"unsatisfiable"` for a range that
 * starts past the end — which has its own status, because answering `200` there would hand the
 * client the whole file when it asked for a window that does not exist.
 */
export function rangeOf(header, size) {
  if (header === undefined) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) return null;
  const [, from, to] = match;
  if (from === "" && to === "") return null;
  // A suffix range, `bytes=-500`: the last 500 bytes.
  if (from === "") {
    const length = Math.min(Number(to), size);
    return length === 0 ? "unsatisfiable" : { start: size - length, end: size - 1 };
  }
  const start = Number(from);
  // The end is clamped to the representation first, so a start past it produces `end < start`
  // and falls out below. An explicit `start >= size` guard here was unreachable — a guard
  // nothing can reach is a claim nobody can check.
  const end = to === "" ? size - 1 : Math.min(Number(to), size - 1);
  return end < start ? "unsatisfiable" : { start, end };
}

/** Serve `dir` on `port`, read-only, with range support. */
export function serveArchives({ dir, port, host = "127.0.0.1" }) {
  const server = createServer((request, response) => {
    const found = resolveRequest(dir, request.url);
    if (found.kind !== "file") {
      const status = found.kind === "forbidden" ? 403 : found.kind === "bad-request" ? 400 : 404;
      response.writeHead(status).end();
      return;
    }
    // The demo's page and its archives are on different ports, so the browser treats archive
    // reads as cross-origin. Loopback, read-only, and for a demo — hence `*`.
    const headers = { "Access-Control-Allow-Origin": "*", "Accept-Ranges": "bytes" };
    const wanted = rangeOf(request.headers.range, found.size);
    if (wanted === "unsatisfiable") {
      response
        .writeHead(416, { ...headers, "Content-Range": `bytes */${String(found.size)}` })
        .end();
      return;
    }
    if (wanted === null) {
      response.writeHead(200, { ...headers, "Content-Length": found.size });
      createReadStream(found.path).pipe(response);
      return;
    }
    response.writeHead(206, {
      ...headers,
      "Content-Range": `bytes ${String(wanted.start)}-${String(wanted.end)}/${String(found.size)}`,
      "Content-Length": wanted.end - wanted.start + 1,
    });
    createReadStream(found.path, { start: wanted.start, end: wanted.end }).pipe(response);
  });
  return new Promise((ready, fail) => {
    // **A port already in use is a message, not a stack trace.** Without this the `error` event
    // is unhandled and node prints an EADDRINUSE dump — which tells someone running one command
    // to see a demo nothing they can act on.
    server.once("error", (error) => {
      fail(
        error.code === "EADDRINUSE"
          ? new Error(
              `port ${String(port)} is already in use, so the archives cannot be served. ` +
                `Stop whatever is listening on it and run the command again.`,
            )
          : error,
      );
    });
    server.listen(port, host, () => {
      ready(server);
    });
  });
}
