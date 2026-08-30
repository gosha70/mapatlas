// SPDX-License-Identifier: Apache-2.0

/**
 * Licence obligations for the fixture archive (T4.6, obligation 1; ADR-0024, criterion 3).
 *
 * The ADR's finding is that attribution here is **three strings and a file placement, not one
 * string**: a derived-works notice, because we modify the data; a liability sentence stating
 * that the organisations in charge of Copernicus incur no liability for any use of it; a
 * no-endorsement clause; and a requirement that downstream recipients be bound by the same
 * obligations — which together mean a LICENSE file inside the archive rather than only an
 * on-map credit.
 *
 * What is checked here is the property that makes those obligations real rather than
 * decorative: **every string the build emits must occur verbatim in the licence document it
 * claims to be honouring.** A credit line that has been paraphrased, retyped, or updated for
 * house style is not attribution — it is a sentence that resembles attribution, and nothing
 * downstream would ever object to it.
 *
 * Deliberately not here: any of the strings themselves. They are inputs, read from a
 * version-controlled copy of the licence and a declaration of what the build emits, because a
 * checker that carries its own expected text is checking itself.
 */

export class LicenceError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "LicenceError";
  }
}

/** The roles the ADR requires; a declaration missing any of them is incomplete, not minimal. */
/**
 * Where the licence lives inside the archive.
 *
 * One constant, used by both checks, because they are two halves of one obligation that must
 * agree about this name. Split across the modules — a literal at one call site and a default
 * parameter at the other — they would agree only by coincidence, and renaming it in one place
 * would leave the attribution check excluding an entry that no longer exists. The licence entry
 * would then re-enter the scanned set, every declared string would be found inside it, and the
 * check would pass with nothing emitted: the vacuous pass this exclusion exists to prevent,
 * restored by a rename that looks harmless in a diff.
 */
export const LICENCE_ENTRY_PATH = "LICENSE";

export const REQUIRED_ROLES = Object.freeze([
  "derivedWorksNotice",
  "liabilityStatement",
  "noEndorsement",
  "downstreamBinding",
]);

/**
 * Collapse runs of whitespace so a wrapped licence paragraph still matches a declared sentence.
 *
 * This is the one liberty taken with "verbatim", and it is taken knowingly: a licence document
 * wraps its lines, so a sentence that spans a break would never match a single-line
 * declaration, and requiring the declaration to reproduce the source's line breaks would make
 * it fail on reflowing rather than on meaning. Case, punctuation and wording are untouched.
 *
 * The residual risk is stated rather than hidden: a source that hyphenates across a line break
 * will not match, and should be corrected in the declaration rather than by loosening this.
 *
 * @param {string} text
 * @returns {string}
 */
export function normaliseWhitespace(text) {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Where a declared string stops matching the licence, so a failure is actionable.
 *
 * "Not found" sends someone to read two documents side by side. "Diverges after 61 characters,
 * at ...ESA; all rights" tells them which word was changed.
 *
 * @param {string} needle
 * @param {string} haystack
 * @returns {{ matchedChars: number, context: string }}
 */
export function divergence(needle, haystack) {
  for (let length = needle.length - 1; length > 0; length -= 1) {
    const prefix = needle.slice(0, length);
    if (haystack.includes(prefix)) {
      return { matchedChars: length, context: prefix.slice(-48) };
    }
  }
  return { matchedChars: 0, context: "" };
}

/**
 * @typedef {Record<string, string>} AttributionDeclaration
 */

/**
 * Every declared string must appear verbatim in the licence document.
 *
 * @param {AttributionDeclaration} declared
 * @param {string} licenceText
 * @param {string} [licenceSource]
 * @returns {string[]} the roles checked, in declaration order
 */
export function assertStringsBackedByLicence(declared, licenceText, licenceSource = "the licence") {
  if (declared === null || typeof declared !== "object" || Array.isArray(declared)) {
    throw new LicenceError("attribution declaration must be an object of role to string");
  }
  const licence = normaliseWhitespace(licenceText);
  if (licence === "") {
    throw new LicenceError(
      `${licenceSource} is empty, so every string would "match" it vacuously — a check with ` +
        `nothing to check against passes for the wrong reason`,
    );
  }

  for (const role of REQUIRED_ROLES) {
    if (!Object.hasOwn(declared, role)) {
      throw new LicenceError(
        `attribution declaration is missing "${role}" — the ADR requires all of ` +
          `${REQUIRED_ROLES.join(", ")}, and a missing one is an unmet obligation rather than ` +
          `an omitted nicety`,
      );
    }
  }

  const roles = Object.keys(declared);
  for (const role of roles) {
    const value = declared[role];
    if (typeof value !== "string" || normaliseWhitespace(value) === "") {
      throw new LicenceError(`attribution "${role}" must be a non-empty string`);
    }
    const needle = normaliseWhitespace(value);
    if (!licence.includes(needle)) {
      const { matchedChars, context } = divergence(needle, licence);
      throw new LicenceError(
        `attribution "${role}" does not occur in ${licenceSource}: it diverges after ` +
          `${String(matchedChars)} characters` +
          (context === "" ? "" : `, at "...${context}"`) +
          ` — a paraphrased credit is not attribution`,
      );
    }
  }
  return roles;
}

/**
 * Every declared string must reach the archive, not merely be validated on the way past.
 *
 * The sibling of `assertArchiveCarriesLicence`, and the second half of the same obligation:
 * `specs/tasks.md` requires the strings be *checked against the licence document **and** written
 * into the archive*. Validating a declaration and then not emitting it satisfies the first half
 * while leaving the archive with no attribution at all — and every check would pass, because
 * nothing downstream of the validation ever looks.
 *
 * Deliberately says nothing about *where* in the archive the strings live. That is a question
 * about metadata layout, which the undecided writer owns; this asserts over the same `entries()`
 * surface the licence check uses, so it holds whatever that layout turns out to be.
 *
 * @param {{ entries: () => Iterable<{ path: string, text: string }> }} archive
 * @param {AttributionDeclaration} declared
 */
export function assertArchiveCarriesAttribution(
  archive,
  declared,
  licencePath = LICENCE_ENTRY_PATH,
) {
  const entries = [...archive.entries()];
  // The licence entry is excluded, and that exclusion is the whole check. Every declared
  // string is drawn *from* the licence document, so scanning an archive that carries the
  // licence would find all of them inside it and pass without a single credit having been
  // emitted — a check satisfied by the presence of the very thing it is meant to be
  // independent of. Attribution must appear in addition to the licence, not within it.
  const carrying = entries.filter((entry) => entry.path !== licencePath);
  const emitted = normaliseWhitespace(carrying.map((entry) => entry.text).join(" "));
  const held =
    carrying.length === 0 ? `(only ${licencePath})` : carrying.map((e) => e.path).join(", ");

  for (const role of Object.keys(declared)) {
    const needle = normaliseWhitespace(declared[role]);
    if (emitted.includes(needle)) continue;
    const { matchedChars, context } = divergence(needle, emitted);
    throw new LicenceError(
      `attribution "${role}" never reaches the archive: it diverges after ` +
        `${String(matchedChars)} characters` +
        (context === "" ? "" : `, at "...${context}"`) +
        ` — the archive holds ${held}. A string checked against the licence and then not ` +
        `emitted satisfies half the obligation and leaves recipients with no attribution`,
    );
  }
}

/**
 * The archive must carry the licence itself, not only the credit line.
 *
 * @param {{ entries: () => Iterable<{ path: string, text: string }> }} archive
 * @param {string} licenceText
 * @param {string} expectedPath
 */
export function assertArchiveCarriesLicence(archive, licenceText, expectedPath) {
  const wanted = normaliseWhitespace(licenceText);
  const seen = [];
  for (const entry of archive.entries()) {
    seen.push(entry.path);
    if (entry.path !== expectedPath) continue;
    if (normaliseWhitespace(entry.text) !== wanted) {
      throw new LicenceError(
        `${expectedPath} in the archive is not the licence it should be: it differs from the ` +
          `checked-in document, so recipients would be bound by a text nobody reviewed`,
      );
    }
    return;
  }
  throw new LicenceError(
    `the archive carries no ${expectedPath}: the licence requires downstream recipients be ` +
      `bound by the same obligations, which an on-map credit alone does not do. Present: ` +
      `${seen.length === 0 ? "(nothing)" : seen.join(", ")}`,
  );
}
