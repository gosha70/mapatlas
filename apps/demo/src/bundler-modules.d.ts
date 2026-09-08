// SPDX-License-Identifier: Apache-2.0

/**
 * Types for the two bundler-resolved imports the MapLibre bootstrap needs.
 *
 * Both are the consumer's job per `api.md`, and both are virtual modules with no types of their
 * own: the stylesheet is a side-effect import, and `?worker&url` resolves to a served URL rather
 * than a module. `e2e/harness` carries the same pair for the same reason — declared here too
 * rather than shared, since the demo is what a consumer's project looks like and a consumer
 * would write these themselves.
 */

declare module "*.css";

declare module "*?worker&url" {
  const url: string;
  export default url;
}

/**
 * The build-time constant the root route reads.
 *
 * `import.meta.env` is vite's, replaced at build time; the full `vite/client` types are not
 * pulled in because this is a consumer's app and it uses exactly this much of them.
 */
interface ImportMetaEnv {
  /** True in a `vite build` bundle, false under the dev server. */
  readonly PROD: boolean;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
