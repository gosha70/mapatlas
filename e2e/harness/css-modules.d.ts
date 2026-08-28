// SPDX-License-Identifier: Apache-2.0

/**
 * Side-effect CSS imports, which the bundler resolves and TypeScript otherwise cannot.
 *
 * The harness loads the renderer's stylesheet the way a consumer does — `api.md` makes that
 * the consumer's job — and the browser lane is typechecked, so the import needs a type.
 */
declare module "*.css";
