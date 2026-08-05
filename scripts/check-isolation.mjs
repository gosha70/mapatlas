// SPDX-License-Identifier: Apache-2.0
//
// Import-isolation scan (T0.5). Enforces the one architectural rule: the engine
// depends on nothing consumer- or renderer-specific.
//
//   @mapatlas/core    — must not import `react`/`react-dom`, `leaflet`, or the DOM,
//                       and must not mention any domain token.
//   @mapatlas/leaflet — must not import `react`/`react-dom`, and must not mention
//                       any domain token. (Leaflet legitimately uses the DOM.)
//
// The scan is intentionally cheap and text-based so it can run in CI without a
// build step. The pure `scanContent` function is exported so it can be unit
// tested against planted violations.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Domain words that must never appear in the engine. */
export const DOMAIN_TOKENS = [
  "fish",
  "species",
  "mushroom",
  "plant",
  "product",
  "auth",
  "db",
];

const IMPORT_RE =
  /(?:import|export)[^;]*?from\s*["']([^"']+)["']|(?:require|import)\(\s*["']([^"']+)["']\s*\)/g;

/** DOM globals that indicate a browser dependency in framework-agnostic code. */
const DOM_GLOBALS = ["window", "document", "navigator", "localStorage"];

const SOURCE_EXT = /\.(m|c)?tsx?$/;

/**
 * @param {"core"|"leaflet"} pkg
 * @param {string} content  file contents
 * @returns {string[]} human-readable violation messages (empty when clean)
 */
export function scanContent(pkg, content) {
  const violations = [];

  const forbiddenModules =
    pkg === "core"
      ? [/^react($|\/)/, /^react-dom($|\/)/, /^leaflet($|\/)/]
      : [/^react($|\/)/, /^react-dom($|\/)/];

  for (const match of content.matchAll(IMPORT_RE)) {
    const spec = match[1] ?? match[2];
    if (!spec) continue;
    for (const re of forbiddenModules) {
      if (re.test(spec)) {
        violations.push(`forbidden import of "${spec}"`);
      }
    }
  }

  if (pkg === "core") {
    for (const g of DOM_GLOBALS) {
      if (new RegExp(`\\b${g}\\b`).test(content)) {
        violations.push(`forbidden DOM reference "${g}"`);
      }
    }
  }

  for (const token of DOMAIN_TOKENS) {
    if (new RegExp(`\\b${token}\\b`, "i").test(content)) {
      violations.push(`forbidden domain token "${token}"`);
    }
  }

  return violations;
}

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      yield* walk(full);
    } else if (SOURCE_EXT.test(entry)) {
      yield full;
    }
  }
}

function main() {
  const targets = [
    { pkg: "core", dir: join(ROOT, "packages/core/src") },
    { pkg: "leaflet", dir: join(ROOT, "packages/leaflet/src") },
  ];

  let failed = false;
  for (const { pkg, dir } of targets) {
    let files;
    try {
      files = [...walk(dir)];
    } catch {
      continue; // package src not present yet
    }
    for (const file of files) {
      const violations = scanContent(pkg, readFileSync(file, "utf8"));
      for (const v of violations) {
        failed = true;
        console.error(`✗ ${relative(ROOT, file)} [@mapatlas/${pkg}]: ${v}`);
      }
    }
  }

  if (failed) {
    console.error("\nImport-isolation scan FAILED.");
    process.exit(1);
  }
  console.log("Import-isolation scan passed.");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
