// SPDX-License-Identifier: Apache-2.0
import type {
  Id,
  MapEvent,
  MediaAnalysis,
  Track,
  TrackPoint,
  TrackStatus,
} from "./types";
import type { SamplingPolicy } from "./sampling";

/**
 * Persistence seam (specs/api.md §3). The default implementation ships in
 * @mapatlas/storage-idb; consumers may supply any conformant adapter.
 */
export interface StorageAdapter {
  saveTrack(t: Track): Promise<void>;
  getTrack(id: Id): Promise<Track | undefined>;
  listTracks(): Promise<Track[]>;
  deleteTrack(id: Id): Promise<void>;

  saveEvent(e: MapEvent): Promise<void>;
  getEvent(id: Id): Promise<MapEvent | undefined>;
  listEvents(trackId?: Id): Promise<MapEvent[]>;
  deleteEvent(id: Id): Promise<void>;

  /** Store blob bytes, returning a `blobKey`. */
  putBlob(blob: Blob): Promise<string>;
  getBlob(key: string): Promise<Blob | undefined>;
  deleteBlob(key: string): Promise<void>;

  /** Wipe everything — consumers call this on sign-out to leave no local data. */
  clearAll(): Promise<void>;
}

/** AI analyzer seam (specs/api.md §4). */
export interface AnalyzeInput {
  /** the photo bytes... */
  blob?: Blob;
  /** ...or a reference to already-hosted media */
  url?: string;
  /** optional consumer context */
  hint?: { tags?: string[]; category?: string };
}

export interface MediaAnalyzer {
  /** e.g. "onnx-yolo-v8", "remote-vision-llm" */
  readonly id: string;
  /** true ⇒ egress; consumer must disclose/gate */
  readonly runsRemotely: boolean;
  analyze(input: AnalyzeInput): Promise<MediaAnalysis>;
}

/**
 * No-op analyzer shipped in v1 so the analysis code path is testable without a
 * model. It performs no egress and returns an empty label set.
 */
export const noopAnalyzer: MediaAnalyzer = {
  id: "noop",
  runsRemotely: false,
  analyze(): Promise<MediaAnalysis> {
    return Promise.resolve({ labels: [] });
  },
};

/** Basemap / overlay tile source (specs/api.md §5). */
export interface TileSource {
  id: string;
  kind: "xyz" | "wms" | "pmtiles";
  /** template, WMS endpoint, or .pmtiles location */
  url: string;
  /** rendered verbatim (license compliance) */
  attribution: string;
  opacity?: number;
  minZoom?: number;
  maxZoom?: number;
}

export interface OfflineRegion {
  id: Id;
  name: string;
  bbox: [west: number, south: number, east: number, north: number];
  minZoom: number;
  maxZoom: number;
  sizeBytes?: number;
  downloadedAt?: number;
}

export interface OfflineRegionStore {
  download(
    region: Omit<OfflineRegion, "id" | "sizeBytes" | "downloadedAt">,
    onProgress?: (fraction: number) => void,
  ): Promise<OfflineRegion>;
  list(): Promise<OfflineRegion[]>;
  delete(id: Id): Promise<void>;
  estimateSize(
    region: Pick<OfflineRegion, "bbox" | "minZoom" | "maxZoom">,
  ): Promise<number>;
}

/** Geolocation recorder seam (specs/api.md §2). */
export type TrackRecorderErrorKind =
  "permission-denied" | "position-unavailable" | "timeout" | "unsupported";

export interface TrackRecorderError {
  kind: TrackRecorderErrorKind;
  message: string;
}

export interface TrackRecorder {
  readonly status: TrackStatus;
  start(opts?: Partial<SamplingPolicy>): Promise<void>;
  pause(): void;
  resume(): void;
  /** finalizes: simplify + distance */
  stop(): Promise<Track>;
  /** Subscribe to kept points (post-sampling). Returns an unsubscribe fn. */
  onPoint(cb: (p: TrackPoint) => void): () => void;
  onError(cb: (e: TrackRecorderError) => void): () => void;
}
