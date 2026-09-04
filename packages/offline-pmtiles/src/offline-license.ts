// SPDX-License-Identifier: Apache-2.0

import type { TileSource } from "@mapatlas/core";

/**
 * A region named a source whose terms do not permit bulk download (ADR-0033).
 *
 * Carries the offending `sourceId` because a region may name several and the consumer has to
 * know which one to annotate — or to stop pointing at.
 */
export class OfflineLicenseError extends Error {
  readonly sourceId: string;

  constructor(sourceId: string) {
    super(
      `tile source ${JSON.stringify(sourceId)} is not marked offlineLicensed, so it may not be ` +
        `downloaded for offline use. Absence is refusal, not permission: architecture.md §8 ` +
        `requires an explicitly offline-licensed or self-hosted source, and that binds demos ` +
        `and tests as well as production.`,
    );
    this.name = "OfflineLicenseError";
    this.sourceId = sourceId;
  }
}

/**
 * Refuse any requested source that is not explicitly offline-licensed.
 *
 * **One function, two callers.** `download()` and `estimateSize()` both reach this, because a
 * UI able to quote a size for a region the store will then refuse has already misled its user.
 * A second implementation of the same rule is the drift this codebase keeps removing.
 *
 * An unknown `sourceId` is refused as well: a region naming a source the store was never given
 * cannot be shown to be licensed, and "not provable" and "not permitted" are the same answer
 * where the failure is a third-party policy violation.
 */
export function assertOfflineLicensed(
  sources: readonly TileSource[],
  sourceIds: readonly string[],
): void {
  for (const id of sourceIds) {
    const source = sources.find((candidate) => candidate.id === id);
    if (source?.offlineLicensed !== true) throw new OfflineLicenseError(id);
  }
}
