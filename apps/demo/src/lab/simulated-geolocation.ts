// SPDX-License-Identifier: Apache-2.0

/**
 * Simulated GPS for `/lab` (T4.6).
 *
 * **It replaces `navigator.geolocation`, not part of the engine.** `@mapatlas/recorder-web`
 * injects its environment internally and deliberately keeps it off the public contract — a
 * geolocation watch is implementation machinery, and naming it in the API would mean owning its
 * shape forever. So the demo simulates the *browser*, and the recorder is used exactly as any
 * consumer uses it: `createWebTrackRecorder()`, no test seam, no injected clock.
 *
 * That is also what makes this honest as a demo feature rather than a test fixture: a device
 * with no GPS gets the same behaviour a device with one would.
 */

import type { Track } from "@mapatlas/core";

/**
 * The sampling `/lab` records under, and why it is not the default.
 *
 * The shipped policy keeps a fix only after 10 m of movement — sensible for a real walk, and
 * wrong for replaying a track that *is already the kept set*. The fixture's points are 2.8 m
 * apart, so the default retained 5 of the first 20 emitted, and the resulting point count would
 * describe the policy rather than the fixture. Zero distance keeps every fix; accuracy and
 * interval stay at values a real recording would use, since nothing here is testing those.
 */
export const LAB_SAMPLING = Object.freeze({
  minDistanceM: 0,
  maxIntervalMs: 15_000,
  maxAccuracyM: 50,
});

/** The subset of `Geolocation` the recorder uses. */
export interface GeolocationLike {
  watchPosition(
    onFix: (position: GeolocationPosition) => void,
    onFailure?: ((error: GeolocationPositionError) => void) | null,
    options?: PositionOptions,
  ): number;
  clearWatch(id: number): void;
  getCurrentPosition(
    onFix: (position: GeolocationPosition) => void,
    onFailure?: ((error: GeolocationPositionError) => void) | null,
    options?: PositionOptions,
  ): void;
}

export interface ReplayControls {
  /** The geolocation object to install in place of the browser's. */
  readonly geolocation: GeolocationLike;
  /** Emit the next fix. Returns false once the track is exhausted. */
  advance(): boolean;
  /** Fixes emitted so far. */
  readonly emitted: number;
  /** Index of the last point of the first segment — where the caller pauses the recorder. */
  readonly pauseAfter: number;
  /** Total fixes the track will emit. */
  readonly total: number;
}

/**
 * Replay a finalized track as a sequence of geolocation fixes.
 *
 * **Times are shifted so the track starts now, and the geometry is untouched.** The recorder
 * takes each point's own `t` for the point it keeps, but opens a segment at
 * `environment.now()` — so replaying a three-hour track instantly would produce segments whose
 * start comes from the wall clock and points whose times come from 2026, making `durationMs`
 * meaningless and possibly negative. Shifting the epoch keeps every coordinate identical, which
 * is what the fixture's determinism is about, and leaves the timeline self-consistent.
 *
 * **Driven, not timed.** `advance()` is called by the caller rather than a `setInterval`, so a
 * scenario replays 5,400 fixes as fast as the browser can take them instead of over three hours,
 * and so nothing depends on a timer firing on schedule under load.
 *
 * **The epoch is anchored when the first watch registers, not when the replay is built.** The
 * recorder stamps its own `startedAt` from a private clock inside `start()`, and any delay
 * between constructing a replay and the recorder subscribing shifted the fixes *earlier* than
 * that stamp — a 25 ms gap put the first recorded fix 27 ms before `startedAt`, and a long one
 * would make `durationMs` negative. Anchoring at subscription makes the first fix land at or
 * after the moment the recorder started, which is the invariant that has to hold.
 *
 * @param track A finalized track — its first segment's end is where the pause belongs.
 * @param now Reads the clock. Injectable so a unit test can pin the epoch; the default is real.
 */
export function createReplayGeolocation(
  track: Track,
  now: () => number = () => Date.now(),
): ReplayControls {
  const [firstSegment] = track.segments;
  if (firstSegment === undefined) {
    throw new Error("a replay needs a track with at least one segment");
  }

  /** Set on first subscription, so it cannot precede the recorder's own start. */
  let offset: number | undefined;
  const watchers = new Map<number, (position: GeolocationPosition) => void>();
  let nextWatchId = 1;
  let index = 0;

  /**
   * A position at `at`, stamped with a caller-supplied time.
   *
   * **It does not touch the offset.** An earlier version memoised the anchor here, on the
   * reasoning that this is where timestamps are produced — which quietly made
   * `getCurrentPosition` anchor the whole timeline. A current-position call, a 25 ms delay and
   * then `start()` put the first recorded fix 27 ms before the recorder's `startedAt`: exactly
   * the defect the lazy anchor was introduced to remove, reintroduced by moving it here.
   *
   * The two call paths want different things, which is why one anchor cannot serve both: a watch
   * establishes a timeline, a one-off reading does not.
   */
  const positionAt = (at: number, timestamp: number): GeolocationPosition => {
    const point = track.points[at];
    if (point === undefined) throw new Error(`no point at index ${String(at)}`);
    return {
      coords: {
        latitude: point.lat,
        longitude: point.lng,
        accuracy: point.accuracyM ?? 5,
        altitude: point.altitudeM ?? null,
        altitudeAccuracy: point.altitudeAccuracyM ?? null,
        speed: point.speedMps ?? null,
        heading: point.headingDeg ?? null,
        toJSON() {
          return this;
        },
      },
      timestamp,
      toJSON() {
        return this;
      },
    } as GeolocationPosition;
  };

  return {
    geolocation: {
      watchPosition(onFix) {
        // **The timeline is anchored here, on the point that will be delivered next.** Not on
        // `track.startedAt`: fixes advanced before anyone subscribed are discarded history, and
        // anchoring on the track's own start would place the first *delivered* fix as far in the
        // past as those discarded ones were. Anchoring on `points[index]` puts it at `now()`
        // however many were thrown away.
        offset ??= now() - (track.points[index]?.t ?? track.startedAt);
        const id = nextWatchId++;
        watchers.set(id, onFix);
        return id;
      },
      clearWatch(id) {
        // **Only the watch asked for.** Clearing every watcher regardless of id is not what the
        // browser does, and it would hide a recorder that cleared the wrong one — the failure
        // would look like a clean stop instead of a leak.
        watchers.delete(id);
      },
      getCurrentPosition(onFix) {
        const at = Math.min(index, track.points.length - 1);
        // Before a watch exists there is no timeline to belong to, so this reads the clock once
        // and commits nothing. Afterwards it uses the established offset, so a current-position
        // call during a recording sits on the same timeline as the fixes around it.
        const point = track.points[at];
        onFix(positionAt(at, offset === undefined ? now() : (point?.t ?? 0) + offset));
      },
    },
    advance() {
      if (index >= track.points.length) return false;
      const point = track.points[index];
      // An advance with nobody watching delivers to nobody and must not anchor anything: it is
      // discarded history, and letting it fix the epoch would date the timeline from a fix the
      // recorder never saw.
      const position = positionAt(index, offset === undefined ? now() : (point?.t ?? 0) + offset);
      index += 1;
      for (const watcher of watchers.values()) watcher(position);
      return true;
    },
    get emitted() {
      return index;
    },
    pauseAfter: firstSegment.endIndex,
    total: track.points.length,
  };
}
