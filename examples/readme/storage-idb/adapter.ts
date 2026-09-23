// SPDX-License-Identifier: Apache-2.0
import type { Track } from "@mapatlas/core";
import { createIdbStorageAdapter } from "@mapatlas/storage-idb";

// The default persistence: IndexedDB, opened lazily on first use, under a name you choose.
export const store = createIdbStorageAdapter({ databaseName: "my-field-app" });

export async function keep(track: Track): Promise<Track | undefined> {
  await store.saveTrack(track);
  return store.getTrack(track.id);
}
