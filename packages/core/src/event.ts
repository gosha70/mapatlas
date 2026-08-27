// SPDX-License-Identifier: Apache-2.0

import type { LatLng } from "./geo.js";
import type { Id } from "./ids.js";
import type { JSONValue } from "./json.js";

/** Analyzer output. The engine stores and displays it; it never interprets label meaning. */
export interface MediaAnalysis {
  labels: { label: string; confidence: number }[];
  summary?: string;
  model?: string;
  raw?: JSONValue;
}

export interface MediaRef {
  id: Id;
  mime: string;
  width?: number;
  height?: number;
  /** Key into the StorageAdapter blob store. */
  blobKey?: string;
  /** Alternative to `blobKey` for already-hosted media. */
  url?: string;
  analysis?: MediaAnalysis;
}

/**
 * A pinned moment: where something happened, when, and whatever the consumer wants to
 * say about it.
 *
 * `tags`, `category` and `fields` are the domain seam in the data: the consumer's own
 * vocabulary goes in these bags, and the engine stores it without ever learning what any
 * of it means. Worked examples live in specs/PRD.md — deliberately not here, because the
 * isolation scan rejects domain vocabulary in engine source, comments included. (ADR-0001)
 */
export interface MapEvent {
  id: Id;
  trackId?: Id;
  position: LatLng;
  occurredAt: number;
  comment?: string;
  media: MediaRef[];
  tags: string[];
  /** The renderer's presentation seam keys off this. (ADR-0012) */
  category?: string;
  /** Consumer-defined domain data. */
  fields?: Record<string, JSONValue>;
}
