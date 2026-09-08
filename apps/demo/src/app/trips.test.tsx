// @vitest-environment happy-dom
// SPDX-License-Identifier: Apache-2.0
import { act, createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import type { TrackSummary } from "@mapatlas/core";

import { TripList } from "./trips.js";

/**
 * The list, rendered.
 *
 * **What this lane can claim, stated so it is not over-read.** Feeding this component two
 * summaries and finding two rows proves rendering. It proves nothing whatever about *listing* —
 * that a trip the app stored appears in a list a later document draws is the browser lane's
 * claim, and needs a real reload to make. What is here is the part a scenario cannot see cheaply:
 * the order it keeps, the two empty states it distinguishes, and what each row carries.
 */

let root: Root | undefined;
let host: HTMLElement | undefined;

const summary = (over: Partial<TrackSummary> = {}): TrackSummary =>
  ({
    id: "t1",
    startedAt: Date.UTC(2026, 8, 8, 9, 30),
    status: "finalized",
    origin: "recorded",
    pointCount: 2,
    ...over,
  }) as TrackSummary;

const opened: string[] = [];

const render = async (
  tracks: TrackSummary[],
  { loading = false, openId }: { loading?: boolean; openId?: string } = {},
) => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      createElement(
        StrictMode,
        null,
        createElement(TripList, {
          tracks,
          loading,
          openId,
          onOpen: (id: string) => opened.push(id),
        }),
      ),
    );
  });
  return host;
};

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = undefined;
  host?.remove();
  document.body.innerHTML = "";
  opened.length = 0;
});

const rows = (): HTMLElement[] => [...(host?.querySelectorAll<HTMLElement>(".trip-open") ?? [])];

describe("the trip list", () => {
  it("renders one row per summary, in the order it was given", async () => {
    /**
     * **Not re-sorted here.** `listTrackSummaries` is contractually ordered — by `startedAt`,
     * ties broken by id — and the storage conformance suite enforces it for every adapter.
     * Sorting again above the seam would duplicate that rule where it can drift, and would
     * silently paper over an adapter that got it wrong. So the reversed input below must come
     * back reversed.
     */
    await render([
      summary({ id: "later", startedAt: 2_000 }),
      summary({ id: "earlier", startedAt: 1_000 }),
    ]);

    expect(rows().map((row) => row.dataset["trackId"])).toStrictEqual(["later", "earlier"]);
  });

  it("separates a list that is still being read from one that is empty", async () => {
    // A bare empty list cannot tell them apart, and they mean opposite things to someone who
    // recorded a trip a moment ago.
    await render([], { loading: true });
    expect(host?.querySelector("#trip-list-empty")?.textContent ?? "").toContain("Reading");

    await act(async () => {
      root?.render(
        createElement(TripList, {
          tracks: [],
          loading: false,
          openId: undefined,
          onOpen: () => undefined,
        }),
      );
    });
    expect(host?.querySelector("#trip-list-empty")?.textContent ?? "").toContain("No trips stored");
  });

  it("carries each row's id and provenance, and its distance when the summary has one", async () => {
    // `origin` is on every row from the start: T7.1b's criterion is that an authored trip lists
    // and reviews like a recorded one, and a list that never showed provenance could not be used
    // to see the difference the criterion is about.
    await render([
      summary({ id: "t1", origin: "authored", pointCount: 1, stats: { distanceM: 1234 } as never }),
    ]);

    const row = rows()[0];
    expect(row?.dataset["origin"]).toBe("authored");
    expect(row?.dataset["points"]).toBe("1");
    expect(row?.textContent ?? "").toContain("authored");
    expect(row?.textContent ?? "").toContain("1.23 km");
    // Singular, because "1 points" is the kind of thing a demo is read for.
    expect(row?.textContent ?? "").toContain("1 point");
    expect(row?.textContent ?? "").not.toContain("1 points");
  });

  it("renders a summary with no stats rather than an empty distance", async () => {
    // `stats` is optional on the published type; a track that was never finalized has none, and
    // "NaN km" or a stray separator is what a naive template produces.
    await render([summary({ id: "t1" })]);

    expect(rows()[0]?.textContent ?? "").not.toContain("km");
    expect(rows()[0]?.textContent ?? "").not.toContain("NaN");
  });

  it("renders the start time the same way on any machine", async () => {
    // A locale string would read better and would make this row depend on the runner's time zone
    // and ICU data.
    await render([summary({ id: "t1", startedAt: Date.UTC(2026, 8, 8, 9, 30) })]);

    expect(rows()[0]?.textContent ?? "").toContain("2026-09-08 09:30");
  });

  it("opens the trip whose row was pressed", async () => {
    await render([summary({ id: "first" }), summary({ id: "second" })]);

    rows()[1]?.click();

    expect(opened).toStrictEqual(["second"]);
  });

  it("marks the open trip for a reader and for a test, by separate means", async () => {
    // `aria-current` is what a screen reader announces and `data-open` is what a scenario reads;
    // deriving one from the other in a test would leave the announced half unchecked.
    await render([summary({ id: "first" }), summary({ id: "second" })], { openId: "second" });

    expect(rows()[1]?.getAttribute("aria-current")).toBe("true");
    expect(rows()[1]?.dataset["open"]).toBe("true");
    expect(rows()[0]?.getAttribute("aria-current")).toBeNull();
    expect(rows()[0]?.dataset["open"]).toBeUndefined();
  });
});
