// SPDX-License-Identifier: Apache-2.0

/**
 * `<TripReview>` (tasks T5.4): replay a finalized track and browse its events,
 * photos, and summary stats.
 *
 * Replay is a scrubbable position along the track (a range slider plus a
 * play/pause control that advances an index). Photos render from `MediaRef.url`;
 * consumers that persist bytes by `blobKey` resolve them to object URLs before
 * passing events in (keeping this component free of the storage seam).
 */
import { useEffect, useMemo, useState } from "react";
import type { MapEvent, Track, TrackPoint } from "@mapatlas/core";

export interface TripReviewProps {
  track: Track;
  events: MapEvent[];
}

function trackPoints(track: Track): TrackPoint[] {
  return track.simplified && track.simplified.length > 0
    ? track.simplified
    : track.points;
}

function formatDistance(m: number | undefined): string {
  if (m === undefined) return "—";
  return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
}

function formatDuration(track: Track): string {
  if (track.endedAt === undefined) return "—";
  const s = Math.max(0, Math.round((track.endedAt - track.startedAt) / 1000));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${mm}m ${ss.toString().padStart(2, "0")}s`;
}

export function TripReview(props: TripReviewProps): JSX.Element {
  const { track, events } = props;
  const points = useMemo(() => trackPoints(track), [track]);
  const maxIndex = Math.max(0, points.length - 1);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    if (!playing) return;
    if (index >= maxIndex) {
      setPlaying(false);
      return;
    }
    const timer = setInterval(() => {
      setIndex((i) => {
        if (i >= maxIndex) return i;
        return i + 1;
      });
    }, 300);
    return () => clearInterval(timer);
  }, [playing, index, maxIndex]);

  const current = points[Math.min(index, maxIndex)];

  return (
    <section className="mapatlas-trip-review" aria-label="Trip review">
      <dl className="mapatlas-trip-stats">
        <div>
          <dt>Distance</dt>
          <dd data-testid="stat-distance">{formatDistance(track.distanceM)}</dd>
        </div>
        <div>
          <dt>Points</dt>
          <dd data-testid="stat-points">{points.length}</dd>
        </div>
        <div>
          <dt>Events</dt>
          <dd data-testid="stat-events">{events.length}</dd>
        </div>
        <div>
          <dt>Duration</dt>
          <dd data-testid="stat-duration">{formatDuration(track)}</dd>
        </div>
      </dl>

      <div className="mapatlas-trip-replay">
        <button
          type="button"
          onClick={() => setPlaying((p) => !p)}
          aria-pressed={playing}
          disabled={points.length < 2}
        >
          {playing ? "Pause" : "Play"}
        </button>
        <input
          type="range"
          min={0}
          max={maxIndex}
          value={Math.min(index, maxIndex)}
          onChange={(e) => setIndex(Number(e.target.value))}
          aria-label="Replay position"
        />
        <output data-testid="replay-position">
          {current
            ? `${current.lat.toFixed(5)}, ${current.lng.toFixed(5)}`
            : "no points"}
        </output>
      </div>

      <ul className="mapatlas-trip-events">
        {events.map((ev) => (
          <li key={ev.id} className="mapatlas-trip-event">
            <p className="mapatlas-trip-event-comment">
              {ev.comment ?? <em>(no comment)</em>}
            </p>
            {ev.tags.length > 0 && (
              <ul className="mapatlas-trip-event-tags">
                {ev.tags.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            )}
            <div className="mapatlas-trip-event-media">
              {ev.media.map((m) =>
                m.url ? (
                  <img
                    key={m.id}
                    src={m.url}
                    alt="Event"
                    width={96}
                    height={96}
                  />
                ) : (
                  <span key={m.id} className="mapatlas-media-ref">
                    photo
                  </span>
                ),
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
