// SPDX-License-Identifier: Apache-2.0

/**
 * The one architectural rule, made machine-checkable (specs/architecture.md §9).
 *
 * Dependencies point one way: consumers depend on MAP-ATLAS; MAP-ATLAS depends on
 * nothing consumer-specific. Each package below declares what it may NOT import.
 */

/** @typedef {{ forbidden: string[], forbidDomGlobals?: boolean, note: string }} PackageRule */

/** @type {Record<string, PackageRule>} */
export const PACKAGE_RULES = {
  "packages/core": {
    forbidden: ["react", "react-dom", "maplibre-gl", "idb", "pmtiles", "@mapatlas/"],
    forbidDomGlobals: true,
    note: "core depends on nothing — no renderer, no React, no DOM, no sibling package",
  },
  "packages/recorder-web": {
    forbidden: ["react", "react-dom", "maplibre-gl"],
    note: "browser implementation: DOM is allowed, React and the renderer are not",
  },
  "packages/storage-idb": {
    forbidden: ["react", "react-dom", "maplibre-gl"],
    note: "browser implementation: DOM is allowed, React and the renderer are not",
  },
  "packages/offline-pmtiles": {
    forbidden: ["react", "react-dom", "maplibre-gl"],
    note: "browser implementation: DOM is allowed, React and the renderer are not",
  },
  "packages/maplibre": {
    forbidden: ["react", "react-dom"],
    note: "the renderer must stay usable without React",
  },
  "packages/react": {
    forbidden: [],
    note: "the integration surface may depend on everything below it",
  },
};

/**
 * Domain words that must never appear in the engine. The engine is domain-agnostic:
 * a consumer stores `species`, MAP-ATLAS stores a typed bag (specs/PRD.md §5).
 */
export const DOMAIN_TOKENS = [
  "fish",
  "angler",
  "species",
  "mushroom",
  "forager",
  "plant",
  "product",
  "auth",
  "database",
];

/**
 * Split identifiers into words so a token cannot hide inside camelCase,
 * PascalCase, or SCREAMING_SNAKE: `speciesId` and `SPECIES_ID` must both trip
 * the scan, which a plain `\bspecies\b` misses.
 *
 * @param {string} source
 * @returns {string}
 */
export function splitIdentifierWords(source) {
  return source
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/_/g, " ");
}

/** Runtime DOM globals `core` must not reach for. Type-only DOM references are fine. */
export const DOM_GLOBALS = [
  "window",
  "document",
  "navigator",
  "localStorage",
  "sessionStorage",
  "indexedDB",
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
];

/**
 * Every import specifier in a source file — including the forms a naive
 * `from "..."` regex misses: bare side-effect imports (`import "react";`),
 * dynamic `import("react")`, `export ... from`, and `require("react")`.
 *
 * @param {string} source
 * @returns {string[]}
 */
export function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

export function extractImports(source) {
  const withoutComments = stripComments(source);

  const patterns = [
    /\bimport\s+[\s\S]*?\bfrom\s*["']([^"']+)["']/g, // import x from "..."
    /\bimport\s*["']([^"']+)["']/g, // import "..."      (side effect)
    /\bexport\s+[\s\S]*?\bfrom\s*["']([^"']+)["']/g, // export * from "..."
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g, // import("...")
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g, // require("...")
  ];

  const found = new Set();
  for (const pattern of patterns) {
    for (const match of withoutComments.matchAll(pattern)) {
      if (match[1]) found.add(match[1]);
    }
  }
  return [...found];
}

/**
 * @param {string} specifier
 * @param {string} forbidden
 * @returns {boolean}
 */
function matchesForbidden(specifier, forbidden) {
  if (forbidden.endsWith("/")) return specifier.startsWith(forbidden);
  return specifier === forbidden || specifier.startsWith(`${forbidden}/`);
}

/**
 * Check one file against its package's rule.
 *
 * @param {string} packageKey  e.g. "packages/core"
 * @param {string} filePath    for the message only
 * @param {string} source
 * @returns {{ file: string, message: string }[]}
 */
export function checkFile(packageKey, filePath, source) {
  const rule = PACKAGE_RULES[packageKey];
  if (!rule) return [];

  const violations = [];

  for (const specifier of extractImports(source)) {
    const hit = rule.forbidden.find((f) => matchesForbidden(specifier, f));
    if (hit) {
      violations.push({
        file: filePath,
        message: `imports "${specifier}" — ${packageKey} must not (${rule.note})`,
      });
    }
  }

  if (rule.forbidDomGlobals) {
    // Prose gets stripped first: a comment cannot execute, and "bytes never enter the
    // document." should not read as a DOM access. The pattern also requires a property
    // name, an index or a call after the global, so `document.` in text stays inert while
    // `document.getElementById` does not.
    const code = stripComments(source);
    for (const global of DOM_GLOBALS) {
      const used = new RegExp(`(^|[^\\w.$"'\`])${global}\\s*(\\.\\s*\\w|\\[|\\()`, "m");
      if (used.test(code)) {
        violations.push({
          file: filePath,
          message: `uses the DOM global "${global}" — ${packageKey} must not (${rule.note})`,
        });
      }
    }
  }

  const words = splitIdentifierWords(source);
  for (const token of DOMAIN_TOKENS) {
    const used = new RegExp(`\\b${token}\\b`, "i");
    if (used.test(words)) {
      violations.push({
        file: filePath,
        message: `contains the domain word "${token}" — the engine is domain-agnostic`,
      });
    }
  }

  return violations;
}
