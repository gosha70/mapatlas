// SPDX-License-Identifier: Apache-2.0
/**
 * Import-isolation + domain-token scan (architecture.md §9).
 *
 * Enforces the one architectural rule:
 *   - @mapatlas/core must not import react / react-dom / leaflet / the DOM.
 *   - @mapatlas/leaflet must not import react / react-dom.
 *   - Neither package may mention consumer domain tokens
 *     (fish, species, mushroom, plant, product, auth, db).
 *
 * Exits non-zero (failing the build) on any violation.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const DOMAIN_TOKENS = /\b(fish|species|mushroom|plant|product|auth|db)\b/i;

/** Modules that must never be imported by a given package. */
const RULES = [
  {
    pkg: "@mapatlas/core",
    dir: join(repoRoot, "packages/core/src"),
    forbiddenImports: [/^react(\/|$)/, /^react-dom(\/|$)/, /^leaflet(\/|$)/],
    forbiddenGlobals: [/\bdocument\b/, /\bwindow\b/],
  },
  {
    pkg: "@mapatlas/leaflet",
    dir: join(repoRoot, "packages/leaflet/src"),
    forbiddenImports: [/^react(\/|$)/, /^react-dom(\/|$)/],
    forbiddenGlobals: [],
  },
];

/** Collect .ts/.tsx files under a directory, skipping dist. */
function collect(dir) {
  let out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "dist" || name === "node_modules") continue;
      out = out.concat(collect(full));
    } else if (/\.(ts|tsx|mts|cts)$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

const IMPORT_RE =
  /(?:import|export)[\s\S]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;

const violations = [];

for (const rule of RULES) {
  for (const file of collect(rule.dir)) {
    const src = readFileSync(file, "utf8");
    const rel = file.slice(repoRoot.length);

    let m;
    IMPORT_RE.lastIndex = 0;
    while ((m = IMPORT_RE.exec(src))) {
      const spec = m[1] ?? m[2];
      if (!spec) continue;
      for (const bad of rule.forbiddenImports) {
        if (bad.test(spec)) {
          violations.push(
            `${rel}: ${rule.pkg} imports forbidden module "${spec}"`,
          );
        }
      }
    }

    for (const bad of rule.forbiddenGlobals) {
      if (bad.test(src)) {
        violations.push(
          `${rel}: ${rule.pkg} references forbidden DOM global ${bad}`,
        );
      }
    }

    const domain = src.match(DOMAIN_TOKENS);
    if (domain) {
      violations.push(
        `${rel}: ${rule.pkg} contains forbidden domain token "${domain[0]}"`,
      );
    }
  }
}

if (violations.length > 0) {
  console.error("Import-isolation scan FAILED:");
  for (const v of violations) console.error("  - " + v);
  process.exit(1);
}

console.log("Import-isolation scan passed.");
