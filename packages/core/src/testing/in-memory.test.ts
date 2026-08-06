// SPDX-License-Identifier: Apache-2.0

/**
 * T2.1 acceptance: the reusable conformance suite passes against the reference
 * in-memory adapter. Downstream adapters (e.g. IndexedDB, T2.2) reuse the same
 * suite from `@mapatlas/core/testing`.
 */
import { InMemoryStorageAdapter } from "../fake-storage.js";
import { runStorageAdapterConformance } from "./storage-conformance.js";

runStorageAdapterConformance(
  "InMemoryStorageAdapter",
  () => new InMemoryStorageAdapter(),
);
