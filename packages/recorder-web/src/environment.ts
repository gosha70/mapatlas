// SPDX-License-Identifier: Apache-2.0

/**
 * Everything the recorder needs from the browser, in one injectable place.
 *
 * Deliberately **not** part of the public factory's options: a scheduler, a geolocation
 * watch and a wake lock are implementation machinery, and putting them in `api.md` would
 * mean owning their shapes indefinitely for the benefit of nobody who consumes the engine.
 * The internal factory takes one of these; the exported one supplies the real browser.
 *
 * `now` belongs here alongside the rest. Without it a test could drive the fixes and the
 * autosave deterministically while timestamps still came from the wall clock, which is the
 * half that makes assertions unreadable.
 */

/** A structural subset of `GeolocationPosition`, so a real one satisfies it. */
export interface PositionFix {
  coords: {
    latitude: number;
    longitude: number;
    accuracy?: number | null;
    altitude?: number | null;
    altitudeAccuracy?: number | null;
    speed?: number | null;
    heading?: number | null;
  };
  timestamp: number;
}

/** A structural subset of `GeolocationPositionError`. */
export interface PositionFailure {
  code: number;
  message?: string;
}

/**
 * A held wake lock. Releasing is async and may reject — a lock the browser already dropped
 * on visibility change is the ordinary case, not an error worth surfacing.
 */
export interface WakeLockLease {
  release(): Promise<void>;
}

export interface WebRecorderEnvironment {
  now(): number;
  watchPosition(
    onFix: (fix: PositionFix) => void,
    onFailure: (failure: PositionFailure) => void,
  ): number;
  clearWatch(watchId: number): void;
  /** Resolves `undefined` where wake locks are unsupported — an absence, not a failure. */
  requestWakeLock(): Promise<WakeLockLease | undefined>;
  setInterval(callback: () => void, intervalMs: number): unknown;
  clearInterval(handle: unknown): void;
}

/** Geolocation error codes, per the W3C spec. */
export const POSITION_ERROR = {
  permissionDenied: 1,
  positionUnavailable: 2,
  timeout: 3,
} as const;

/**
 * The real browser.
 *
 * `enableHighAccuracy` is on because a field track is the case that needs GPS rather than
 * a coarse network fix; the sampling policy is what keeps the resulting density in check.
 */
export function createBrowserEnvironment(): WebRecorderEnvironment {
  return {
    now: () => Date.now(),

    watchPosition: (onFix, onFailure) =>
      navigator.geolocation.watchPosition(onFix, onFailure, {
        enableHighAccuracy: true,
        maximumAge: 0,
        timeout: 30_000,
      }),

    clearWatch: (watchId) => {
      navigator.geolocation.clearWatch(watchId);
    },

    requestWakeLock: async () => {
      // Unsupported on desktop Firefox and in insecure contexts. A recording without a
      // wake lock still works; the screen just sleeps.
      const wakeLock = (navigator as Navigator & { wakeLock?: WakeLockSentinel_ }).wakeLock;
      if (wakeLock === undefined) return undefined;
      try {
        const sentinel = await wakeLock.request("screen");
        return { release: () => sentinel.release() };
      } catch {
        // Denied, or the document was not visible. Not worth failing a recording over.
        return undefined;
      }
    },

    setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
    clearInterval: (handle) => {
      clearInterval(handle as ReturnType<typeof setInterval>);
    },
  };
}

/** The slice of the Screen Wake Lock API used above, declared to avoid a lib dependency. */
interface WakeLockSentinel_ {
  request(type: "screen"): Promise<{ release(): Promise<void> }>;
}
