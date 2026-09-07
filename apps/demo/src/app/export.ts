// SPDX-License-Identifier: Apache-2.0

/**
 * Exporting a finished trip — T7.1 increment 3.
 *
 * **What goes in the file, and why it is a bare `FeatureCollection`.** `trackToGeoJSON` returns a
 * `TrackExport`: the collection plus a media *manifest*. Only the collection is written here, and
 * that is a decision rather than an omission — `geoJSONToTrack` reads `exported.geojson` and
 * nothing else, reconstructing each event's `MediaRef`s from the event feature's own properties.
 * The manifest is a summary for whoever has to gather the bytes, not an input to import. Writing
 * a wrapper object around the collection would have produced a file that round-trips and is not
 * GeoJSON, which fails the criterion in the one way a passing round-trip test would never show.
 *
 * **Media travels by reference (api.md §10).** The photo bytes are *not* in this file; the event
 * carries a `blobKey` into the store that wrote it. A consumer moving a trip between devices has
 * to carry the blobs too, and the manifest is what tells them which. The demo reports its size so
 * that obligation is visible rather than discovered later.
 *
 * **Split from the DOM on purpose.** `buildTripExport` is a pure function over the model, so what
 * the file *contains* is decidable without a document; `downloadDocument` is the browser half.
 * A single function doing both would only be assertable where there is a DOM, which is the lane
 * least able to say anything about correctness of content.
 */

import { trackToGeoJSON } from "@mapatlas/core";
import type { MapEvent, MediaManifestEntry, Track } from "@mapatlas/core";

export interface TripExport {
  /** The file's name: the start time for sorting, the track id for uniqueness. */
  readonly filename: string;
  /** The file's bytes, as text: a GeoJSON `FeatureCollection`. */
  readonly json: string;
  /**
   * What the collection references but does not contain.
   *
   * Surfaced rather than dropped: a consumer who exports a trip with photos and moves only the
   * `.geojson` has moved a document whose media references resolve to nothing, and the count is
   * the cheapest thing that says so before it happens.
   */
  readonly media: readonly MediaManifestEntry[];
}

/** `2026-09-07T13-00-45` — filename-safe, sorts chronologically, and is not locale-dependent. */
function stamp(at: number): string {
  return new Date(at)
    .toISOString()
    .replace(/\.\d+Z$/, "")
    .replace(/:/g, "-");
}

/**
 * The trip's id, reduced to characters a filename can hold.
 *
 * **The timestamp alone is not unique.** It is second-resolution, so two trips begun within the
 * same second produce the same name — and a downloads folder resolves that by silently
 * overwriting or by appending `(1)`, neither of which says that two different trips were
 * involved. The id is what makes the name unique; the timestamp is what makes it sort and what
 * makes it mean something to a person reading the folder.
 */
function slug(id: string): string {
  const safe = id.replace(/[^A-Za-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe === "" ? "trip" : safe;
}

export function buildTripExport(track: Track, events: readonly MapEvent[]): TripExport {
  const exported = trackToGeoJSON(track, events);
  return {
    filename: `trip-${stamp(track.startedAt)}-${slug(track.id)}.geojson`,
    // Two-space indented: a portability format a person may open in an editor, and the
    // determinism api.md §10 promises is a property of the value, not of its whitespace.
    json: JSON.stringify(exported.geojson, null, 2),
    media: exported.media,
  };
}

/**
 * Hand the file to the browser.
 *
 * The object URL is revoked in a `finally`. An un-revoked URL pins the whole blob in memory for
 * the life of the document, and a field logger exporting repeatedly is exactly the shape that
 * turns that into a leak nobody attributes to export.
 */
export function downloadDocument(doc: TripExport, host: Document = document): void {
  const url = URL.createObjectURL(new Blob([doc.json], { type: "application/geo+json" }));
  try {
    const link = host.createElement("a");
    link.href = url;
    link.download = doc.filename;
    // Appended before clicking: a detached anchor's click is ignored by some browsers, which
    // fails silently and looks exactly like a user who declined the save dialog.
    host.body.append(link);
    link.click();
    link.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}
