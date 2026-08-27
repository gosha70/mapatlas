// SPDX-License-Identifier: Apache-2.0

import type { StorageAdapter } from "./storage.js";
import type { Track } from "./track.js";

/**
 * Find a track a previous session left mid-recording.
 *
 * A recorder configured with `autosaveMs` persists the track as it grows, so a crash, a
 * killed tab, or a phone that simply rebooted costs at most one interval rather than a
 * four-hour trip. On the next start a consumer calls this and offers resume-or-discard.
 * (ADR-0015)
 *
 * A track is interrupted when its `status` is still `recording` or `paused`: finalization
 * is what sets `finalized`, so anything else means nobody finalized it.
 *
 * It reads **summaries, not tracks** — the point of the projection (ADR-0014). A device
 * holding a hundred trips should not deserialize a hundred point arrays to answer a
 * question about status, and only the one candidate is hydrated.
 *
 * The most recently *started* interrupted track wins. More than one should not exist, but
 * a device that crashed twice can hold several, and the newest is the one a person is
 * actually trying to resume.
 */
export async function recoverInterruptedTrack(store: StorageAdapter): Promise<Track | undefined> {
  const summaries = await store.listTrackSummaries();

  const interrupted = summaries
    .filter((summary) => summary.status === "recording" || summary.status === "paused")
    .sort((a, b) => b.startedAt - a.startedAt || b.id.localeCompare(a.id));

  const candidate = interrupted[0];
  if (candidate === undefined) return undefined;

  return store.getTrack(candidate.id);
}

/** Every interrupted track, newest first — for a consumer that wants to offer a choice. */
export async function listInterruptedTracks(store: StorageAdapter): Promise<Track[]> {
  const summaries = await store.listTrackSummaries();

  const interrupted = summaries
    .filter((summary) => summary.status === "recording" || summary.status === "paused")
    .sort((a, b) => b.startedAt - a.startedAt || b.id.localeCompare(a.id));

  const tracks: Track[] = [];
  for (const summary of interrupted) {
    const track = await store.getTrack(summary.id);
    if (track !== undefined) tracks.push(track);
  }
  return tracks;
}
