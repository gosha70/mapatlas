// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import type { ReactElement } from "react";

import type {
  DraftTrackPoint,
  Id,
  InterpolateTimesOptions,
  JSONValue,
  LatLng,
  MapEvent,
  MediaAnalyzer,
  OfflineRegion,
  OfflineRegionStore,
  SamplingPolicy,
  SensorSource,
  StorageAdapter,
  TerrainOptions,
  TileSource,
  Track,
  TrackPoint,
  TrackRecorder,
  TrackRecorderError,
  TrackStatus,
  TrackSummary,
} from "@mapatlas/core";
import type { DrawModeHandlers, EventPresentation } from "@mapatlas/maplibre";

import * as barrel from "./index.js";
// @ts-expect-error MapCanvasProps is intentionally not a named public API — api.md §9 publishes
// MapCanvas with an inline props shape. If someone re-exports the type this import succeeds, the
// directive goes stale, and tsc turns red. See the note above MapCanvasPropsMustStayPrivate.
import type { MapCanvasProps } from "./index.js";

/**
 * What `@mapatlas/react` publishes, against what `api.md` §9 says it publishes.
 *
 * **Covers T5.1's three hooks and T5.1b's two.** `useTrackList` and `useTrackDraft` were listed
 * here as deliberately absent while T5.1b was unbuilt, and that assertion did its job: it failed
 * the moment they reached the barrel, which is what forced them into the exact checks below
 * rather than letting them appear with nothing verifying them. `MapCanvas` and `EventComposer`
 * are the remaining §9 surface and belong to T5.2 and T5.3; they are named absent for the same
 * reason.
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

type PublishedUseTrackList = (store: StorageAdapter) => {
  tracks: TrackSummary[];
  loading: boolean;
  refresh(): Promise<void>;
  remove(id: Id): Promise<void>;
};

type PublishedMapCanvas = (props: {
  sources: TileSource[];
  style?: string | JSONValue;
  terrain?: TerrainOptions | null;
  presentation?: EventPresentation;
  track?: Track;
  events?: MapEvent[];
  livePoint?: TrackPoint;
  draft?: DraftTrackPoint[];
  drawMode?: boolean;
  onDraw?: DrawModeHandlers;
  onMapTap?(at: LatLng): void;
  onEventClick?(id: Id): void;
}) => ReactElement;

/**
 * `api.md` §9, transcribed. `FieldSpec` is a *named* published interface — unlike
 * `MapCanvasProps`, which §9 leaves inline — so its property types, its key set, and the
 * nested `options: { value, label }` shape are all part of the contract.
 */
interface PublishedFieldSpec {
  key: string;
  label: string;
  type: "text" | "number" | "boolean" | "select" | "date";
  options?: { value: string; label: string }[];
  unit?: string;
  required?: boolean;
  placeholder?: string;
}

type PublishedEventComposer = (props: {
  at: LatLng;
  store: StorageAdapter;
  analyzer?: MediaAnalyzer;
  mode?: "comment" | "photo";
  fields?: PublishedFieldSpec[];
  categories?: { value: string; label: string }[];
  occurredAt?: number;
  onSave(input: Omit<MapEvent, "id" | "position">): void;
  onCancel(): void;
}) => ReactElement;

type PublishedUseTrackDraft = (opts?: { from?: Track; store?: StorageAdapter }) => {
  points: DraftTrackPoint[];
  canUndo: boolean;
  canRedo: boolean;
  untimedIndices: number[];
  append(p: LatLng): void;
  insertAt(i: number, p: LatLng): void;
  moveAt(i: number, to: LatLng): void;
  removeAt(i: number): void;
  setTimeAt(i: number, t: number): void;
  interpolateTimes(o: InterpolateTimesOptions): void;
  breakAt(i: number): void;
  undo(): void;
  redo(): void;
  save(): Promise<Track>;
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
  Exactly<Parameters<typeof barrel.useTrackList>, Parameters<PublishedUseTrackList>>,
  Exactly<Parameters<typeof barrel.useTrackDraft>, Parameters<PublishedUseTrackDraft>>,
  Exactly<Parameters<typeof barrel.MapCanvas>, Parameters<PublishedMapCanvas>>,
] = [true, true, true, true, true, true];

const returnsMatch: [
  Exactly<ReturnType<typeof barrel.useTrackRecorder>, ReturnType<PublishedUseTrackRecorder>>,
  Exactly<ReturnType<typeof barrel.useEventLog>, ReturnType<PublishedUseEventLog>>,
  Exactly<ReturnType<typeof barrel.useOfflineRegions>, ReturnType<PublishedUseOfflineRegions>>,
  Exactly<ReturnType<typeof barrel.useTrackList>, ReturnType<PublishedUseTrackList>>,
  Exactly<ReturnType<typeof barrel.useTrackDraft>, ReturnType<PublishedUseTrackDraft>>,
  // `api.md` writes `JSX.Element`; under React 19's types that is `ReactElement`, and the
  // published type above says so explicitly rather than depending on a global JSX namespace.
  Exactly<ReturnType<typeof barrel.MapCanvas>, ReturnType<PublishedMapCanvas>>,
] = [true, true, true, true, true, true];

/** No extra member on either side — of the one options object, and of all three returns. */
const shapesMatch: [
  ExactKeys<
    NonNullable<Parameters<typeof barrel.useTrackRecorder>[0]>,
    NonNullable<Parameters<PublishedUseTrackRecorder>[0]>
  >,
  ExactKeys<
    NonNullable<Parameters<typeof barrel.useTrackDraft>[0]>,
    NonNullable<Parameters<PublishedUseTrackDraft>[0]>
  >,
  ExactKeys<ReturnType<typeof barrel.useTrackRecorder>, ReturnType<PublishedUseTrackRecorder>>,
  ExactKeys<ReturnType<typeof barrel.useEventLog>, ReturnType<PublishedUseEventLog>>,
  ExactKeys<ReturnType<typeof barrel.useOfflineRegions>, ReturnType<PublishedUseOfflineRegions>>,
  ExactKeys<ReturnType<typeof barrel.useTrackList>, ReturnType<PublishedUseTrackList>>,
  ExactKeys<ReturnType<typeof barrel.useTrackDraft>, ReturnType<PublishedUseTrackDraft>>,
  // The complete prop key set — the check that catches an extra optional prop, which mutual
  // assignability admits (the same hole ExactKeys exists for everywhere else).
  ExactKeys<Parameters<typeof barrel.MapCanvas>[0], Parameters<PublishedMapCanvas>[0]>,
  Exactly<Parameters<typeof barrel.EventComposer>, Parameters<PublishedEventComposer>>,
  Exactly<ReturnType<typeof barrel.EventComposer>, ReturnType<PublishedEventComposer>>,
  ExactKeys<Parameters<typeof barrel.EventComposer>[0], Parameters<PublishedEventComposer>[0]>,
  // `FieldSpec` by value *and* by key set: mutual assignability alone would admit an extra
  // optional property, which is the hole `ExactKeys` exists to close everywhere else here.
  Exactly<barrel.FieldSpec, PublishedFieldSpec>,
  ExactKeys<barrel.FieldSpec, PublishedFieldSpec>,
  // The nested option shape, checked as its own contract rather than only through its parent:
  // an option is `{ value, label }`, both strings, and nothing more.
  Exactly<NonNullable<barrel.FieldSpec["options"]>[number], { value: string; label: string }>,
  ExactKeys<NonNullable<barrel.FieldSpec["options"]>[number], { value: string; label: string }>,
] = [true, true, true, true, true, true, true, true, true, true, true, true, true, true, true];

/** What the package exports today. Compared as a set, so an addition is as visible as a removal. */
const EXPECTED_EXPORTS = [
  "EventComposer",
  "MapCanvas",
  "PACKAGE_NAME",
  "useEventLog",
  "useOfflineRegions",
  "useTrackDraft",
  "useTrackList",
  "useTrackRecorder",
] as const;

/**
 * Published by `api.md` §9 and **not yet built**: `TripReview`, owned by T5.4.
 *
 * The list earns its keep by failing: it once held `useTrackList`, `useTrackDraft`,
 * `MapCanvas` and `EventComposer`, and each assertion went red the moment its name reached
 * the barrel, which is what forced it into the exact checks above instead of appearing with
 * nothing verifying it. It was briefly deleted on the claim that nothing was unbuilt — that
 * claim was wrong, because §9 declares three components and only two exist.
 */
const NOT_YET_BUILT = ["TripReview"] as const;

/** Internal to the package: seams and test infrastructure that must never reach a consumer. */
const MUST_NOT_ESCAPE = [
  "MapCanvasInternal",
  "browserRecorderEnvironment",
  "renderHook",
  "createEventLog",
  "createTrackDraft",
  "createWebTrackRecorder",
  "useEventLogInternal",
  "useTrackDraftInternal",
  "useTrackRecorderInternal",
] as const;

/**
 * The hole the runtime export-set check cannot see: a **type-only** export never appears in
 * `Object.keys(barrel)`. `api.md` §9 publishes `MapCanvas` with an inline props shape and no
 * named props type, so `MapCanvasProps` must not be public — and the guard has to be a compile
 * error, not a runtime assertion.
 *
 * The alias is deliberately *used* below. A bare `@ts-expect-error` on an import would stay
 * satisfied even after someone re-exported the type, because the unused-import diagnostic lands
 * on the same line and consumes the directive; referencing the alias keeps "unused" off the
 * table, so re-exporting the type makes the directive itself stale and `tsc` turns red.
 */
// **The binding is used, deliberately.** A bare guarded import would stay green even after the
// type was re-exported, because the unused-import diagnostic lands on the same line and consumes
// the directive. Referencing it keeps "unused" off the table: when the export is absent the
// import errors and the directive eats exactly that; when it appears, nothing on that line
// errors and the stale directive itself fails the compile.
type MapCanvasPropsMustStayPrivate = MapCanvasProps;
const propsTypeStaysPrivate: MapCanvasPropsMustStayPrivate | undefined = undefined;

describe("@mapatlas/react's public surface", () => {
  it("reports its package identity", () => {
    expect(barrel.PACKAGE_NAME).toBe("@mapatlas/react");
  });

  it("still leaves T5.4's component unbuilt, and says so", () => {
    for (const name of NOT_YET_BUILT) {
      expect(Object.keys(barrel), `${name} is not built yet`).not.toContain(name);
    }
  });

  it("exports the five published hooks, both built components, and nothing else", () => {
    // A set comparison rather than a handful of `toBeDefined` checks: those would pass while
    // the barrel quietly grew an export nobody reviewed, and the barrel is the package's whole
    // contract. With T5.3 closed this is §9's React surface minus `TripReview`, which T5.4
    // owns and which the list above asserts absent.
    expect(Object.keys(barrel).sort()).toEqual([...EXPECTED_EXPORTS].sort());
  });

  it("keeps its internal seams and test harness off the barrel", () => {
    // Anchors the type-level guard above so nothing is unused; the real check is the compile.
    expect(propsTypeStaysPrivate).toBeUndefined();

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
    for (const hook of [
      barrel.useTrackRecorder,
      barrel.useEventLog,
      barrel.useOfflineRegions,
      barrel.useTrackList,
      barrel.useTrackDraft,
      barrel.MapCanvas,
      barrel.EventComposer,
    ]) {
      expect(hook).toBeTypeOf("function");
    }
    expect(parametersMatch).toEqual([true, true, true, true, true, true]);
    expect(returnsMatch).toEqual([true, true, true, true, true, true]);
    // Fifteen: the eight that were here, plus EventComposer's parameters, return and key set,
    // and FieldSpec by value and by key set with its nested option shape checked both ways.
    expect(shapesMatch).toEqual(Array.from({ length: 15 }, () => true));
  });
});
