// SPDX-License-Identifier: Apache-2.0

/**
 * The demo's persistence, wired the way a consumer wires it.
 *
 * **Two stores, and the separation is the point** (ADR-0016). `StorageAdapter` holds trips,
 * events and media — irreplaceable, and what a sign-out wipe is allowed to take. `MapAssetStore`
 * holds downloaded map bytes — large, replaceable, and the right thing to discard first. Neither
 * `clearAll()` nor `clear()` may reach the other, which is why they are separate databases and
 * not two object stores in one.
 *
 * **Created once per document, not per render.** Both adapters open their connection lazily and
 * memoise it, so constructing a second pair would open a second connection to the same database
 * and leave the first holding a handle that a `deleteDatabase` would then block on. A module
 * constant is the simplest thing that is right; a React context would be ceremony around a value
 * that never changes.
 */

import type { MapAssetStore, StorageAdapter } from "@mapatlas/core";
import { createIdbMapAssetStore, createIdbStorageAdapter } from "@mapatlas/storage-idb";

export interface DemoStorage {
  readonly trips: StorageAdapter;
  readonly assets: MapAssetStore;
}

/**
 * Build the pair.
 *
 * Exported as a factory rather than as a ready-made constant so a test can hold its own, and so
 * nothing opens a database merely by importing this module — which would make every unit test
 * that touches the app need IndexedDB whether it used storage or not.
 */
export function createDemoStorage(): DemoStorage {
  return { trips: createIdbStorageAdapter(), assets: createIdbMapAssetStore() };
}
