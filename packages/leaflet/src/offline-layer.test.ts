// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from "vitest";
import * as L from "leaflet";
import { createOfflineTileLayer, type TileReader } from "./offline-layer";

beforeAll(() => {
  URL.createObjectURL = vi.fn(() => "blob:mock");
  URL.revokeObjectURL = vi.fn();
});

// Access the protected createTile without `any`.
interface TileFactory {
  createTile(coords: L.Coords, done: L.DoneCallback): HTMLElement;
}

function tileBytes(z: number, x: number, y: number): ArrayBuffer {
  return new TextEncoder().encode(`t${z}/${x}/${y}`).buffer;
}

describe("createOfflineTileLayer", () => {
  it("renders a stored tile with no network access", async () => {
    // The reader is a local map — there is no network path at all.
    const local = new Map<string, ArrayBuffer>([["1/0/0", tileBytes(1, 0, 0)]]);
    const read: TileReader = (z, x, y) =>
      Promise.resolve(local.get(`${z}/${x}/${y}`));

    const layer = createOfflineTileLayer(read, {
      attribution: "© Offline",
    }) as unknown as TileFactory;

    const done = vi.fn();
    const img = layer.createTile(
      { z: 1, x: 0, y: 0 } as L.Coords,
      done,
    ) as HTMLImageElement;

    await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(1));
    expect(done.mock.calls[0]![0]).toBeUndefined(); // no error
    expect(img.src).toBe("blob:mock");
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  });

  it("leaves a tile blank when the reader has no bytes", async () => {
    const read: TileReader = () => Promise.resolve(undefined);
    const layer = createOfflineTileLayer(read) as unknown as TileFactory;

    const done = vi.fn();
    const img = layer.createTile(
      { z: 2, x: 1, y: 1 } as L.Coords,
      done,
    ) as HTMLImageElement;

    await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(1));
    expect(done.mock.calls[0]![0]).toBeUndefined();
    expect(img.getAttribute("src")).toBeNull();
  });

  it("carries attribution and zoom bounds onto the layer", () => {
    const read: TileReader = () => Promise.resolve(undefined);
    const layer = createOfflineTileLayer(read, {
      attribution: "© Offline",
      minZoom: 10,
      maxZoom: 16,
    });
    expect(layer.options.attribution).toBe("© Offline");
    expect(layer.options.minZoom).toBe(10);
    expect(layer.options.maxZoom).toBe(16);
  });
});
