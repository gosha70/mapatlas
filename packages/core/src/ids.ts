// SPDX-License-Identifier: Apache-2.0

/**
 * Opaque identifiers. The engine never parses an id — but it does rely on one property:
 * ids sort as strings in the order they were **minted**.
 *
 * That is why these are ULIDs rather than UUIDv4: a 48-bit millisecond timestamp followed
 * by 80 bits of randomness, Crockford base32, 26 characters. Within a single millisecond
 * the random component is incremented rather than redrawn, so ids minted in a burst — a
 * segment and its laps, say — still sort in the order they were created.
 *
 * **Mint order is not trip chronology.** A track drawn by hand or imported from a file is
 * minted now while its `startedAt` may be years old, so id order answers "what was added
 * to this device first", never "which trip happened first". Anything user-facing that
 * means chronology — a "recent trips" list above all — must sort or index on
 * `Track.startedAt` explicitly. Do not let a storage adapter substitute one for the other.
 */
export type Id = string;

/** Crockford base32: no I, L, O or U, so an id cannot be misread aloud or typo'd into another. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_CHARS = 10;
const RANDOM_CHARS = 16;
const RANDOM_BYTES = RANDOM_CHARS;

/** Largest timestamp 10 Crockford chars can hold: 2^48 - 1 ms, i.e. the year 10889. */
const MAX_TIME = 281_474_976_710_655;

export const ID_LENGTH = TIME_CHARS + RANDOM_CHARS;

/** Indexing is checked, so read a symbol through one place that proves it exists. */
function symbolAt(index: number): string {
  const symbol = ALPHABET[index];
  if (symbol === undefined) throw new RangeError(`base32 index out of range: ${index}`);
  return symbol;
}

function encodeTime(ms: number): string {
  if (!Number.isInteger(ms) || ms < 0 || ms > MAX_TIME) {
    throw new RangeError(`timestamp out of ULID range: ${ms}`);
  }
  let remaining = ms;
  let out = "";
  for (let i = 0; i < TIME_CHARS; i += 1) {
    out = symbolAt(remaining % 32) + out;
    remaining = Math.floor(remaining / 32);
  }
  return out;
}

/**
 * The slice of Web Crypto this module uses, declared rather than imported.
 *
 * `core` compiles without the DOM lib on purpose, and pulling in Node's types to reach
 * one global would hand it `process` and `Buffer` as well — the isolation rule exists to
 * prevent exactly that. `getRandomValues` is available in Node 18+ and in every browser
 * including insecure contexts, unlike `randomUUID`, which browsers gate behind HTTPS.
 */
interface RandomSource {
  getRandomValues(array: Uint8Array): Uint8Array;
}

function randomSource(): RandomSource {
  const source = (globalThis as { crypto?: Partial<RandomSource> }).crypto;
  if (typeof source?.getRandomValues !== "function") {
    throw new Error(
      "no Web Crypto getRandomValues in this environment; " +
        "pass `random` to createIdFactory to supply your own source",
    );
  }
  return source as RandomSource;
}

function randomChars(): string {
  const bytes = new Uint8Array(RANDOM_BYTES);
  randomSource().getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) {
    // Fold 8 bits into 5. The bias is a known ULID trade-off and harmless here: these are
    // collision-avoidance ids, not secrets.
    out += symbolAt(byte % 32);
  }
  return out;
}

/**
 * Increment a base32 string by one, right to left. Returns undefined on overflow — all
 * 80 random bits exhausted inside one millisecond, which needs 2^80 ids to reach.
 */
function incrementChars(chars: string): string | undefined {
  const out = [...chars];
  for (let i = out.length - 1; i >= 0; i -= 1) {
    const index = ALPHABET.indexOf(out[i] ?? "");
    if (index < 0) throw new RangeError(`not a base32 string: ${chars}`);
    if (index < ALPHABET.length - 1) {
      out[i] = symbolAt(index + 1);
      return out.join("");
    }
    out[i] = symbolAt(0);
  }
  return undefined;
}

export interface IdFactoryOptions {
  /** Clock, injectable so tests can pin time without touching the global one. */
  now?: () => number;
  /** Random component source, injectable for deterministic tests. */
  random?: () => string;
}

/**
 * A monotonic id generator. Prefer the shared {@link newId} unless you need to pin the
 * clock — a test asserting sort order, for instance.
 */
export function createIdFactory(options: IdFactoryOptions = {}): () => Id {
  const now = options.now ?? Date.now;
  const random = options.random ?? randomChars;

  // `undefined` rather than a numeric sentinel: any sentinel in the timestamp's own domain
  // can be produced by a clock, and would then be mistaken for "same millisecond as last".
  let lastTime: number | undefined;
  let lastRandom = "";

  return function nextId(): Id {
    const time = now();
    // Validate before touching any state, so a bad clock cannot leave the factory
    // half-advanced and start emitting out-of-order ids.
    const timeChars = encodeTime(time);

    if (time === lastTime) {
      const incremented = incrementChars(lastRandom);
      if (incremented === undefined) {
        throw new Error("ULID randomness exhausted within a single millisecond");
      }
      lastRandom = incremented;
    } else {
      lastTime = time;
      lastRandom = random();
    }

    return timeChars + lastRandom;
  };
}

/** Mint an id. Chronologically sortable, including within the same millisecond. */
export const newId: () => Id = createIdFactory();
