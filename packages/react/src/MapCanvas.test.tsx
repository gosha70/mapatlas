// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { Id, LatLng, TileSource, Track } from "@mapatlas/core";

// Mock the renderer so <MapCanvas> is tested without a real MapLibre map. The
// dynamic import inside the component resolves to this mock.
const controller = {
  setSources: vi.fn(),
  renderTrack: vi.fn(),
  renderEvents: vi.fn(),
  showLivePosition: vi.fn(),
  fitTrack: vi.fn(),
  recenter: vi.fn(),
  onMapTap: vi.fn((cb: (at: LatLng) => void) => {
    tapCb = cb;
    return () => {};
  }),
  onEventClick: vi.fn((cb: (id: Id) => void) => {
    clickCb = cb;
    return () => {};
  }),
  destroy: vi.fn(),
};
let tapCb: ((at: LatLng) => void) | undefined;
let clickCb: ((id: Id) => void) | undefined;
const createMapController = vi.fn(() => controller);

vi.mock("@mapatlas/maplibre", () => ({ createMapController }));

import { MapCanvas } from "./MapCanvas";

const SOURCES: TileSource[] = [
  { id: "osm", kind: "xyz", url: "u/{z}/{x}/{y}", attribution: "© OSM" },
];
const TRACK: Track = {
  id: "t1",
  startedAt: 0,
  status: "finalized",
  points: [{ lat: 1, lng: 2, t: 0 }],
  simplified: [{ lat: 1, lng: 2, t: 0 }],
  distanceM: 0,
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  tapCb = undefined;
  clickCb = undefined;
});

describe("MapCanvas", () => {
  it("mounts the controller and applies props once loaded", async () => {
    render(
      <MapCanvas
        sources={SOURCES}
        track={TRACK}
        events={[
          {
            id: "e1",
            position: { lat: 1, lng: 2 },
            occurredAt: 0,
            media: [],
            tags: [],
          },
        ]}
      />,
    );
    await waitFor(() => expect(createMapController).toHaveBeenCalledTimes(1));
    expect(controller.setSources).toHaveBeenCalledWith(SOURCES);
    expect(controller.renderTrack).toHaveBeenCalledWith(TRACK);
    expect(controller.renderEvents).toHaveBeenCalledTimes(1);
    expect(controller.fitTrack).toHaveBeenCalledWith(TRACK);
  });

  it("routes map taps and event clicks to props", async () => {
    const onMapTap = vi.fn();
    const onEventClick = vi.fn();
    render(
      <MapCanvas
        sources={SOURCES}
        onMapTap={onMapTap}
        onEventClick={onEventClick}
      />,
    );
    await waitFor(() => expect(createMapController).toHaveBeenCalled());
    tapCb?.({ lat: 5, lng: 6 });
    clickCb?.("e1");
    expect(onMapTap).toHaveBeenCalledWith({ lat: 5, lng: 6 });
    expect(onEventClick).toHaveBeenCalledWith("e1");
  });

  it("renders an accessible application region", () => {
    const { getByRole } = render(<MapCanvas sources={SOURCES} />);
    expect(getByRole("application", { name: "Interactive map" })).toBeTruthy();
  });

  it("destroys the controller on unmount", async () => {
    const { unmount } = render(<MapCanvas sources={SOURCES} />);
    await waitFor(() => expect(createMapController).toHaveBeenCalled());
    unmount();
    expect(controller.destroy).toHaveBeenCalledTimes(1);
  });
});
