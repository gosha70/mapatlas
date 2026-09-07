// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";

import {
  LicenceError,
  NOT_FOR_DISTRIBUTION_PATH,
  assertArchiveCarriesAttribution,
  assertNotForDistribution,
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

describe("the checked-in licence and declaration", () => {
  it("backs all four declared roles verbatim against the real document", () => {
    // The declaration was sliced from this document rather than typed, so this passing is not
    // a surprise — its value is guarding the pair from here on, and confirming the extraction
    // landed. The document's own provenance is in fixtures/vertical/licence/manifest.json.
    const licence = readFileSync("fixtures/vertical/licence/COP-DEM-GLO-30.txt", "utf8");
    const declared = JSON.parse(readFileSync("fixtures/vertical/attribution.json", "utf8"));
    expect(assertStringsBackedByLicence(declared, licence, "COP-DEM-GLO-30.txt")).toEqual(
      REQUIRED_ROLES,
    );
  });

  it("carries the Article 6(b) adapted-data notice, which is the one ADR-0024 quotes", () => {
    const declared = JSON.parse(readFileSync("fixtures/vertical/attribution.json", "utf8"));
    expect(declared.derivedWorksNotice).toContain("produced using Copernicus WorldDEM-30");
    expect(declared.derivedWorksNotice).toContain("all rights reserved");
  });
});

describe("a development archive says what it is", () => {
  it("accepts one carrying the marker", () => {
    expect(() =>
      assertNotForDistribution(archiveOf([{ path: NOT_FOR_DISTRIBUTION_PATH, text: "" }])),
    ).not.toThrow();
  });

  it("refuses one without it, since nothing else separates it from a shipped archive", () => {
    expect(() => assertNotForDistribution(archiveOf([{ path: "dem.pmtiles", text: "" }]))).toThrow(
      /must carry NOT-FOR-DISTRIBUTION/,
    );
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

describe("a product declares its own roles and its own documents", () => {
  const ODBL = "4.4 Share Alike. If you Publicly Use a Derivative Database ... under the ODbL.";
  const OSM =
    "You are free to copy our data, as long as you credit OpenStreetMap and its contributors.";
  const bundle = { "ODbL-1.0": ODBL, "OSM-COPYRIGHT": OSM };

  it("checks each string against the document that backs it", () => {
    // The basemap's two obligations live in two documents and neither contains the other's
    // sentence. This is the case a single-text check cannot express.
    const declared = {
      credit: { document: "OSM-COPYRIGHT", text: "credit OpenStreetMap and its contributors" },
      shareAlike: { document: "ODbL-1.0", text: "4.4 Share Alike" },
    };

    expect(
      assertStringsBackedByLicence(declared, bundle, "the basemap licence", {
        requiredRoles: ["credit", "shareAlike"],
      }),
    ).toStrictEqual(["credit", "shareAlike"]);
  });

  it("refuses a string declared against the document that does not contain it", () => {
    // **The mutation concatenation would hide.** Joining the two texts makes this pass: every
    // string matches something, and which document backs which obligation stops being checked.
    const crossed = {
      credit: { document: "ODbL-1.0", text: "credit OpenStreetMap and its contributors" },
      shareAlike: { document: "ODbL-1.0", text: "4.4 Share Alike" },
    };

    expect(() =>
      assertStringsBackedByLicence(crossed, bundle, "the basemap licence", {
        requiredRoles: ["credit", "shareAlike"],
      }),
    ).toThrow(/attribution "credit" does not occur in ODbL-1\.0/);
  });

  it("refuses a string naming a document the bundle does not have", () => {
    expect(() =>
      assertStringsBackedByLicence(
        { credit: { document: "CC-BY-4.0", text: "credit OpenStreetMap" } },
        bundle,
        "the basemap licence",
        { requiredRoles: ["credit"] },
      ),
    ).toThrow(/names document "CC-BY-4\.0", which is not in/);
  });

  it("refuses a bare string when more than one document could back it", () => {
    // Silently checking against whichever came first is how a credit ends up validated by a
    // document that never required it.
    expect(() =>
      assertStringsBackedByLicence({ credit: "credit OpenStreetMap" }, bundle, "the bundle", {
        requiredRoles: ["credit"],
      }),
    ).toThrow(/names no document, but the bundle has 2/);
  });

  it("refuses an empty document in a bundle, as it does a single empty one", () => {
    expect(() =>
      assertStringsBackedByLicence(
        { credit: { document: "EMPTY", text: "x" } },
        { EMPTY: "  " },
        "b",
        {
          requiredRoles: ["credit"],
        },
      ),
    ).toThrow(/EMPTY is empty/);
  });

  it("demands the roles the product declares, not another product's", () => {
    // The default is Copernicus's four; a product with different obligations says so. Demanding
    // "derivedWorksNotice" of an ODbL product would be demanding a role its licence has no words
    // for.
    expect(() =>
      assertStringsBackedByLicence(
        { credit: { document: "OSM-COPYRIGHT", text: "credit OpenStreetMap" } },
        bundle,
        "the basemap licence",
        { requiredRoles: ["credit", "shareAlike"] },
      ),
    ).toThrow(/missing "shareAlike"/);
  });

  it("still demands the Copernicus four when no roles are given", () => {
    // The default is the existing behaviour, not a new one.
    expect(() => assertStringsBackedByLicence({ credit: "x" }, "x")).toThrow(
      /missing "derivedWorksNotice"/,
    );
  });

  it("carries a document-qualified string into the archive check unchanged", () => {
    // `assertArchiveCarriesAttribution` is role-agnostic and stays so; it only had to learn to
    // read the text out of the new form.
    const archive = {
      entries: () => [
        { path: "LICENSE", text: ODBL },
        { path: "ATTRIBUTION", text: "credit OpenStreetMap and its contributors" },
      ],
    };

    expect(() =>
      assertArchiveCarriesAttribution(archive, {
        credit: { document: "OSM-COPYRIGHT", text: "credit OpenStreetMap and its contributors" },
      }),
    ).not.toThrow();
  });

  it("still catches a document-qualified string that never reaches the archive", () => {
    const archive = { entries: () => [{ path: "LICENSE", text: ODBL }] };

    expect(() =>
      assertArchiveCarriesAttribution(archive, {
        credit: { document: "OSM-COPYRIGHT", text: "credit OpenStreetMap and its contributors" },
      }),
    ).toThrow(/never reaches the archive/);
  });
});
