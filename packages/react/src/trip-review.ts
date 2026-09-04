// SPDX-License-Identifier: Apache-2.0

import { createElement, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, ReactElement } from "react";

import { computeStats, positionAt } from "@mapatlas/core";
import type {
  ChannelDescriptor,
  Id,
  JSONValue,
  MapEvent,
  MediaRef,
  StorageAdapter,
  TerrainOptions,
  TileSource,
  Track,
  TrackPoint,
  TrackStats,
} from "@mapatlas/core";
import type { EventPresentation, MapController, MapControllerOptions } from "@mapatlas/maplibre";

import type { MapCanvasProps } from "./map-canvas.js";
import { MapCanvas, MapCanvasInternal } from "./map-canvas.js";

/** Published by `api.md` §9 as an inline shape; named here only so the two entry points below
 *  can share it, and deliberately **not** exported from the barrel — as with `MapCanvasProps`,
 *  exporting it would add public API the contract does not publish. */
interface TripReviewProps {
  track: Track;
  events: MapEvent[];
  /** Resolves `MediaRef.blobKey` for display (ADR-0028). Unread until increment 3 — required
   *  from the start because adding it later would be a breaking change to every consumer. */
  store: StorageAdapter;
  sources: TileSource[];
  style?: string | JSONValue;
  terrain?: TerrainOptions | null;
  presentation?: EventPresentation;
  channels?: string[];
  onEventClick?(id: Id): void;
}

/**
 * Review a finalized trip: the track on a basemap with its start and finish marks, its events,
 * and — from later increments — photos, stats and per-channel charts (`api.md` §9, T5.4).
 *
 * **Composition, not a second renderer.** The map half is `MapCanvas`, unchanged. Start and
 * finish marks need no route of their own: `EventPresentation` already declares `startMarker`
 * and `finishMarker` with neutral built-in defaults, and the controller renders them from the
 * track as *track* marks — a channel distinct from event marks, so they are not clickable and
 * `onEventClick` reports only real events. Driving the controller directly would have meant
 * re-solving SSR safety, mount ordering and StrictMode remounts that `MapCanvas` already
 * settled.
 *
 * **A finalized track, not a live one.** `draft` belongs to `MapCanvas`; this component takes a
 * `Track` that is already complete. It does drive `MapCanvas`'s `livePoint`, but with the
 * *replay cursor's* position rather than a live fix — the prop is "where to draw the moving
 * marker", and a replay marker is exactly that.
 */
export function TripReview(props: TripReviewProps): ReactElement {
  return createElement(TripReviewInternal, { ...props, create: createNothing });
}

/** Sentinel meaning "the public entry point": `TripReviewInternal` renders `MapCanvas` rather
 *  than `MapCanvasInternal` when it sees this, so the public path has no injected seam. */
const createNothing = undefined as unknown as (options: MapControllerOptions) => MapController;

/**
 * Exported for tests only — not re-exported from the package barrel.
 *
 * The `create` seam exists for the same reason `MapCanvasInternal`'s does: every prop this
 * component forwards has a default that renders *something*, so a test observing only the DOM
 * would pass while a pass-through was missing. Observing what reaches the controller is what
 * makes each forward falsifiable — `presentation` most of all, since dropping it still draws
 * start and finish marks from the built-in defaults.
 *
 * Two entry points rather than one with an optional `create`, deliberately: a single one needed
 * a cast to satisfy `MapCanvasInternal`'s required seam, and that cast silenced type checking on
 * every forwarded prop — which is the thing this component is almost entirely made of.
 */
export function TripReviewInternal(
  props: TripReviewProps & {
    create: (options: MapControllerOptions) => MapController;
    clock?: ReplayClock;
  },
): ReactElement {
  const replay = useReplay(props.track, props.clock ?? systemReplayClock);
  // `positionAt` and nothing else. A second computation of "where was the track at t" is the
  // drift ADR-0032 put the projection in core to prevent.
  const at = replay.cursor === undefined ? undefined : positionAt(props.track, replay.cursor);
  const marker: TrackPoint | undefined =
    at === undefined || replay.cursor === undefined
      ? undefined
      : { lat: at.lat, lng: at.lng, t: replay.cursor };

  const canvas = { ...mapProps(props), ...(marker === undefined ? {} : { livePoint: marker }) };
  return createElement(
    "section",
    { className: "mapatlas-trip-review" },
    props.create === undefined
      ? createElement(MapCanvas, canvas)
      : createElement(MapCanvasInternal, { ...canvas, create: props.create }),
    createElement(ReplayControls, { key: "replay", track: props.track, replay }),
    ...reviewBody(props),
  );
}

function ReplayControls(props: {
  track: Track;
  replay: ReturnType<typeof useReplay>;
}): ReactElement | null {
  const { replay, track } = props;
  const first = track.points[0];
  const last = track.points[track.points.length - 1];
  if (first === undefined || last === undefined || replay.cursor === undefined) return null;
  return createElement(
    "div",
    { className: "mapatlas-trip-replay" },
    createElement(
      "button",
      {
        type: "button",
        className: "mapatlas-trip-replay-toggle",
        onClick: replay.playing ? replay.pause : replay.play,
      },
      replay.playing ? "Pause" : "Play",
    ),
    createElement("input", {
      className: "mapatlas-trip-replay-scrub",
      type: "range",
      min: first.t,
      max: last.t,
      value: replay.cursor,
      "aria-label": "Replay position",
      onChange: (change: ChangeEvent<HTMLInputElement>) => {
        replay.scrubTo(Number(change.target.value));
      },
    }),
  );
}

/**
 * The forwarded half of the props, in one place so both entry points cannot drift.
 *
 * Conditional spreads throughout: `exactOptionalPropertyTypes` distinguishes an absent optional
 * prop from one explicitly `undefined`, and the two are different requests. `MapCanvas`
 * normalises them identically today, so the distinction is currently unobservable at runtime and
 * is held by the type instead — a mutation replacing a spread with `presentation:
 * props.presentation` is rejected by `tsc`, not by a test.
 */
function mapProps(props: TripReviewProps): MapCanvasProps {
  return {
    sources: props.sources,
    track: props.track,
    events: props.events,
    ...(props.style === undefined ? {} : { style: props.style }),
    ...(props.terrain === undefined ? {} : { terrain: props.terrain }),
    ...(props.presentation === undefined ? {} : { presentation: props.presentation }),
    ...(props.onEventClick === undefined ? {} : { onEventClick: props.onEventClick }),
  };
}

/**
 * The clock, injected so replay is deterministic under test.
 *
 * Deliberately **not** a prop: a scheduler is implementation machinery, and putting it in the
 * published contract would mean owning its shape indefinitely for the benefit of nobody who
 * consumes the engine. Same reasoning as core's `Scheduler` for the polling sensor source.
 */
export interface ReplayClock {
  now(): number;
  schedule(callback: () => void): () => void;
}

const systemReplayClock: ReplayClock = {
  now: () => Date.now(),
  schedule: (callback) => {
    const handle = requestAnimationFrame(() => {
      callback();
    });
    return () => {
      cancelAnimationFrame(handle);
    };
  },
};

/**
 * The replay cursor and its controls.
 *
 * **Mounts paused at `first.t`** (ADR-0030). Opening a review must not start a time-dependent
 * action on its own, and autoplay would be choosing a policy the contract did not. Nothing
 * advances until an explicit Play.
 *
 * The cursor is one value. The map marker reads it through `positionAt`, and the chart cursor
 * will read the same one, so the two cannot disagree about where the trip was.
 */
function useReplay(
  track: Track,
  clock: ReplayClock,
): {
  cursor: number | undefined;
  playing: boolean;
  play: () => void;
  pause: () => void;
  scrubTo: (t: number) => void;
} {
  const first = track.points[0];
  const last = track.points[track.points.length - 1];
  const from = first?.t;
  const to = last?.t;

  const [cursor, setCursor] = useState<number | undefined>(from);
  const [playing, setPlaying] = useState(false);

  // A replacement track must not leave the cursor outside the new range — it would ask
  // `positionAt` for a time this track never covered, and get `undefined` forever.
  const bounds = `${String(from)}:${String(to)}`;
  const mounted = useRef(false);
  useEffect(() => {
    // Skips the mount run, deliberately. Without that this effect also set the initial cursor
    // and paused state, making the `useState` initialisers above unfalsifiable — mutations of
    // them survived, because the effect corrected them before anything could observe it. One
    // rule, one home: the initialisers own the mount state, this owns replacement.
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    setPlaying(false);
    setCursor(from);
  }, [bounds, from]);

  const anchor = useRef<{ wall: number; cursor: number } | undefined>(undefined);
  useEffect(() => {
    if (!playing || from === undefined || to === undefined) return undefined;
    let cancel: (() => void) | undefined;
    const tick = (): void => {
      const start = anchor.current;
      if (start === undefined) return;
      const next = start.cursor + (clock.now() - start.wall);
      if (next >= to) {
        setCursor(to);
        setPlaying(false);
        return;
      }
      setCursor(next);
      cancel = clock.schedule(tick);
    };
    cancel = clock.schedule(tick);
    return () => {
      cancel?.();
    };
  }, [playing, from, to, clock]);

  const play = (): void => {
    if (from === undefined || to === undefined || from === to) return;
    // Restart from the beginning when the cursor is already at the end, rather than playing a
    // zero-length stretch and stopping again.
    const at = cursor === undefined || cursor >= to ? from : cursor;
    anchor.current = { wall: clock.now(), cursor: at };
    setCursor(at);
    setPlaying(true);
  };
  const pause = (): void => {
    setPlaying(false);
  };
  const scrubTo = (t: number): void => {
    if (from === undefined || to === undefined) return;
    // No clamp here, and its absence is deliberate. `scrubTo` is reached only from the range
    // input, whose `min`/`max` come from the track's own endpoints, so the browser has already
    // clamped `t` before this sees it — a second clamp was unfalsifiable and a mutation
    // removing it survived. The range attributes are the falsifiable guard, and they are the
    // ones the tests pin.
    anchor.current = { wall: clock.now(), cursor: t };
    setCursor(t);
  };

  return { cursor, playing, play, pause, scrubTo };
}

/** The non-map half: the stats panel, then one chart per chartable channel. */
function reviewBody(props: TripReviewProps): ReactElement[] {
  // `computeStats` and nothing else. A second implementation here would drift from the one the
  // recorder, the summary and the export all use, and the first thing it would get wrong is
  // `movingTimeMs`, which excludes pauses — a naive walk of the points sums straight through
  // them.
  // Derived from `track`/`channels` alone, and the parent re-renders far more often than a
  // finalized track changes.
  const stats = useMemo(() => computeStats(props.track), [props.track]);
  const charts = useMemo(
    () => chartable(props.track, props.channels),
    [props.track, props.channels],
  );
  return [
    createElement(Photos, { key: "photos", events: props.events, store: props.store }),
    createElement(StatsPanel, { key: "stats", stats }),
    ...(charts.length === 0
      ? []
      : [createElement(ChannelCharts, { key: "charts", track: props.track, charts, stats })]),
  ];
}

/**
 * The descriptors that can actually be charted, in declaration order.
 *
 * ADR-0029: the default is the **descriptors**, not the keys found in the data — a descriptor
 * is the consumer's statement that a channel exists and how to label it, and a key with no
 * descriptor has neither to chart with. A descriptor with no samples yields nothing, so a
 * declared-but-empty channel is indistinguishable here from an undeclared one; that is the
 * accepted consequence recorded in the ADR, not an oversight.
 */
function chartable(track: Track, requested: string[] | undefined): ChannelDescriptor[] {
  const declared = track.channels ?? [];
  const wanted =
    requested === undefined ? declared : declared.filter((d) => requested.includes(d.key));
  return wanted.filter((d) => track.points.some((p) => p.channels?.[d.key] !== undefined));
}

function StatsPanel(props: { stats: TrackStats }): ReactElement {
  const { stats } = props;
  const rows: [string, string][] = [
    ["Distance", `${(stats.distanceM / 1000).toFixed(2)} km`],
    ["Duration", formatDuration(stats.durationMs)],
    ["Moving", formatDuration(stats.movingTimeMs)],
  ];
  return createElement(
    "dl",
    { className: "mapatlas-trip-stats" },
    ...rows.flatMap(([label, value], index) => [
      createElement("dt", { key: `t${String(index)}` }, label),
      createElement("dd", { key: `d${String(index)}` }, value),
    ]),
  );
}

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${String(h)}:${pad(m)}:${pad(s)}`;
}

const CHART_W = 300;
const CHART_H = 60;

function ChannelCharts(props: {
  track: Track;
  charts: ChannelDescriptor[];
  stats: TrackStats;
}): ReactElement {
  return createElement(
    "div",
    { className: "mapatlas-trip-charts" },
    ...props.charts.map((descriptor) =>
      createElement(ChannelChart, {
        key: descriptor.key,
        descriptor,
        track: props.track,
        stats: props.stats.channels?.[descriptor.key],
      }),
    ),
  );
}

function ChannelChart(props: {
  descriptor: ChannelDescriptor;
  track: Track;
  stats: { min: number; max: number; avg: number } | undefined;
}): ReactElement {
  const { descriptor, track } = props;
  const samples = track.points
    .map((p, index) => ({ index, t: p.t, v: p.channels?.[descriptor.key] }))
    .filter((s): s is { index: number; t: number; v: number } => s.v !== undefined);

  // **Against time, not sample index.** Pauses make the spacing uneven by construction, and an
  // evenly-spaced plot of unevenly-timed samples misstates the trip — it draws a stop as though
  // the trip continued through it at the same rate.
  const t0 = samples[0]?.t ?? 0;
  const t1 = samples[samples.length - 1]?.t ?? t0;
  const span = t1 - t0;
  // Folded rather than spread: `Math.min(...xs)` passes one argument per sample, and the
  // argument-count ceiling is in the tens to hundreds of thousands depending on the engine —
  // a multi-hour recording at 1 Hz sits inside that range.
  const lo =
    descriptor.min ?? samples.reduce((m, s) => (s.v < m ? s.v : m), Number.POSITIVE_INFINITY);
  const hi =
    descriptor.max ?? samples.reduce((m, s) => (s.v > m ? s.v : m), Number.NEGATIVE_INFINITY);
  const range = hi - lo;
  const x = (t: number): number => (span === 0 ? 0 : ((t - t0) / span) * CHART_W);
  const y = (v: number): number =>
    range === 0 ? CHART_H / 2 : CHART_H - ((v - lo) / range) * CHART_H;

  // **One polyline per segment, not one across the track.** A single line would run straight
  // from the last sample before a pause to the first after it — drawing the stop as though the
  // trip continued through it at some rate, which is exactly what the map refuses to do: the
  // rendered track holds no line across a pause, and ADR-0030 carries the same rule to the
  // replay marker. A chart that glides across the gap would be the one surface asserting the
  // trip continued.
  const lines = track.segments
    .map((segment) =>
      samples
        .filter((s) => s.index >= segment.startIndex && s.index <= segment.endIndex)
        .map((s) => `${x(s.t).toFixed(2)},${y(s.v).toFixed(2)}`)
        .join(" "),
    )
    .filter((points) => points !== "");
  // `label`, `unit` and `precision` rendered verbatim from the descriptor — the engine never
  // derives any of the three, because doing so would be learning what the number means
  // (ADR-0009).
  const digits = descriptor.precision ?? 1;
  const summary =
    props.stats === undefined ? "" : ` ${props.stats.avg.toFixed(digits)} ${descriptor.unit} avg`;
  return createElement(
    "figure",
    { className: "mapatlas-trip-chart", "data-channel": descriptor.key },
    createElement("figcaption", null, `${descriptor.label}${summary}`),
    createElement(
      "svg",
      {
        viewBox: `0 0 ${String(CHART_W)} ${String(CHART_H)}`,
        role: "img",
        // `role="img"` without a name is an unnamed image to a screen reader.
        "aria-label": `${descriptor.label} over time, in ${descriptor.unit}`,
      },
      ...lines.map((points, index) =>
        createElement("polyline", {
          key: index,
          className: "mapatlas-trip-chart-line",
          points,
        }),
      ),
    ),
  );
}

/**
 * The photos attached to this trip's events.
 *
 * Three outcomes, deliberately distinguishable — this is what ADR-0028's required `store` was
 * argued for. A `MediaRef` with a `url` is already hosted and is rendered from it **without
 * touching the store at all**. One with a `blobKey` is resolved through the store. One whose
 * `blobKey` the store does not hold renders an explicit *unavailable* placeholder rather than
 * nothing: the event records that a photo exists, and showing nothing would misreport the event
 * as having none — the same ambiguity the required store removed at the API level, reintroduced
 * at the pixel level.
 */
function Photos(props: { events: MapEvent[]; store: StorageAdapter }): ReactElement | null {
  const refs = useMemo(
    () => props.events.flatMap((event) => event.media.map((media) => ({ event, media }))),
    [props.events],
  );
  const resolved = useResolvedBlobs(refs, props.store);
  if (refs.length === 0) return null;
  return createElement(
    "ul",
    { className: "mapatlas-trip-photos" },
    ...refs.map(({ event, media }) =>
      createElement(
        "li",
        { key: `${event.id}:${media.id}`, className: "mapatlas-trip-photo" },
        renderPhoto(event, media, resolved),
      ),
    ),
  );
}

/** `null` means resolved-and-absent; a string is an object URL; missing means still resolving. */
type Resolution = Record<string, string | null>;

function renderPhoto(event: MapEvent, media: MediaRef, resolved: Resolution): ReactElement {
  // Not decorative: this is the only visual record of the event, so `alt=""` would give a
  // screen reader nothing at all. The comment is offered as *context*, not as a description —
  // presenting it as the alt text alone would assert that the consumer's words describe what
  // is in the frame, which the engine cannot know and often would not be true.
  const alt =
    event.comment === undefined
      ? "Photo attached to this event"
      : `Photo attached to event: ${event.comment}`;
  // A hosted URL wins outright and needs no lookup — the store is for blobs.
  if (media.url !== undefined) {
    return createElement("img", { className: "mapatlas-trip-photo-image", src: media.url, alt });
  }
  if (media.blobKey === undefined) {
    return createElement(
      "p",
      { className: "mapatlas-trip-photo-missing" },
      "This photo is unavailable.",
    );
  }
  const url = resolved[media.blobKey];
  if (url === undefined) {
    return createElement("p", { className: "mapatlas-trip-photo-loading" }, "Loading photo…");
  }
  if (url === null) {
    return createElement(
      "p",
      { className: "mapatlas-trip-photo-missing" },
      "This photo is unavailable.",
    );
  }
  return createElement("img", { className: "mapatlas-trip-photo-image", src: url, alt });
}

/**
 * Resolve `blobKey`s to object URLs, revoking them when they stop being needed.
 *
 * **Two revocation moments, not one.** Unmount is the obvious one; the other is the media list
 * changing under a live component, which a mount/unmount test never reaches — a review that
 * swaps trips would leak every previous trip's URLs for as long as the page lives.
 */
function useResolvedBlobs(refs: { media: MediaRef }[], store: StorageAdapter): Resolution {
  const [resolved, setResolved] = useState<Resolution>({});
  const urls = useRef(new Map<string, string>());
  /**
   * Which store the cache above belongs to.
   *
   * **Resolution identity is the pair `(store, blobKey)`, not the key.** Both caches were keyed
   * by key alone, so a store swap under an unchanged key short-circuited on
   * `urls.current.has(key)`: the replacement was never asked, and the previous store's object
   * URL stayed on screen indefinitely. The `null` case was staler still — the old
   * "unavailable" verdict was shown as though it were the new store's answer.
   */
  const cacheOwner = useRef<StorageAdapter | undefined>(undefined);

  const keys = useMemo(
    () =>
      [
        ...new Set(
          refs
            .filter(({ media }) => media.url === undefined && media.blobKey !== undefined)
            .map(({ media }) => media.blobKey ?? ""),
        ),
      ].sort(),
    [refs],
  );
  const keyId = keys.join("\u0000");

  useEffect(() => {
    // A different store invalidates *every* store-backed resolution, even for identical keys:
    // nothing the previous one said is evidence about this one.
    if (cacheOwner.current !== store) {
      for (const url of urls.current.values()) URL.revokeObjectURL(url);
      urls.current.clear();
      cacheOwner.current = store;
      setResolved({});
    }
    // Anything we hold that this render no longer asks for is released now, not at unmount.
    for (const [key, url] of [...urls.current]) {
      if (!keys.includes(key)) {
        URL.revokeObjectURL(url);
        urls.current.delete(key);
      }
    }
    // Pruned from `keys`, not from the URL map — the map holds only keys that *resolved to a
    // URL*, so a key that resolved to `null` (absent from the store) would never be pruned by
    // it. Its stale `null` then outlives the media list: swap trips A → B → A and that key
    // renders "unavailable" for a frame before the re-fetch instead of "Loading", and reports
    // the old answer if the blob was written in between.
    setResolved((previous) => {
      const kept = Object.fromEntries(
        Object.entries(previous).filter(([key]) => keys.includes(key)),
      );
      return Object.keys(kept).length === Object.keys(previous).length ? previous : kept;
    });
    let live = true;
    void (async () => {
      for (const key of keys) {
        if (urls.current.has(key)) continue;
        const blob = await store.getBlob(key);
        if (!live) return;
        if (blob === undefined) {
          setResolved((previous) => ({ ...previous, [key]: null }));
          continue;
        }
        const url = URL.createObjectURL(blob);
        urls.current.set(key, url);
        setResolved((previous) => ({ ...previous, [key]: url }));
      }
    })();
    return () => {
      live = false;
    };
    // `keyId` rather than `keys`: a fresh array each render would re-run this every time.
  }, [keyId, store]);

  const held = urls.current;
  useEffect(() => {
    return () => {
      for (const url of held.values()) URL.revokeObjectURL(url);
      held.clear();
    };
  }, [held]);

  return resolved;
}
