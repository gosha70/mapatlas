// SPDX-License-Identifier: Apache-2.0

import type { Id } from "./types.js";

/**
 * Identifier + small utility helpers.
 *
 * `newId` prefers the platform Web Crypto `randomUUID` (available in Node ≥19
 * and every modern browser). A deterministic, non-cryptographic fallback keeps
 * the engine usable in constrained runtimes — it is never used when crypto is
 * present. No DOM globals are referenced (isolation scan stays green).
 */
interface RandomUUID {
  randomUUID(): string;
}

function getCrypto(): RandomUUID | undefined {
  const c = (globalThis as { crypto?: Partial<RandomUUID> }).crypto;
  return typeof c?.randomUUID === "function" ? (c as RandomUUID) : undefined;
}

let fallbackCounter = 0;

/** Generate a new opaque identifier. */
export function newId(): Id {
  const c = getCrypto();
  if (c) return c.randomUUID();
  // Fallback: time + counter + random suffix. Not cryptographically strong.
  fallbackCounter = (fallbackCounter + 1) % 0xffffff;
  const rand = Math.floor(Math.random() * 0xffffffff).toString(16);
  return `id-${Date.now().toString(16)}-${fallbackCounter.toString(16)}-${rand}`;
}

/** Clamp a number into an inclusive range. */
export function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}

/** Degrees → radians. */
export function toRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}
