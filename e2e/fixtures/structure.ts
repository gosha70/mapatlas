// SPDX-License-Identifier: Apache-2.0

/**
 * Comparing two documents by **shape**, never by value.
 *
 * **Why this exists.** T7.1b's criterion is that a hand-drawn trip is *"byte-for-byte the same
 * shape as a recorded one: same review, same stats, same export"*, and ADR-0014 states what that
 * contracts: *"review, stats, export, offline, and presentation work on an authored track with no
 * special cases — the only difference is one enum field."* Read as value equality it is
 * unsatisfiable — two independently produced trips differ in ids, coordinates, timestamps and
 * `trackId` references, all legitimately — and a test chasing it gets whittled, field by field,
 * into a spot-check of whatever survived. So the comparison is over the set of key paths and the
 * type at each, and provenance is asserted separately by value.
 *
 * **Array length is a value, not a structure.** Two trips have different numbers of points; a
 * comparison that noticed would fail for a reason the criterion does not care about. So every
 * element of an array is visited under the same `[]` path and the results are unioned — which
 * also means a field present on *some* elements is present in the structure, which is exactly
 * what makes a GPS field that only recorded points carry visible here.
 */

/** `null` and arrays are their own kinds: `typeof` calls both "object" and would hide both. */
const typeOf = (value: unknown): string =>
  value === null ? "null" : Array.isArray(value) ? "array" : typeof value;

/**
 * Every `path:type` the document contains, with array indices collapsed to `[]`.
 *
 * The root is `":object"` — an entry rather than a special case, so a document that is an array
 * where the other is an object differs at the root rather than silently comparing their innards.
 */
export function structureOf(document: unknown): Set<string> {
  const found = new Set<string>();
  const visit = (value: unknown, at: string): void => {
    found.add(`${at}:${typeOf(value)}`);
    if (Array.isArray(value)) {
      for (const item of value) visit(item, `${at}[]`);
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        visit(item, at === "" ? key : `${at}.${key}`);
      }
    }
  };
  visit(document, "");
  return found;
}

export interface StructureOptions {
  /**
   * Paths whose presence is allowed to differ, **named in full and declared before the comparison
   * is written**.
   *
   * This is not an escape hatch discovered while debugging a red test: a difference this
   * tolerates is one the caller has stated, in advance, that it is not claiming anything about.
   *
   * **A declaration covers the path and everything under it**, type differences included — a
   * declaration is a statement that the two documents are not compared in that subtree at all.
   * That is not tidiness: the same field can be a number in one place and an array of numbers in
   * another (a GeoJSON export carries a track's per-point values as arrays), so a declaration
   * that reached only the exact path would leave `accuracyM[]` and `accuracyM[][]` to be
   * enumerated by hand — an enumeration nobody can check and everybody would grow by adding
   * whatever the last red run printed.
   *
   * The boundary is a real path boundary: `points[].accuracyM` covers `points[].accuracyM[]` and
   * `points[].accuracyM.x`, and does **not** cover `points[].accuracyMore`.
   */
  readonly optional: readonly string[];
}

const pathOf = (entry: string): string => entry.slice(0, entry.lastIndexOf(":"));

/** At the declared path, or beneath it — never merely starting with the same characters. */
const covered = (path: string, declared: readonly string[]): boolean =>
  declared.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}.`) || path.startsWith(`${prefix}[`),
  );

/**
 * What one document has that the other does not, in both directions.
 *
 * Empty means the two have the same keys, nested the same way, holding the same kinds of thing.
 * It says nothing whatever about what they hold.
 */
export function structuralDifference(
  a: unknown,
  b: unknown,
  { optional }: StructureOptions,
): string[] {
  const left = structureOf(a);
  const right = structureOf(b);
  const only = (from: Set<string>, other: Set<string>, side: string): string[] =>
    [...from]
      .filter((entry) => !other.has(entry) && !covered(pathOf(entry), optional))
      .map((entry) => `only in ${side}: ${entry}`);
  return [...only(left, right, "a"), ...only(right, left, "b")].sort();
}
