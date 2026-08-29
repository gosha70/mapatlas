// SPDX-License-Identifier: Apache-2.0

/**
 * Vite's `?worker&url` suffix, which resolves to a served URL rather than a module.
 *
 * Needed because the browser lane is typechecked and the bundler's virtual modules have no
 * types of their own.
 */
declare module "*?worker&url" {
  const url: string;
  export default url;
}
