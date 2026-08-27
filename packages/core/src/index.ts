// SPDX-License-Identifier: Apache-2.0

/**
 * `@mapatlas/core` — the framework-agnostic engine.
 *
 * This package depends on nothing: no renderer, no React, no DOM, no consumer
 * domain. Everything variable is an interface here and implemented elsewhere.
 * See specs/architecture.md §1 for the rule and scripts/scan-isolation.mjs for
 * its enforcement.
 */

/** Package identity, used by consumers to report which engine build they embed. */
export const PACKAGE_NAME = "@mapatlas/core";
