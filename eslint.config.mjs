// SPDX-License-Identifier: Apache-2.0
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

/** Runtime DOM globals `@mapatlas/core` must never reach for. Type-only DOM
 *  references (e.g. `Blob` in a signature) are allowed; these are the values. */
const DOM_GLOBALS = [
  "window",
  "document",
  "navigator",
  "localStorage",
  "sessionStorage",
  "indexedDB",
  // Network egress: SECURITY.md forbids the engine phoning anywhere the consumer did not
  // configure, and `core` in particular has no business opening a connection at all.
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
];

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/*.d.ts"] },

  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,

  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },

  // The one architectural rule, enforced at lint time as well as by scan:isolation.
  {
    files: ["packages/core/**/*.ts"],
    rules: {
      "no-restricted-globals": [
        "error",
        ...DOM_GLOBALS.map((name) => ({
          name,
          message: "@mapatlas/core must not touch the DOM — put it behind a seam.",
        })),
      ],
    },
  },

  // The scanners are Node scripts, not library code.
  {
    files: ["scripts/**/*.mjs", "*.config.mjs", "*.config.ts"],
    languageOptions: { globals: globals.node },
  },

  {
    files: ["**/*.test.ts", "scripts/**/*.mjs"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
);
