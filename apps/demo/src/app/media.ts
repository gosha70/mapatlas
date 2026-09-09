// SPDX-License-Identifier: Apache-2.0

/**
 * Giving back the blobs an unsaved event was carrying.
 *
 * **One home, because the obligation is one obligation.** `EventComposer` seals itself before it
 * invokes `onSave`, and from the instant `onSave` receives a `blobKey` the consumer owns those
 * bytes — the composer never deletes them again, unmount included (ADR-0027). So whenever an
 * event write rejects, nothing references the blob and nothing else will ever collect it. Both
 * the recorded loop and the authoring flow take events through a composer, so both incur it; two
 * copies would be two chances for one to be edited into a version that leaks.
 *
 * A delete that itself fails is reported as **unconfirmed** rather than swallowed or retried: the
 * bytes may or may not still be there, and claiming either would be a guess.
 */

import type { MediaRef, StorageAdapter } from "@mapatlas/core";

export async function releaseMedia(
  store: StorageAdapter,
  media: readonly MediaRef[],
): Promise<string | undefined> {
  const stranded: string[] = [];
  for (const item of media) {
    if (item.blobKey === undefined) continue;
    try {
      await store.deleteBlob(item.blobKey);
    } catch {
      stranded.push(item.blobKey);
    }
  }
  return stranded.length === 0 ? undefined : `${String(stranded.length)} photo left unconfirmed`;
}
