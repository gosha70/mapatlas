// SPDX-License-Identifier: Apache-2.0

import type { JSONValue } from "./json.js";

/**
 * The slice of GeoJSON (RFC 7946) this engine emits and reads, declared structurally.
 *
 * Declared rather than depended on: `core` has no runtime dependencies, and a types-only
 * package would still be a dependency to keep current for a handful of shapes. Anything
 * produced here is ordinary GeoJSON that any reader will accept.
 */

/** `[lng, lat]` or `[lng, lat, altitude]` — RFC 7946 §3.1.1 order, longitude first. */
export type Position = [lng: number, lat: number] | [lng: number, lat: number, alt: number];

export interface MultiLineString {
  type: "MultiLineString";
  /** One line per track segment. */
  coordinates: Position[][];
}

export interface Point {
  type: "Point";
  coordinates: Position;
}

export interface Feature<G, P> {
  type: "Feature";
  geometry: G;
  properties: P;
}

export interface FeatureCollection<F> {
  type: "FeatureCollection";
  features: F[];
}

/** Anything that survives `JSON.stringify` — what a properties bag may hold. */
export type Properties = Record<string, JSONValue>;
