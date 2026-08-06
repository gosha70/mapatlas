// SPDX-License-Identifier: Apache-2.0
import { useEffect, useMemo, useState } from "react";
import type {
  MapEvent,
  StorageAdapter,
  Track,
  TrackPoint,
} from "@mapatlas/core";

export interface TripReviewProps {
  track: Track;
  events: MapEvent[];
  /** Additive: resolves photo previews stored by `blobKey` (api.md §7). */
  store?: StorageAdapter;
}

const REPLAY_STEP_MS = 400;

function line(track: Track): TrackPoint[] {
  return track.simplified && track.simplified.length > 0
    ? track.simplified
    : track.points;
}

function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return [h, m, sec].map((n) => String(n).padStart(2, "0")).join(":");
}

export function TripReview(props: TripReviewProps): React.JSX.Element {
  const { track, events, store } = props;
  const pts = useMemo(() => line(track), [track]);

  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState<string | null>(null);
  const [previews, setPreviews] = useState<Record<string, string>>({});

  // Replay: advance the cursor while playing; stop at the end.
  useEffect(() => {
    if (!playing || pts.length === 0) return;
    const timer = setInterval(() => {
      setIndex((i) => {
        if (i >= pts.length - 1) {
          setPlaying(false);
          return i;
        }
        return i + 1;
      });
    }, REPLAY_STEP_MS);
    return () => clearInterval(timer);
  }, [playing, pts.length]);

  // Resolve photo previews: object URLs from stored blobs, or direct `url`s.
  useEffect(() => {
    let cancelled = false;
    const created: string[] = [];
    void (async () => {
      const next: Record<string, string> = {};
      for (const ev of events) {
        for (const m of ev.media) {
          if (m.url) {
            next[m.id] = m.url;
          } else if (m.blobKey && store) {
            const blob = await store.getBlob(m.blobKey);
            if (blob) {
              const objectUrl = URL.createObjectURL(blob);
              created.push(objectUrl);
              next[m.id] = objectUrl;
            }
          }
        }
      }
      if (!cancelled) setPreviews(next);
    })();
    return () => {
      cancelled = true;
      for (const url of created) URL.revokeObjectURL(url);
    };
  }, [events, store]);

  const cursor = pts[Math.min(index, Math.max(0, pts.length - 1))];
  const durationMs =
    track.endedAt !== undefined ? track.endedAt - track.startedAt : 0;
  const distanceKm = ((track.distanceM ?? 0) / 1000).toFixed(2);
  const active = events.find((e) => e.id === selectedEvent);

  return (
    <section className="mapatlas-trip-review" aria-label="Trip review">
      <dl className="mapatlas-trip-review__stats">
        <div>
          <dt>Distance</dt>
          <dd>{distanceKm} km</dd>
        </div>
        <div>
          <dt>Duration</dt>
          <dd>{formatDuration(durationMs)}</dd>
        </div>
        <div>
          <dt>Points</dt>
          <dd>{pts.length}</dd>
        </div>
        <div>
          <dt>Events</dt>
          <dd>{events.length}</dd>
        </div>
      </dl>

      <div className="mapatlas-trip-review__replay">
        <button
          type="button"
          onClick={() => setPlaying((p) => !p)}
          disabled={pts.length === 0}
          aria-pressed={playing}
        >
          {playing ? "Pause" : "Play"}
        </button>
        <input
          type="range"
          min={0}
          max={Math.max(0, pts.length - 1)}
          value={index}
          aria-label="Replay position"
          onChange={(e) => {
            setPlaying(false);
            setIndex(Number(e.target.value));
          }}
        />
        <output className="mapatlas-trip-review__cursor">
          {cursor ? `${cursor.lat.toFixed(5)}, ${cursor.lng.toFixed(5)}` : "—"}
        </output>
      </div>

      <ul className="mapatlas-trip-review__events">
        {events.map((ev) => (
          <li key={ev.id}>
            <button
              type="button"
              onClick={() => setSelectedEvent(ev.id)}
              aria-expanded={selectedEvent === ev.id}
            >
              {ev.comment ?? ev.category ?? "Event"} — {ev.media.length} photo
              {ev.media.length === 1 ? "" : "s"}
            </button>
          </li>
        ))}
      </ul>

      {active ? (
        <article
          className="mapatlas-trip-review__detail"
          aria-label="Event detail"
        >
          {active.comment ? <p>{active.comment}</p> : null}
          {active.tags.length > 0 ? (
            <ul className="mapatlas-trip-review__tags">
              {active.tags.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          ) : null}
          <div className="mapatlas-trip-review__photos">
            {active.media.map((m) =>
              previews[m.id] ? (
                <img
                  key={m.id}
                  src={previews[m.id]}
                  alt={active.comment ?? "Event photo"}
                  width={120}
                  height={120}
                />
              ) : (
                <span
                  key={m.id}
                  className="mapatlas-trip-review__photo-missing"
                >
                  (photo)
                </span>
              ),
            )}
          </div>
        </article>
      ) : null}
    </section>
  );
}
