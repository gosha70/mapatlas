// SPDX-License-Identifier: Apache-2.0

/**
 * `@mapatlas/core/testing` — first-party test utilities.
 *
 * A separate entry point on purpose: these are useful enough to ship, but they are not part
 * of the production-facing API and have no business in a consumer's normal bundle.
 *
 * Whether the engine's own storage conformance suite becomes public — and if so, in a form
 * that does not drag a consumer onto our test runner — is a decision for T2.1, not one to
 * make by accident here.
 */

export type { MemoryStorageAdapter } from "./memory-storage.js";
export { createMemoryMapAssetStore, createMemoryStorageAdapter } from "./memory-storage.js";
