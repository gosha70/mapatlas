// SPDX-License-Identifier: Apache-2.0

import { createElement, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";

import { computeStats } from "@mapatlas/core";
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
 * **A finalized track, not a live one.** `livePoint` and `draft` belong to `MapCanvas`; this
 * component takes a `Track` that is already complete.
 */
export function TripReview(props: TripReviewProps): ReactElement {
  return createElement(
    "section",
    { className: "mapatlas-trip-review" },
    createElement(MapCanvas, mapProps(props)),
    ...reviewBody(props),
  );
}

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
  props: TripReviewProps & { create: (options: MapControllerOptions) => MapController },
): ReactElement {
  return createElement(
    "section",
    { className: "mapatlas-trip-review" },
    createElement(MapCanvasInternal, { ...mapProps(props), create: props.create }),
    ...reviewBody(props),
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
        renderPhoto(media, resolved),
      ),
    ),
  );
}

/** `null` means resolved-and-absent; a string is an object URL; missing means still resolving. */
type Resolution = Record<string, string | null>;

function renderPhoto(media: MediaRef, resolved: Resolution): ReactElement {
  // A hosted URL wins outright and needs no lookup — the store is for blobs.
  if (media.url !== undefined) {
    return createElement("img", {
      className: "mapatlas-trip-photo-image",
      src: media.url,
      alt: "",
    });
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
  return createElement("img", { className: "mapatlas-trip-photo-image", src: url, alt: "" });
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
    // Anything we hold that this render no longer asks for is released now, not at unmount.
    for (const [key, url] of [...urls.current]) {
      if (!keys.includes(key)) {
        URL.revokeObjectURL(url);
        urls.current.delete(key);
        setResolved((previous) => {
          if (!(key in previous)) return previous;
          const rest = { ...previous };
          delete rest[key];
          return rest;
        });
      }
    }
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
