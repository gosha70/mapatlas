// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import type {
  Id,
  MapEvent,
  OfflineRegion,
  OfflineRegionStore,
  SamplingPolicy,
  SensorSource,
  StorageAdapter,
  Track,
  TrackPoint,
  TrackRecorder,
  TrackRecorderError,
  TrackStatus,
} from "@mapatlas/core";

import * as barrel from "./index.js";

/**
 * What `@mapatlas/react` publishes, against what `api.md` §9 says it publishes.
 *
 * **Scoped to T5.1's three hooks.** §9 also publishes `useTrackList` and `useTrackDraft`, and
 * those are **T5.1b** — a separate backlog entry, not yet built. A check phrased as "the barrel
 * matches §9" would therefore either fail, or be written loosely enough to pass while implying
 * T5.1b was done. So the covered surface is named explicitly and the absent hooks are named too:
 * an absence nobody wrote down is indistinguishable from an oversight.
 */

/**
 * The published signatures, transcribed from `api.md` §9 — including the two operations
 * ADR-0026 added to `useTrackRecorder` when it settled what `recovered` lets a consumer do.
 *
 * Transcribed rather than imported, deliberately. Importing the implementation's own types would
 * make this a tautology: it would check that the code agrees with itself. These are what the
 * document promises, written out, so drift between the two fails to compile.
 */
type PublishedUseTrackRecorder = (opts?: {
  recorder?: TrackRecorder;
  store?: StorageAdapter;
  sampling?: Partial<SamplingPolicy>;
  sensors?: SensorSource[];
}) => {
  status: TrackStatus;
  livePoint?: TrackPoint;
  track?: Track;
  channels: Record<string, number>;
  start(): Promise<void>;
  pause(): void;
  resume(): void;
  markLap(label?: string): void;
  stop(): Promise<Track>;
  recovered?: Track;
  resumeRecovered(): Promise<void>;
  discardRecovered(): Promise<void>;
  error?: TrackRecorderError;
};

type PublishedUseEventLog = (
  store: StorageAdapter,
  trackId?: Id,
) => {
  events: MapEvent[];
  addEvent(input: Omit<MapEvent, "id">): Promise<MapEvent>;
  updateEvent(e: MapEvent): Promise<void>;
  deleteEvent(id: Id): Promise<void>;
};

type PublishedUseOfflineRegions = (store: OfflineRegionStore) => {
  regions: OfflineRegion[];
  download(r: Parameters<OfflineRegionStore["download"]>[0]): Promise<void>;
  remove(id: Id): Promise<void>;
};

/**
 * Compile-time conformance, **exact rather than one-way**.
 *
 * An earlier version here assigned each hook to its published type and stopped. That certifies
 * *compatibility*, not conformance: TypeScript lets a function with extra **optional** parameters
 * be assigned to a narrower function type, so `useEventLog(store, trackId?, internals?)` and
 * `useTrackRecorder({ …, environment })` both passed while the generated declarations shipped
 * those internal seams to consumers. The runtime barrel-set test could not see them either — it
 * compares export *names*, and a parameter is not a name.
 *
 * So parameters are compared as tuples and returns as shapes, in **both** directions. Mutual
 * assignability admits no extra input and no missing output.
 */
type Exactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/**
 * The same comparison over **key sets**, because structural equality does not reach an extra
 * optional member.
 *
 * Found by mutation, one level below the parameter-tuple hole: adding
 * `environment?: TrackRecorderHookEnvironment` to the public options type left the tuple
 * comparison green. `{ a?, b?, environment? }` and `{ a?, b? }` are mutually assignable — an
 * extra property is fine in one direction, and an optional one is fine in the other — so an
 * object's shape has to be compared by the names it carries, not only by assignability.
 */
type ExactKeys<A, B> = Exactly<keyof A, keyof B>;

const parametersMatch: [
  Exactly<Parameters<typeof barrel.useTrackRecorder>, Parameters<PublishedUseTrackRecorder>>,
  Exactly<Parameters<typeof barrel.useEventLog>, Parameters<PublishedUseEventLog>>,
  Exactly<Parameters<typeof barrel.useOfflineRegions>, Parameters<PublishedUseOfflineRegions>>,
] = [true, true, true];

const returnsMatch: [
  Exactly<ReturnType<typeof barrel.useTrackRecorder>, ReturnType<PublishedUseTrackRecorder>>,
  Exactly<ReturnType<typeof barrel.useEventLog>, ReturnType<PublishedUseEventLog>>,
  Exactly<ReturnType<typeof barrel.useOfflineRegions>, ReturnType<PublishedUseOfflineRegions>>,
] = [true, true, true];

/** No extra member on either side — of the one options object, and of all three returns. */
const shapesMatch: [
  ExactKeys<
    NonNullable<Parameters<typeof barrel.useTrackRecorder>[0]>,
    NonNullable<Parameters<PublishedUseTrackRecorder>[0]>
  >,
  ExactKeys<ReturnType<typeof barrel.useTrackRecorder>, ReturnType<PublishedUseTrackRecorder>>,
  ExactKeys<ReturnType<typeof barrel.useEventLog>, ReturnType<PublishedUseEventLog>>,
  ExactKeys<ReturnType<typeof barrel.useOfflineRegions>, ReturnType<PublishedUseOfflineRegions>>,
] = [true, true, true, true];

/** What the package exports today. Compared as a set, so an addition is as visible as a removal. */
const EXPECTED_EXPORTS = [
  "PACKAGE_NAME",
  "useEventLog",
  "useOfflineRegions",
  "useTrackRecorder",
] as const;

/** Published by `api.md` §9 and owned by **T5.1b**, which has not been built. */
const T5_1B_HOOKS = ["useTrackList", "useTrackDraft"] as const;

/** Internal to the package: seams and test infrastructure that must never reach a consumer. */
const MUST_NOT_ESCAPE = [
  "browserRecorderEnvironment",
  "renderHook",
  "createEventLog",
  "createWebTrackRecorder",
] as const;

describe("@mapatlas/react's public surface", () => {
  it("reports its package identity", () => {
    expect(barrel.PACKAGE_NAME).toBe("@mapatlas/react");
  });

  it("exports T5.1's three hooks and nothing else", () => {
    // A set comparison rather than three `toBeDefined` checks: those would pass while the barrel
    // quietly grew an export nobody reviewed, and the barrel is the package's whole contract.
    expect(Object.keys(barrel).sort()).toEqual([...EXPECTED_EXPORTS].sort());
  });

  it("still leaves T5.1b's hooks unbuilt, and says so", () => {
    // Not an idle assertion. When T5.1b lands, this test fails and has to be updated — which is
    // the moment to move those names from "deliberately absent" to "covered by the conformance
    // types above". Without it, the two would simply appear one day with nothing checking them.
    for (const hook of T5_1B_HOOKS) {
      expect(Object.keys(barrel), `${hook} belongs to T5.1b`).not.toContain(hook);
    }
  });

  it("keeps its internal seams and test harness off the barrel", () => {
    // `browserRecorderEnvironment` exists so ADR-0026's ownership rules can be proven by
    // counting calls; `renderHook` imports react-dom, a devDependency. Neither is a consumer's
    // business, and the packaging gate would fail on the second if it ever shipped.
    for (const name of MUST_NOT_ESCAPE) {
      expect(Object.keys(barrel), `${name} is internal`).not.toContain(name);
    }
  });

  it("takes exactly the parameters and returns exactly the shape api.md publishes", () => {
    // The compile-time comparisons above are the real check — a mismatch fails `tsc`, not this.
    // Asserting them here keeps them from being deleted as unused and states what they mean: an
    // extra optional parameter is a leaked seam, and a missing return member is a broken promise.
    // Callable at runtime, not merely present as a name: a type-only export would not appear in
    // `Object.keys` at all, but a re-exported constant would.
    for (const hook of [barrel.useTrackRecorder, barrel.useEventLog, barrel.useOfflineRegions]) {
      expect(hook).toBeTypeOf("function");
    }
    expect(parametersMatch).toEqual([true, true, true]);
    expect(returnsMatch).toEqual([true, true, true]);
    expect(shapesMatch).toEqual([true, true, true, true]);
  });
});
