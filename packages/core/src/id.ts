// SPDX-License-Identifier: Apache-2.0
import type { Id } from "./types";

/**
 * ULID generator: a 48-bit millisecond timestamp followed by 80 bits of
 * randomness, Crockford base32. Lexicographically sortable, dependency-free,
 * and DOM-free so it runs unchanged in Node and the browser.
 */
const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ENCODING_LEN = 32;
const TIME_LEN = 10;
const RANDOM_LEN = 16;

/** Total character length of a generated id. */
export const ID_LENGTH = TIME_LEN + RANDOM_LEN;

function encodeTime(ms: number): string {
  let out = "";
  let t = Math.floor(ms);
  for (let i = 0; i < TIME_LEN; i++) {
    const mod = t % ENCODING_LEN;
    out = ENCODING.charAt(mod) + out;
    t = (t - mod) / ENCODING_LEN;
  }
  return out;
}

function encodeRandom(rnd: () => number): string {
  let out = "";
  for (let i = 0; i < RANDOM_LEN; i++) {
    out += ENCODING.charAt(Math.floor(rnd() * ENCODING_LEN));
  }
  return out;
}

/** Generate a fresh, lexicographically sortable id. */
export function newId(): Id {
  return encodeTime(Date.now()) + encodeRandom(Math.random);
}
