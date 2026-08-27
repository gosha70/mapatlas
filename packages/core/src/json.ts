// SPDX-License-Identifier: Apache-2.0

/** Anything that survives a JSON round-trip. Consumer-defined data rides in these. */
export type JSONValue = null | boolean | number | string | JSONValue[] | { [k: string]: JSONValue };
