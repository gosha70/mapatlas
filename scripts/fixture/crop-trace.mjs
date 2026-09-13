// SPDX-License-Identifier: Apache-2.0

/**
 * What a crop looked like at each point something observed it (T8.1, issue #30).
 *
 * **Diagnostic only.** Nothing here changes what the build computes; it records what the build
 * already had, so the next occurrence of the intermittent tiling failure says *where* the value
 * first differed instead of only that it ended up wrong.
 *
 * **Why a record rather than a re-read.** The failure's placement report shows a crop whose origin
 * belongs to one source cell and whose width and pixel payload belong to another — a combination
 * the constructing code cannot return, because it derives both from the same column index. Reading
 * the crop again at the throw cannot distinguish a value that was wrong when written from one that
 * changed afterwards: by then there is only the final state. So each observation copies the fields
 * it can see, as primitives, at the moment it sees them. A later write to `crop.west` cannot reach
 * a number already copied out.
 *
 * **What a divergence does and does not establish.** Two snapshots that disagree locate the first
 * point at which the observed value differed from the previous observation. That is a position,
 * not a mechanism: it does not distinguish a write that changed the object from a read that
 * returned something other than what the object held. Both remain open, and the report says so
 * rather than naming a cause it cannot support.
 *
 * **The crops themselves are untouched.** No freezing, no proxy, no replacement, no added
 * property: the association lives in a `WeakMap` keyed by the crop, so an instrument that changed
 * the object's shape, extensibility or identity cannot be what a future occurrence is measuring.
 */

/** @typedef {Record<string, string | number | undefined | number[]>} Snapshot */

/** Crop object → the snapshots taken of it, in the order they were taken. */
const traces = new WeakMap();

/**
 * The fields every stage can see, copied out as primitives.
 *
 * `payloadBytes` rather than the array: its length is the independent witness of the crop's real
 * dimensions, since `decodeGrid` refuses a crop whose payload does not match `width × height × 3`.
 * An origin that disagrees with a payload length is a harder fact than an origin that disagrees
 * with a printed width.
 *
 * @param {Record<string, unknown>} crop
 * @returns {Snapshot}
 */
function liveFields(crop) {
  const rgb = crop.rgb;
  return {
    width: /** @type {number} */ (crop.width),
    height: /** @type {number} */ (crop.height),
    west: /** @type {number} */ (crop.west),
    north: /** @type {number} */ (crop.north),
    pixelScaleDeg: /** @type {number} */ (crop.pixelScaleDeg),
    payloadBytes:
      rgb === undefined || rgb === null
        ? undefined
        : /** @type {number} */ (/** @type {{ length: number }} */ (rgb).length),
  };
}

/** The live fields, in the order a report lists them, and the only ones compared across stages. */
const COMPARED = ["width", "height", "west", "north", "pixelScaleDeg", "payloadBytes"];

/**
 * Record what `crop` looks like now, under a stage name.
 *
 * Returns nothing on purpose. A function that handed back a value could be wired up as
 * `return observe(crop, …)`, and the day it returned a copy or a proxy the instrument would be
 * changing the thing it is supposed to be watching.
 *
 * @param {unknown} crop the crop object, used as an identity and never modified
 * @param {string} stage where this observation was taken
 * @param {Snapshot} [known] what the caller knows and the crop does not carry — the tile id, the
 *   bounds it was clipped to, the indices it was cut at. Copied, not held by reference.
 * @returns {void}
 */
export function observeCrop(crop, stage, known = {}) {
  if (crop === null || typeof crop !== "object") return;
  const existing = traces.get(crop);
  const trace = existing ?? [];
  if (existing === undefined) traces.set(crop, trace);
  try {
    /** @type {Snapshot} */
    const snapshot = { stage };
    for (const [key, value] of Object.entries(known)) {
      // Arrays are copied element by element: a caller's bounds array that is later reused or
      // mutated must not be able to rewrite an observation already taken.
      snapshot[key] = Array.isArray(value) ? [...value] : value;
    }
    Object.assign(snapshot, liveFields(/** @type {Record<string, unknown>} */ (crop)));
    trace.push(snapshot);
  } catch (error) {
    // **Recorded, never swallowed.** An instrument that failed silently would leave a gap in the
    // report indistinguishable from a stage that was never reached, and the reader would draw a
    // conclusion from an absence the instrument caused.
    trace.push({
      stage,
      unreadable: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * The snapshots taken of one crop, oldest first.
 *
 * @param {unknown} crop
 * @returns {Snapshot[]}
 */
export function cropTrace(crop) {
  if (crop === null || typeof crop !== "object") return [];
  return [...(traces.get(crop) ?? [])];
}

/**
 * One snapshot as a line: the stage, then what that stage knew, then what the crop held.
 *
 * @param {Snapshot} snapshot
 * @returns {string}
 */
function snapshotLine(snapshot) {
  if (snapshot.unreadable !== undefined) {
    return `      ${String(snapshot.stage)}: could not be read — ${String(snapshot.unreadable)}`;
  }
  const known = Object.entries(snapshot)
    .filter(([key]) => key !== "stage" && !COMPARED.includes(key))
    .map(
      ([key, value]) => `${key} ${Array.isArray(value) ? `[${value.join(", ")}]` : String(value)}`,
    );
  const dimensions = `${String(snapshot.width)}x${String(snapshot.height)}`;
  const origin = `origin (${String(snapshot.west)}, ${String(snapshot.north)})`;
  const payload =
    snapshot.payloadBytes === undefined
      ? "no payload"
      : `${String(snapshot.payloadBytes)} payload byte(s)`;
  return `      ${String(snapshot.stage)}: ${[...known, dimensions, origin, payload].join(", ")}`;
}

/**
 * The first pair of consecutive snapshots that disagree, and on which fields.
 *
 * `Object.is` rather than `===` for two reasons, and the first is the one `===` gets wrong in the
 * *other* direction: `NaN !== NaN`, so `===` would report a field that was `NaN` at both
 * observations as having changed — a divergence invented by the comparison rather than found in
 * the data. `Object.is` treats a stable `NaN` as unchanged, and still separates `0` from `-0`,
 * which `===` does not. A field that *became* `NaN` is a change under either.
 *
 * @param {Snapshot[]} trace
 * @returns {string | undefined}
 */
function firstDivergence(trace) {
  for (let i = 1; i < trace.length; i += 1) {
    const before = trace[i - 1];
    const after = trace[i];
    if (before.unreadable !== undefined || after.unreadable !== undefined) continue;
    const changed = COMPARED.filter((key) => !Object.is(before[key], after[key])).map(
      (key) => `${key} ${String(before[key])} -> ${String(after[key])}`,
    );
    if (changed.length === 0) continue;
    return (
      `      first divergence between "${String(before.stage)}" and "${String(after.stage)}": ` +
      changed.join("; ")
    );
  }
  return undefined;
}

/**
 * What the comparison across a crop's observations is worth, in at most two lines.
 *
 * **An observation that could not be read is a hole in the comparison, not evidence of stability.**
 * `firstDivergence` steps over any pair involving one, so a trace whose middle observation failed
 * to read could reach the end having compared nothing — and saying "no field changed between
 * observations" there would be a claim the instrument never checked, printed directly beneath the
 * line admitting it could not look. Whichever of the two is true, both cannot be.
 *
 * @param {Snapshot[]} trace
 * @returns {string[]}
 */
function comparison(trace) {
  const divergence = firstDivergence(trace);
  const unreadable = trace.filter((snapshot) => snapshot.unreadable !== undefined).length;
  const lines = divergence === undefined ? [] : [divergence];
  if (unreadable > 0) {
    lines.push(
      `      comparison unavailable across ${String(unreadable)} observation(s) that could not ` +
        `be read; the stages either side of one were never compared`,
    );
  } else if (divergence === undefined) {
    lines.push("      no field changed between observations");
  }
  return lines;
}

/**
 * What every crop looked like at every point it was observed, appended to a failure.
 *
 * Crops with no snapshots are listed as such rather than omitted: a crop constructed somewhere
 * this instrument does not reach is a real limit of the report, and a reader must not mistake a
 * missing stage for a stage that produced nothing.
 *
 * @param {unknown[]} crops in the order `stitchSurface` received them, so the indices are the
 *   ones the placement report above already used
 * @returns {string}
 */
export function traceReport(crops) {
  const blocks = crops.map((crop, index) => {
    const trace = cropTrace(crop);
    if (trace.length === 0) {
      return [`  [${String(index)}] no observations recorded; nothing on its path is instrumented`];
    }
    return [
      `  [${String(index)}] observed ${String(trace.length)} time(s):`,
      ...trace.map(snapshotLine),
      ...comparison(trace),
    ];
  });

  return [
    "",
    "",
    "what each crop held at each point it was observed (values copied when observed, so a later",
    "write cannot reach an earlier line; a divergence locates where the observed value first",
    "differed, which is a position and not a mechanism — it does not distinguish a write to the",
    "object from a read that returned something else):",
    ...blocks.flat(),
  ].join("\n");
}
