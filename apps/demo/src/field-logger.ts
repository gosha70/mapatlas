// SPDX-License-Identifier: Apache-2.0

/**
 * The generic field-logger wiring (tasks T7.1), framework-agnostic so the
 * record → pin → photo → review → export loop is unit-testable without a browser.
 *
 * It composes only MAP-ATLAS seams: a {@link StorageAdapter} (durable, so a
 * trip survives reload), a {@link TrackRecorder} (defaulting to the web
 * recorder), a {@link MediaAnalyzer} slot (defaulting to {@link noopAnalyzer}),
 * and an optional {@link OfflineRegionStore}. There is no domain knowledge here —
 * events carry neutral `comment`/`tags`/`fields` only.
 */
import type {
  Id,
  LatLng,
  MapEvent,
  MediaAnalyzer,
  MediaRef,
  OfflineRegionStore,
  StorageAdapter,
  Track,
} from "@mapatlas/core";
import {
  EventLog,
  createWebTrackRecorder,
  newId,
  noopAnalyzer,
  trackToGeoJSON,
} from "@mapatlas/core";
import type { TrackRecorder } from "@mapatlas/core";

export interface FieldLoggerDeps {
  storage: StorageAdapter;
  recorder?: TrackRecorder;
  /** analyzer slot — defaults to the no-op analyzer */
  analyzer?: MediaAnalyzer;
  offline?: OfflineRegionStore;
}

export interface PhotoDraft {
  blob: Blob;
  mime?: string;
}

export interface EventDraft {
  at: LatLng;
  comment?: string;
  tags?: string[];
  photos?: PhotoDraft[];
}

export interface Trip {
  track: Track;
  events: MapEvent[];
}

export class FieldLogger {
  readonly analyzer: MediaAnalyzer;
  readonly offline: OfflineRegionStore | undefined;
  private readonly storage: StorageAdapter;
  private readonly recorder: TrackRecorder;
  private readonly log: EventLog;
  private activeTrackId: Id | undefined;

  constructor(deps: FieldLoggerDeps) {
    this.storage = deps.storage;
    this.analyzer = deps.analyzer ?? noopAnalyzer;
    this.offline = deps.offline;
    this.recorder = deps.recorder ?? createWebTrackRecorder(deps.storage);
    this.log = new EventLog(deps.storage);
  }

  get status(): TrackRecorder["status"] {
    return this.recorder.status;
  }

  get currentTrackId(): Id | undefined {
    return this.activeTrackId;
  }

  start(): Promise<void> {
    return this.recorder.start();
  }

  /** Finalize the recording and persist it; the track becomes the active trip. */
  async stop(): Promise<Track> {
    const track = await this.recorder.stop();
    await this.storage.saveTrack(track);
    this.activeTrackId = track.id;
    return track;
  }

  /** Pin an event (with optional persisted photos) at a position. */
  async addEvent(draft: EventDraft): Promise<MapEvent> {
    const media: MediaRef[] = [];
    for (const photo of draft.photos ?? []) {
      const blobKey = await this.storage.putBlob(photo.blob);
      media.push({
        id: newId(),
        mime: photo.mime ?? photo.blob.type ?? "image/jpeg",
        blobKey,
      });
    }
    const input: Omit<MapEvent, "id"> = {
      position: draft.at,
      occurredAt: Date.now(),
      media,
      tags: draft.tags ?? [],
    };
    if (draft.comment && draft.comment.trim()) {
      input.comment = draft.comment.trim();
    }
    if (this.activeTrackId) input.trackId = this.activeTrackId;
    return this.log.create(input);
  }

  events(trackId?: Id): Promise<MapEvent[]> {
    return this.log.list(trackId ?? this.activeTrackId);
  }

  /** Load a finalized trip (track + its events) for review. */
  async loadTrip(trackId: Id): Promise<Trip | undefined> {
    const track = await this.storage.getTrack(trackId);
    if (!track) return undefined;
    const events = await this.log.list(trackId);
    return { track, events };
  }

  /** Resolve a photo `blobKey` to an object URL for display (review). */
  async photoUrl(ref: MediaRef): Promise<string | undefined> {
    if (ref.url) return ref.url;
    if (!ref.blobKey) return undefined;
    const blob = await this.storage.getBlob(ref.blobKey);
    if (!blob) return undefined;
    return typeof URL?.createObjectURL === "function"
      ? URL.createObjectURL(blob)
      : undefined;
  }

  /** Export a trip as a GeoJSON FeatureCollection (media by reference). */
  async exportGeoJSON(trackId?: Id): Promise<GeoJSON.FeatureCollection> {
    const id = trackId ?? this.activeTrackId;
    if (!id) throw new Error("No trip to export.");
    const trip = await this.loadTrip(id);
    if (!trip) throw new Error(`Unknown trip: ${id}`);
    return trackToGeoJSON(trip.track, trip.events);
  }
}
