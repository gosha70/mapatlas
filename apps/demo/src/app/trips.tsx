// SPDX-License-Identifier: Apache-2.0

/**
 * The stored trips, listed — T7.1b increment 1.
 *
 * **Presentational on purpose.** The binding that reads the store is `useTrackList`, held by
 * `loop.tsx` beside the other store-facing bindings; this file renders what it is handed. That
 * split is what lets the unit lane check the rendering and leaves the claim that actually matters
 * — *a trip this app stored appears in the list a **later document** renders* — to the browser
 * lane, where a real reload exists. A component test that feeds this two summaries and finds two
 * rows has proved rendering, and nothing about listing.
 *
 * **Summaries, never tracks.** `listTrackSummaries` exists so a device holding a hundred trips
 * does not deserialize a hundred point arrays to draw a list (ADR-0014). Nothing here reaches for
 * `getTrack`; hydration happens once, when a trip is opened.
 */

import type { ReactElement } from "react";

import type { Id, TrackSummary } from "@mapatlas/core";

export interface TripListProps {
  readonly tracks: readonly TrackSummary[];
  readonly loading: boolean;
  /** The trip currently under review, if it came from this list. */
  readonly openId: Id | undefined;
  readonly onOpen: (id: Id) => void;
}

/**
 * When the trip began, rendered so two machines agree.
 *
 * A locale string would read better and would make every assertion about this row depend on the
 * runner's time zone and ICU data. ISO to the minute is unambiguous and is what a field log wants
 * anyway.
 */
const startedAtLabel = (startedAt: number): string =>
  new Date(startedAt).toISOString().replace("T", " ").slice(0, 16);

/** What the summary can say without hydrating the track. */
function label(track: TrackSummary): string {
  const distanceM = track.stats?.distanceM;
  const distance = distanceM === undefined ? "" : ` · ${(distanceM / 1000).toFixed(2)} km`;
  return (
    `${startedAtLabel(track.startedAt)} · ${track.origin}` +
    `${distance} · ${String(track.pointCount)} point${track.pointCount === 1 ? "" : "s"}`
  );
}

export function TripList({ tracks, loading, openId, onOpen }: TripListProps): ReactElement {
  return (
    <section
      className="app-trips"
      id="trip-list"
      data-count={String(tracks.length)}
      data-loading={String(loading)}
      data-ids={tracks.map((track) => track.id).join(",")}
    >
      <h2>Stored trips</h2>
      {tracks.length === 0 ? (
        /* **An empty list and an unread one are different states**, and a first visit is neither
           a failure nor a reason to say nothing. `loading` separates "there are none" from "we
           have not looked yet", which are indistinguishable in a bare empty list. */
        <p id="trip-list-empty">
          {loading ? "Reading stored trips…" : "No trips stored yet. Record one above."}
        </p>
      ) : (
        <ul className="trip-rows">
          {tracks.map((track) => (
            <li key={track.id}>
              <button
                type="button"
                className="trip-open"
                data-track-id={track.id}
                data-origin={track.origin}
                data-points={String(track.pointCount)}
                // The reviewed trip is marked for assistive technology as well as for a scenario:
                // `aria-current` is the property a screen reader announces, and `data-open` is
                // what a test reads, so neither is inferred from the other.
                {...(track.id === openId
                  ? { "aria-current": "true" as const, "data-open": "true" }
                  : {})}
                onClick={() => {
                  onOpen(track.id);
                }}
              >
                {label(track)}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
