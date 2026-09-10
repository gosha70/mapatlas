// SPDX-License-Identifier: Apache-2.0

/**
 * The two bundler-resolved imports MapLibre's bootstrap needs.
 *
 * Both are the consumer's job — the stylesheet is a side-effect import, and `?worker&url`
 * resolves to a served URL rather than to a module — and neither has types of its own. Declared
 * here rather than by depending on `vite/client`, which would pull an ambient type package in
 * for exactly these two lines.
 */

declare module "*.css";

declare module "*?worker&url" {
  const url: string;
  export default url;
}
