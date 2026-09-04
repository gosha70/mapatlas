// SPDX-License-Identifier: Apache-2.0

import { createElement } from "react";
import type { ReactElement } from "react";

import { computeStats } from "@mapatlas/core";
import type {
  ChannelDescriptor,
  Id,
  JSONValue,
  MapEvent,
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
  const stats = computeStats(props.track);
  const charts = chartable(props.track, props.channels);
  return [
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
    .filter((p) => p.channels?.[descriptor.key] !== undefined)
    .map((p) => ({ t: p.t, v: p.channels?.[descriptor.key] ?? 0 }));

  // **Against time, not sample index.** Pauses make the spacing uneven by construction, and an
  // evenly-spaced plot of unevenly-timed samples misstates the trip — it draws a stop as though
  // the trip continued through it at the same rate.
  const t0 = samples[0]?.t ?? 0;
  const t1 = samples[samples.length - 1]?.t ?? t0;
  const span = t1 - t0;
  const lo = descriptor.min ?? Math.min(...samples.map((s) => s.v));
  const hi = descriptor.max ?? Math.max(...samples.map((s) => s.v));
  const range = hi - lo;
  const x = (t: number): number => (span === 0 ? 0 : ((t - t0) / span) * CHART_W);
  const y = (v: number): number =>
    range === 0 ? CHART_H / 2 : CHART_H - ((v - lo) / range) * CHART_H;

  const points = samples.map((s) => `${x(s.t).toFixed(2)},${y(s.v).toFixed(2)}`).join(" ");
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
      { viewBox: `0 0 ${String(CHART_W)} ${String(CHART_H)}`, role: "img" },
      createElement("polyline", { className: "mapatlas-trip-chart-line", points }),
    ),
  );
}
