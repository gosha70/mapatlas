// SPDX-License-Identifier: Apache-2.0

/**
 * `@mapatlas/core/testing` — test utilities kept out of the runtime surface.
 *
 * These depend on Vitest and are meant to be imported from test files only.
 */
export {
  runStorageAdapterConformance,
  type MakeAdapter,
} from "./storage-conformance.js";
