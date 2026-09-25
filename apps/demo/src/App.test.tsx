// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { createMemoryStorageAdapter } from "@mapatlas/core";

// Render <MapCanvas> against a stub controller so the demo test needs no real map.
vi.mock("@mapatlas/maplibre", () => ({
  createMapController: vi.fn(() => ({
    setSources: vi.fn(),
    renderTrack: vi.fn(),
    renderEvents: vi.fn(),
    showLivePosition: vi.fn(),
    fitTrack: vi.fn(),
    recenter: vi.fn(),
    onMapTap: vi.fn(() => () => {}),
    onEventClick: vi.fn(() => () => {}),
    destroy: vi.fn(),
  })),
}));

import { App } from "./App";

beforeAll(() => {
  URL.createObjectURL = vi.fn(() => "blob:mock");
  URL.revokeObjectURL = vi.fn();
});
afterEach(cleanup);

describe("demo App", () => {
  it("wires recorder + map + events + offline into one field logger", () => {
    render(<App store={createMemoryStorageAdapter()} />);

    expect(
      screen.getByRole("heading", { name: "MAP-ATLAS field logger" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Export GeoJSON" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Offline maps" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Download current area" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Enable persistent storage" }),
    ).toBeTruthy();
    // <MapCanvas> is mounted inside the app (renders its map region).
    expect(
      screen.getByRole("application", { name: "Interactive map" }),
    ).toBeTruthy();
  });
});
