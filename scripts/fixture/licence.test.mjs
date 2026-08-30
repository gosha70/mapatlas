// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import {
  LicenceError,
  assertArchiveCarriesAttribution,
  REQUIRED_ROLES,
  assertArchiveCarriesLicence,
  assertStringsBackedByLicence,
  divergence,
  normaliseWhitespace,
} from "./licence.mjs";

/**
 * A stand-in licence, not the real one.
 *
 * The real document is an input the build reads, and this suite deliberately does not embed
 * it: a checker tested against the text it will check would be asserting that a constant
 * equals itself. What is under test is the *rule* — verbatim occurrence, all roles present,
 * the archive carrying the document — which a synthetic licence exercises exactly as well.
 */
const LICENCE = `
  Terms of use.

  Produced using Copernicus WorldDEM-30 (c) DLR e.V. 2010-2014 and (c) Airbus Defence
  and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA;
  all rights reserved.

  The organisations in charge of the Copernicus programme incur no liability of any
  kind with respect to any use of the data.

  Nothing here implies endorsement by the European Union or ESA.

  Recipients of the data are bound by the same obligations.
`;

const DECLARED = {
  derivedWorksNotice:
    "Produced using Copernicus WorldDEM-30 (c) DLR e.V. 2010-2014 and (c) Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved.",
  liabilityStatement:
    "The organisations in charge of the Copernicus programme incur no liability of any kind with respect to any use of the data.",
  noEndorsement: "Nothing here implies endorsement by the European Union or ESA.",
  downstreamBinding: "Recipients of the data are bound by the same obligations.",
};

const archiveOf = (entries) => ({ entries: () => entries });

describe("every emitted string is backed by the licence", () => {
  it("accepts declarations whose text occurs in the document", () => {
    expect(assertStringsBackedByLicence(DECLARED, LICENCE)).toEqual(REQUIRED_ROLES);
  });

  it("matches across the document's line wrapping", () => {
    // The derived-works notice spans three wrapped lines in the source. Requiring the
    // declaration to reproduce those breaks would make it fail on reflowing rather than on
    // meaning, so runs of whitespace collapse on both sides — and nothing else does.
    expect(LICENCE).toContain("Airbus Defence\n");
    expect(() => assertStringsBackedByLicence(DECLARED, LICENCE)).not.toThrow();
  });

  it("rejects a paraphrase, however faithful", () => {
    // The whole point of the obligation. "(c)" changed to "©" is a better-looking credit and
    // a different string, and nothing downstream would ever complain about it.
    const paraphrased = {
      ...DECLARED,
      derivedWorksNotice: DECLARED.derivedWorksNotice.replace("(c) DLR", "© DLR"),
    };
    expect(() => assertStringsBackedByLicence(paraphrased, LICENCE)).toThrow(LicenceError);
  });

  it("rejects a case change, which is a different string in a legal text", () => {
    // Only whitespace runs are normalised. Lower-casing an organisation's name reads as a
    // typographic tidy-up and changes who the notice names; a case-insensitive match would
    // accept it, so this pins the distinction the normalisation deliberately does not make.
    const recased = {
      ...DECLARED,
      noEndorsement: DECLARED.noEndorsement.replace("European Union", "european union"),
    };
    expect(() => assertStringsBackedByLicence(recased, LICENCE)).toThrow(LicenceError);
  });

  it("says where the string stopped matching, not merely that it did not", () => {
    const altered = {
      ...DECLARED,
      liabilityStatement: DECLARED.liabilityStatement.replace("no liability", "limited liability"),
    };
    let message = "";
    try {
      assertStringsBackedByLicence(altered, LICENCE);
    } catch (error) {
      message = error.message;
    }
    expect(message).toContain("diverges after");
    expect(message).toContain("incur");
  });

  it.each(REQUIRED_ROLES)("refuses a declaration missing %s", (role) => {
    const rest = Object.fromEntries(Object.entries(DECLARED).filter(([key]) => key !== role));
    expect(() => assertStringsBackedByLicence(rest, LICENCE)).toThrow(new RegExp(role));
  });

  it("refuses an empty string for a role rather than matching everything", () => {
    // An empty needle is a substring of every document, so a blank role would pass while
    // emitting nothing — the obligation met on paper and unmet in the archive.
    expect(() =>
      assertStringsBackedByLicence({ ...DECLARED, noEndorsement: "   " }, LICENCE),
    ).toThrow(LicenceError);
  });

  it("refuses an empty licence rather than letting everything match it", () => {
    expect(() => assertStringsBackedByLicence(DECLARED, "   \n  ")).toThrow(/vacuously/);
  });

  it("checks strings beyond the required roles when a declaration carries them", () => {
    const extra = { ...DECLARED, extraCredit: "Not present in the document." };
    expect(() => assertStringsBackedByLicence(extra, LICENCE)).toThrow(/extraCredit/);
  });
});

describe("the archive carries the licence, not only a credit", () => {
  it("accepts an archive whose LICENSE is the checked-in document", () => {
    expect(() =>
      assertArchiveCarriesLicence(
        archiveOf([{ path: "LICENSE", text: LICENCE }]),
        LICENCE,
        "LICENSE",
      ),
    ).not.toThrow();
  });

  it("fails when the archive has no LICENSE, and says what it does have", () => {
    let message = "";
    try {
      assertArchiveCarriesLicence(
        archiveOf([{ path: "dem.pmtiles", text: "" }]),
        LICENCE,
        "LICENSE",
      );
    } catch (error) {
      message = error.message;
    }
    expect(message).toContain("carries no LICENSE");
    expect(message).toContain("dem.pmtiles");
  });

  it("fails when the archive's LICENSE differs from the document", () => {
    expect(() =>
      assertArchiveCarriesLicence(
        archiveOf([{ path: "LICENSE", text: "Do whatever you like." }]),
        LICENCE,
        "LICENSE",
      ),
    ).toThrow(/nobody reviewed/);
  });
});

describe("attribution must reach the archive, in addition to the licence", () => {
  const carrying = (extra) => archiveOf([{ path: "LICENSE", text: LICENCE }, ...extra]);

  it("accepts an archive that emits every declared string outside the licence", () => {
    expect(() =>
      assertArchiveCarriesAttribution(
        carrying([{ path: "metadata.json", text: Object.values(DECLARED).join(" ") }]),
        DECLARED,
      ),
    ).not.toThrow();
  });

  it("does not count the licence entry as attribution", () => {
    // The vacuous pass this exclusion exists to prevent: every declared string is drawn from
    // the licence, so an archive carrying the licence contains all of them — and a scan over
    // every entry would pass with no credit emitted at all.
    let message = "";
    try {
      assertArchiveCarriesAttribution(carrying([]), DECLARED);
    } catch (error) {
      message = error.message;
    }
    expect(message).toContain("never reaches the archive");
    expect(message).toContain("only LICENSE");
  });

  it("names the role that is missing and what the archive did hold", () => {
    const partial = { ...DECLARED };
    const emitted = Object.entries(partial)
      .filter(([role]) => role !== "noEndorsement")
      .map(([, value]) => value)
      .join(" ");
    let message = "";
    try {
      assertArchiveCarriesAttribution(
        carrying([{ path: "metadata.json", text: emitted }]),
        partial,
      );
    } catch (error) {
      message = error.message;
    }
    expect(message).toContain("noEndorsement");
    expect(message).toContain("metadata.json");
  });
});

describe("normalisation and divergence", () => {
  it("collapses whitespace runs and trims, and changes nothing else", () => {
    expect(normaliseWhitespace("  a \n\t b  ")).toBe("a b");
    expect(normaliseWhitespace("Case, Punctuation; Kept.")).toBe("Case, Punctuation; Kept.");
  });

  it("reports the longest matching prefix", () => {
    expect(divergence("abcdef", "xx abcd yy")).toEqual({ matchedChars: 4, context: "abcd" });
    expect(divergence("zzz", "nothing alike")).toEqual({ matchedChars: 0, context: "" });
  });
});
