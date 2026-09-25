// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { scanContent } from "./check-isolation.mjs";

describe("import-isolation scan", () => {
  it("passes clean framework-agnostic core content", () => {
    const ok = `// SPDX-License-Identifier: Apache-2.0
export const PACKAGE_NAME = "@mapatlas/core";
`;
    expect(scanContent("core", ok)).toEqual([]);
  });

  it("fails when core imports react (planted violation)", () => {
    const bad = `import { useState } from "react";`;
    expect(scanContent("core", bad).length).toBeGreaterThan(0);
  });

  it("fails when core imports maplibre-gl (planted violation)", () => {
    const bad = `import maplibregl from "maplibre-gl";`;
    expect(scanContent("core", bad).length).toBeGreaterThan(0);
  });

  it("fails when core touches the DOM (planted violation)", () => {
    const bad = `export const el = document.createElement("div");`;
    expect(scanContent("core", bad).length).toBeGreaterThan(0);
  });

  it("fails on a domain token in core (planted violation)", () => {
    const bad = `export interface Catch { species: string; }`;
    expect(scanContent("core", bad).length).toBeGreaterThan(0);
  });

  it("fails when maplibre imports react (planted violation)", () => {
    const bad = `import React from "react";`;
    expect(scanContent("maplibre", bad).length).toBeGreaterThan(0);
  });

  it("allows the DOM in maplibre but still rejects domain tokens", () => {
    expect(scanContent("maplibre", `const c = document.body;`)).toEqual([]);
    expect(
      scanContent("maplibre", `const p = "mushroom";`).length,
    ).toBeGreaterThan(0);
  });
});
