// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { checkFile, extractImports } from "./isolation-rules.mjs";

const messages = (pkg, source) => checkFile(pkg, "planted.ts", source).map((v) => v.message);

describe("extractImports", () => {
  it("finds the ordinary form", () => {
    expect(extractImports(`import { x } from "react";`)).toEqual(["react"]);
  });

  it("finds a bare side-effect import — the form a from-only regex misses", () => {
    expect(extractImports(`import "react";`)).toEqual(["react"]);
  });

  it("finds dynamic, re-export, and require forms", () => {
    expect(extractImports(`const m = await import("maplibre-gl");`)).toEqual(["maplibre-gl"]);
    expect(extractImports(`export * from "react-dom";`)).toEqual(["react-dom"]);
    expect(extractImports(`const idb = require("idb");`)).toEqual(["idb"]);
  });

  it("finds a subpath import", () => {
    expect(extractImports(`import x from "react-dom/client";`)).toEqual(["react-dom/client"]);
  });

  it("ignores an import that is only mentioned in a comment", () => {
    expect(extractImports(`// import { x } from "react";\nconst a = 1;`)).toEqual([]);
    expect(extractImports(`/* import "react"; */\nconst a = 1;`)).toEqual([]);
  });
});

describe("checkFile — core", () => {
  it("passes a clean file", () => {
    expect(messages("packages/core", `export const A = 1;\n`)).toEqual([]);
  });

  it("rejects a React import", () => {
    expect(messages("packages/core", `import { useState } from "react";`)).toHaveLength(1);
  });

  it("rejects a bare side-effect React import", () => {
    expect(messages("packages/core", `import "react";`)).toHaveLength(1);
  });

  it("rejects a React subpath import", () => {
    expect(messages("packages/core", `import x from "react-dom/client";`)).toHaveLength(1);
  });

  it("rejects the renderer", () => {
    expect(messages("packages/core", `import maplibregl from "maplibre-gl";`)).toHaveLength(1);
  });

  it("rejects a sibling package — core depends on nothing", () => {
    expect(messages("packages/core", `import { x } from "@mapatlas/maplibre";`)).toHaveLength(1);
  });

  it("rejects a runtime DOM global", () => {
    expect(messages("packages/core", `const w = window.innerWidth;`)).toHaveLength(1);
    expect(messages("packages/core", `navigator.geolocation.watchPosition();`)).toHaveLength(1);
  });

  it("allows a type-only DOM reference — Blob is in the StorageAdapter contract", () => {
    expect(messages("packages/core", `export type Put = (b: Blob) => Promise<string>;`)).toEqual(
      [],
    );
  });

  it("rejects a domain word", () => {
    expect(messages("packages/core", `// tuned for fish\n`)).toHaveLength(1);
  });

  it("rejects a domain word hidden inside an identifier", () => {
    expect(messages("packages/core", `export const speciesId = "x";`)).toHaveLength(1);
    expect(messages("packages/core", `const SPECIES_ID = 1;`)).toHaveLength(1);
    expect(messages("packages/core", `class MushroomStore {}`)).toHaveLength(1);
  });

  it("does not flag legitimate words that merely contain a token", () => {
    expect(messages("packages/storage-idb", `// backed by IndexedDB\n`)).toEqual([]);
    expect(messages("packages/core", `export const origin = "authored";`)).toEqual([]);
    expect(messages("packages/core", `const isAuthored = true;`)).toEqual([]);
  });
});

describe("checkFile — per-package rules differ", () => {
  it("lets recorder-web use the DOM but not React", () => {
    expect(messages("packages/recorder-web", `navigator.geolocation.watchPosition();`)).toEqual([]);
    expect(messages("packages/recorder-web", `import "react";`)).toHaveLength(1);
  });

  it("lets storage-idb import idb, which core may not", () => {
    expect(messages("packages/storage-idb", `import { openDB } from "idb";`)).toEqual([]);
    expect(messages("packages/core", `import { openDB } from "idb";`)).toHaveLength(1);
  });

  it("lets maplibre import the renderer but not React", () => {
    expect(messages("packages/maplibre", `import maplibregl from "maplibre-gl";`)).toEqual([]);
    expect(messages("packages/maplibre", `import { useState } from "react";`)).toHaveLength(1);
  });

  it("lets react import everything below it", () => {
    expect(messages("packages/react", `import { useState } from "react";`)).toEqual([]);
    expect(messages("packages/react", `import maplibregl from "maplibre-gl";`)).toEqual([]);
  });
});
