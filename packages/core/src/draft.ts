// SPDX-License-Identifier: Apache-2.0

import { finalizeTrack } from "./finalize.js";
import type { FinalizePolicy } from "./finalize.js";
import { haversineDistanceMeters } from "./geo.js";
import type { Id } from "./ids.js";
import { newId } from "./ids.js";
import type { JSONValue } from "./json.js";
import type { ChannelDescriptor } from "./channels.js";
import type { DraftTrackPoint, Track, TrackLap, TrackPoint, TrackSegment } from "./track.js";

/**
 * Manual track authoring: place vertices, time them afterwards, and finalize into a track
 * indistinguishable from a recorded one. (ADR-0014)
 */

/** `toTrack()` was called while some vertex still had no timestamp. */
export class TrackDraftIncompleteError extends Error {
  readonly untimedIndices: number[];

  constructor(untimedIndices: number[]) {
    super(
      `cannot finalize a draft with untimed points: ${untimedIndices.join(", ")}. ` +
        "Call interpolateTimes or setTimeAt first.",
    );
    this.name = "TrackDraftIncompleteError";
    this.untimedIndices = untimedIndices;
  }
}

export interface InterpolateTimesOptions {
  startedAt: number;
  endedAt?: number;
  speedMps?: number;
}

export interface TrackDraft {
  readonly points: DraftTrackPoint[];
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  /** Indices still lacking a timestamp. `toTrack()` refuses while this is non-empty. */
  readonly untimedIndices: number[];

  append(p: DraftTrackPoint): void;
  insertAt(index: number, p: DraftTrackPoint): void;
  moveAt(index: number, to: { lat: number; lng: number }): void;
  removeAt(index: number): void;
  setTimeAt(index: number, t: number): void;
  interpolateTimes(o: InterpolateTimesOptions): void;
  /** Split the draft so `index` begins a new segment — the authored equivalent of a pause. */
  breakAt(index: number): void;

  undo(): void;
  redo(): void;
  onChange(cb: (points: DraftTrackPoint[]) => void): () => void;

  toTrack(
    meta?: { id?: Id; tags?: string[]; meta?: Record<string, JSONValue> },
    policy?: Partial<FinalizePolicy>,
  ): Track;
}

/**
 * The complete mutable state, snapshotted as a whole.
 *
 * `breaks` holds the index that **begins** each segment after the first, so a draft of
 * points 0..5 with `breaks: [3]` yields segments 0..2 and 3..5. The break vertex belongs to
 * the *later* segment and is never duplicated — duplicating it would produce overlapping
 * ranges, which the coverage invariant rejects outright.
 */
interface DraftState {
  points: DraftTrackPoint[];
  breaks: number[];
  /** Carried from a seeded track and shifted by edits, since laps index the point array. */
  laps: TrackLap[];
}

/**
 * Metadata a draft carries from the track it was seeded from.
 *
 * Held outside {@link DraftState} because no edit changes it: there is nothing to snapshot
 * and nothing to undo. `toTrack()` merges it with anything the caller passes, so an
 * unedited round trip preserves identity and consumer data rather than quietly minting a
 * new track that has lost its tags.
 *
 * Segment *ids* are deliberately not preserved. A draft's segments are defined by its
 * breaks, and an edit can merge or split them, so carrying the old ids would attach stale
 * identity to spans that no longer correspond to anything.
 */
interface SeededMeta {
  id?: Id;
  tags?: string[];
  meta?: Record<string, JSONValue>;
  channels?: ChannelDescriptor[];
}

/**
 * Undo keeps whole snapshots rather than a command log.
 *
 * Correctness matters more here than memory: `interpolateTimes` rewrites hundreds of
 * timestamps and `breakAt`, `insertAt` and `removeAt` all shift segment boundaries, so
 * inverse commands would be intricate exactly where undo/redo has to be right. An authored
 * route is tens to hundreds of vertices — the five-thousand-point fixtures are *recorded* —
 * and this bound caps the worst case regardless.
 *
 * Private on purpose. It is implementation policy, and nothing suggests a consumer needs to
 * configure it; the snapshots can later become structural sharing without any public change.
 */
const HISTORY_LIMIT = 100;

/** `channels` is a nested object, so spreading the point alone would share it with history. */
function cloneDraftPoint(p: DraftTrackPoint): DraftTrackPoint {
  return p.channels === undefined ? { ...p } : { ...p, channels: { ...p.channels } };
}

function cloneState(state: DraftState): DraftState {
  return {
    points: state.points.map(cloneDraftPoint),
    breaks: [...state.breaks],
    laps: state.laps.map((lap) => ({
      ...lap,
      ...(lap.stats === undefined ? {} : { stats: { ...lap.stats } }),
    })),
  };
}

/**
 * Shift lap ranges through an insertion or removal, dropping any that no longer describe a
 * span, and renumbering what survives so `index` stays a contiguous 0-based order.
 */
function shiftLaps(laps: TrackLap[], pointCount: number): TrackLap[] {
  return laps
    .filter(
      (lap) => lap.endIndex >= lap.startIndex && lap.startIndex >= 0 && lap.endIndex < pointCount,
    )
    .map((lap, index) => ({ ...lap, index }));
}

function assertIndex(index: number, length: number, what: string): void {
  if (!Number.isInteger(index) || index < 0 || index >= length) {
    throw new RangeError(`${what}: index ${index} is outside points[0, ${length - 1}]`);
  }
}

function assertPosition(p: { lat: number; lng: number }): void {
  if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) {
    throw new RangeError(`position must be finite: ${JSON.stringify(p)}`);
  }
  if (p.lat < -90 || p.lat > 90 || p.lng < -180 || p.lng > 180) {
    throw new RangeError(`position is out of range: ${JSON.stringify(p)}`);
  }
}

function assertTimestamp(t: number, what: string): void {
  if (!Number.isInteger(t) || t < 0) {
    throw new RangeError(`${what}: ${t} is not an epoch-millisecond timestamp`);
  }
}

/**
 * Every route a point takes into the draft, validated the same way.
 *
 * A timestamp supplied with the point must clear the same bar `setTimeAt` enforces.
 * Otherwise `{ t: NaN }` counts as timed, escapes `untimedIndices`, and finalizes into a
 * track whose `durationMs` is NaN — corrupt statistics from a value nothing rejected.
 */
function assertDraftPoint(p: DraftTrackPoint, what: string): void {
  assertPosition(p);
  if (p.t !== undefined) assertTimestamp(p.t, `${what}: timestamp`);
  for (const [key, value] of Object.entries(p.channels ?? {})) {
    if (!Number.isFinite(value)) {
      throw new RangeError(`${what}: channel "${key}" is not a finite number`);
    }
  }
}

/** Segment boundaries implied by the breaks: `[start, endExclusive]` pairs. */
function segmentRanges(state: DraftState): [number, number][] {
  if (state.points.length === 0) return [];
  const boundaries = [0, ...state.breaks, state.points.length];
  const ranges: [number, number][] = [];
  for (let i = 0; i < boundaries.length - 1; i += 1) {
    const start = boundaries[i];
    const end = boundaries[i + 1];
    if (start === undefined || end === undefined || end <= start) continue;
    ranges.push([start, end]);
  }
  return ranges;
}

export function createTrackDraft(from?: Track): TrackDraft {
  const initial: DraftState = { points: [], breaks: [], laps: [] };
  const seeded: SeededMeta = {};

  if (from !== undefined) {
    initial.points = from.points.map(cloneDraftPoint);
    // Every segment after the first begins at a break.
    initial.breaks = from.segments.slice(1).map((segment) => segment.startIndex);
    initial.laps = (from.laps ?? []).map((lap) => ({ ...lap }));

    if (from.id !== undefined) seeded.id = from.id;
    if (from.tags !== undefined) seeded.tags = [...from.tags];
    if (from.meta !== undefined) seeded.meta = structuredClone(from.meta);
    if (from.channels !== undefined) seeded.channels = from.channels.map((c) => ({ ...c }));
  }

  let current = initial;
  const undoStack: DraftState[] = [];
  const redoStack: DraftState[] = [];
  const listeners = new Set<(points: DraftTrackPoint[]) => void>();

  const snapshot = (): DraftTrackPoint[] => current.points.map(cloneDraftPoint);

  const notify = (): void => {
    const points = snapshot();
    for (const listener of listeners) listener(points.map(cloneDraftPoint));
  };

  /**
   * The one path every mutation takes. The caller validates and builds the next state
   * first, so a rejected operation throws before this is reached: history is untouched,
   * redo survives, and no listener fires. One public edit, one undo step — including
   * `interpolateTimes`, which rewrites many timestamps but is a single user action.
   */
  const commit = (next: DraftState): void => {
    undoStack.push(cloneState(current));
    if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
    redoStack.length = 0;
    current = next;
    notify();
  };

  const untimed = (): number[] => {
    const indices: number[] = [];
    for (const [i, point] of current.points.entries()) {
      if (point.t === undefined) indices.push(i);
    }
    return indices;
  };

  return {
    get points() {
      return snapshot();
    },
    get canUndo() {
      return undoStack.length > 0;
    },
    get canRedo() {
      return redoStack.length > 0;
    },
    get untimedIndices() {
      return untimed();
    },

    append: (p) => {
      assertDraftPoint(p, "append");
      const next = cloneState(current);
      next.points.push(cloneDraftPoint(p));
      commit(next);
    },

    insertAt: (index, p) => {
      assertDraftPoint(p, "insertAt");
      if (!Number.isInteger(index) || index < 0 || index > current.points.length) {
        throw new RangeError(`insertAt: index ${index} is outside [0, ${current.points.length}]`);
      }
      const next = cloneState(current);
      next.points.splice(index, 0, cloneDraftPoint(p));
      // A vertex inserted *at* a boundary lands before it, so it joins the earlier segment.
      next.breaks = next.breaks.map((b) => (b >= index ? b + 1 : b));
      next.laps = shiftLaps(
        next.laps.map((lap) => ({
          ...lap,
          startIndex: lap.startIndex >= index ? lap.startIndex + 1 : lap.startIndex,
          endIndex: lap.endIndex >= index ? lap.endIndex + 1 : lap.endIndex,
        })),
        next.points.length,
      );
      commit(next);
    },

    moveAt: (index, to) => {
      assertIndex(index, current.points.length, "moveAt");
      assertPosition(to);
      const next = cloneState(current);
      const point = next.points[index];
      if (point === undefined) throw new RangeError(`moveAt: no point at ${index}`);
      point.lat = to.lat;
      point.lng = to.lng;
      commit(next);
    },

    removeAt: (index) => {
      assertIndex(index, current.points.length, "removeAt");
      const next = cloneState(current);
      next.points.splice(index, 1);
      // Boundaries after the removal shift down; one left dangling at either end of the
      // shortened array no longer separates anything and is dropped.
      next.breaks = next.breaks
        .map((b) => (b > index ? b - 1 : b))
        .filter((b) => b > 0 && b < next.points.length);
      next.laps = shiftLaps(
        next.laps.map((lap) => ({
          ...lap,
          startIndex: lap.startIndex > index ? lap.startIndex - 1 : lap.startIndex,
          endIndex: lap.endIndex >= index ? lap.endIndex - 1 : lap.endIndex,
        })),
        next.points.length,
      );
      commit(next);
    },

    setTimeAt: (index, t) => {
      assertIndex(index, current.points.length, "setTimeAt");
      assertTimestamp(t, "setTimeAt");
      const next = cloneState(current);
      const point = next.points[index];
      if (point === undefined) throw new RangeError(`setTimeAt: no point at ${index}`);
      point.t = t;
      commit(next);
    },

    breakAt: (index) => {
      if (!Number.isInteger(index) || index <= 0 || index >= current.points.length) {
        throw new RangeError(
          `breakAt: ${index} cannot begin a segment; it must be within [1, ${current.points.length - 1}]`,
        );
      }
      if (current.breaks.includes(index)) {
        throw new RangeError(`breakAt: ${index} already begins a segment`);
      }
      const next = cloneState(current);
      next.breaks = [...next.breaks, index].sort((a, b) => a - b);
      commit(next);
    },

    interpolateTimes: (options) => {
      const next = interpolate(current, options);
      commit(next);
    },

    undo: () => {
      const previous = undoStack.pop();
      if (previous === undefined) return; // no-op, and no event
      redoStack.push(cloneState(current));
      current = previous;
      notify();
    },

    redo: () => {
      const next = redoStack.pop();
      if (next === undefined) return;
      undoStack.push(cloneState(current));
      current = next;
      notify();
    },

    onChange: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },

    toTrack: (meta, policy) => {
      // A projection, not an edit: no snapshot, no redo clearing, no listener, and the
      // draft is exactly as it was afterwards.
      const missing = untimed();
      if (missing.length > 0) throw new TrackDraftIncompleteError(missing);

      const points: TrackPoint[] = current.points.map((p) => {
        if (p.t === undefined) throw new TrackDraftIncompleteError(untimed());
        // Deep clone: a spread would hand the finalized track the draft's own `channels`
        // object, so mutating the track would edit the draft with no undo entry and no
        // listener — a change nobody asked for and nobody could see.
        const { t, ...rest } = cloneDraftPoint(p);
        void t;
        return { ...rest, t: p.t };
      });

      const segments: TrackSegment[] = segmentRanges(current).map(([start, end]) => {
        const first = points[start];
        const last = points[end - 1];
        return {
          id: newId(),
          startIndex: start,
          endIndex: end - 1,
          startedAt: first?.t ?? 0,
          ...(last === undefined ? {} : { endedAt: last.t }),
        };
      });

      // The same finalize a recorder runs, so an authored track and a recorded one differ
      // in exactly one enum field. Temporal and structural faults surface from there.
      // Seeded metadata first, then whatever the caller passed — so an unedited round trip
      // preserves identity, tags, meta and channel descriptors, while an explicit argument
      // still wins. Losing the descriptors would also silently drop every channel statistic
      // while leaving orphaned values on the points.
      const id = meta?.id ?? seeded.id;
      const tags = meta?.tags ?? seeded.tags;
      const consumerMeta = meta?.meta ?? seeded.meta;
      const laps = shiftLaps([...current.laps], points.length);

      return finalizeTrack(
        {
          points,
          segments,
          origin: "authored",
          ...(id === undefined ? {} : { id }),
          ...(tags === undefined ? {} : { tags: [...tags] }),
          ...(consumerMeta === undefined ? {} : { meta: structuredClone(consumerMeta) }),
          ...(seeded.channels === undefined
            ? {}
            : { channels: seeded.channels.map((c) => ({ ...c })) }),
          ...(laps.length === 0 ? {} : { laps }),
        },
        policy,
      );
    },
  };
}

/**
 * Fill the timestamps a draft is missing, preserving those it already has.
 *
 * Anchors — points with an explicit `t` — are never moved. Between two anchors the gap is
 * distributed **by distance**, so a vertex placed halfway along in space lands halfway
 * through in time; distributing by index instead would make a long straight leg take the
 * same time as a short one.
 *
 * Distance here uses the spherical approximation deliberately: this is a cheap geometric
 * decision about how to apportion time, not a recorded distance. (ADR-0019)
 *
 * Pure — it returns the next state rather than mutating, so a rejected call cannot leave a
 * draft half-timed.
 */
function interpolate(state: DraftState, options: InterpolateTimesOptions): DraftState {
  const { startedAt, endedAt, speedMps } = options;

  if (!Number.isInteger(startedAt) || startedAt < 0) {
    throw new RangeError(`interpolateTimes: startedAt ${startedAt} is not an epoch timestamp`);
  }
  if (endedAt !== undefined && (!Number.isInteger(endedAt) || endedAt < startedAt)) {
    throw new RangeError(`interpolateTimes: endedAt ${endedAt} is not after startedAt`);
  }
  if (speedMps !== undefined && (!Number.isFinite(speedMps) || speedMps <= 0)) {
    throw new RangeError(`interpolateTimes: speedMps ${speedMps} must be positive`);
  }

  const next = cloneState(state);
  const points = next.points;
  if (points.length === 0) return next;

  const first = points[0];
  if (first !== undefined && first.t === undefined) first.t = startedAt;

  const last = points[points.length - 1];
  if (endedAt !== undefined && last !== undefined && last.t === undefined) last.t = endedAt;

  /**
   * A pause has a duration only the author knows.
   *
   * Interpolation apportions time by distance travelled, but the leg from the last point of
   * one segment to the first of the next was never travelled — the recording was stopped.
   * Left in the cumulative distance it would absorb the elapsed time in proportion to how
   * far the author happened to relocate, so a lunch break across town would swallow the
   * whole afternoon. There is no way to infer how long a pause lasted, so rather than
   * inventing a number this requires the points on either side of every break to be
   * anchored, and then interpolates strictly within each segment.
   */
  for (const boundary of next.breaks) {
    const before = points[boundary - 1];
    const after = points[boundary];
    if (before?.t === undefined || after?.t === undefined) {
      throw new RangeError(
        `interpolateTimes: the pause at points[${boundary}] has no duration to infer. ` +
          `Set a time on points[${boundary - 1}] and points[${boundary}] first — only you ` +
          "know how long the recording was stopped.",
      );
    }
  }

  const anchors = points
    .map((p, index) => ({ index, t: p.t }))
    .filter((a): a is { index: number; t: number } => a.t !== undefined);

  for (let i = 1; i < anchors.length; i += 1) {
    const previous = anchors[i - 1];
    const anchor = anchors[i];
    if (previous === undefined || anchor === undefined) continue;
    if (anchor.t < previous.t) {
      throw new RangeError(
        `interpolateTimes: anchored timestamps run backwards at points[${anchor.index}]`,
      );
    }
  }

  // Distance accumulates within a segment only. The break-crossing leg contributes nothing,
  // which is correct: it was not travelled. Both of its endpoints are anchored by the check
  // above, so no interpolated span ever straddles a boundary in any case.
  const breaks = new Set(next.breaks);
  const cumulative: number[] = [0];
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    const step =
      breaks.has(i) || a === undefined || b === undefined ? 0 : haversineDistanceMeters(a, b);
    cumulative.push((cumulative[i - 1] ?? 0) + step);
  }

  for (let i = 0; i < anchors.length - 1; i += 1) {
    const from = anchors[i];
    const to = anchors[i + 1];
    if (from === undefined || to === undefined) continue;

    const spanDistance = (cumulative[to.index] ?? 0) - (cumulative[from.index] ?? 0);
    const spanMs = to.t - from.t;

    for (let j = from.index + 1; j < to.index; j += 1) {
      const point = points[j];
      if (point === undefined || point.t !== undefined) continue;
      const travelled = (cumulative[j] ?? 0) - (cumulative[from.index] ?? 0);
      const fraction =
        spanDistance === 0 ? (j - from.index) / (to.index - from.index) : travelled / spanDistance;
      point.t = Math.round(from.t + fraction * spanMs);
    }
  }

  // Anything after the final anchor needs a rate to extend by.
  const lastAnchor = anchors[anchors.length - 1];
  if (lastAnchor !== undefined && lastAnchor.index < points.length - 1) {
    if (speedMps === undefined) {
      throw new RangeError(
        "interpolateTimes: points remain after the last anchored time; supply endedAt or speedMps",
      );
    }
    for (let i = lastAnchor.index + 1; i < points.length; i += 1) {
      const point = points[i];
      if (point === undefined || point.t !== undefined) continue;
      const travelled = (cumulative[i] ?? 0) - (cumulative[lastAnchor.index] ?? 0);
      point.t = Math.round(lastAnchor.t + (travelled / speedMps) * 1000);
    }
  }

  return next;
}
