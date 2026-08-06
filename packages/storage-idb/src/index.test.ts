// SPDX-License-Identifier: Apache-2.0

/**
 * T2.2 acceptance: the IndexedDB adapter passes the reusable conformance suite
 * from `@mapatlas/core/testing`, run against `fake-indexeddb` so nothing touches
 * a real browser database. Each adapter gets a uniquely-named DB for isolation.
 */
// `fake-indexeddb/auto` registers IndexedDB globals (IDBRequest, IDBDatabase,
// …) that idb's `wrap` inspects. Each adapter still gets its own IDBFactory
// instance and a unique DB name for full isolation between tests.
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { runStorageAdapterConformance } from "@mapatlas/core/testing";
import { IdbStorageAdapter } from "./index.js";

let counter = 0;

runStorageAdapterConformance(
  "IdbStorageAdapter (fake-indexeddb)",
  () =>
    new IdbStorageAdapter({
      dbName: `mapatlas-test-${counter++}`,
      indexedDB: new IDBFactory(),
    }),
);
