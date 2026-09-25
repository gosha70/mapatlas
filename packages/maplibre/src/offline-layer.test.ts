// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
//
// `createOfflineTileLayer` never constructs its own `maplibre-gl` `Map`
// (the consumer supplies one), so this file only needs to mock the module's
// `addProtocol` export — the seam it uses to register the private
// `mapatlas-offline://` protocol — and drive it against a minimal fake map
// that records `addSource`/`addLayer`/`removeLayer`/`removeSource` calls.
import { beforeEach, describe, expect, it, vi } from "vitest";

interface RequestParams {
  url: string;
}
type ProtocolHandler = (
  params: RequestParams,
) => Promise<{ data: ArrayBuffer }>;

const addProtocolMock = vi.hoisted(() =>
  vi.fn<(name: string, fn: ProtocolHandler) => void>(),
);

vi.mock("maplibre-gl", () => ({
  addProtocol: addProtocolMock,
  removeProtocol: vi.fn(),
}));

import { createOfflineTileLayer, type TileReader } from "./offline-layer";

interface FakeMap {
  sources: Map<string, Record<string, unknown>>;
  layers: Map<string, Record<string, unknown>>;
  loaded: boolean;
  isStyleLoaded(): boolean;
  addSource(id: string, spec: Record<string, unknown>): void;
  getSource(id: string): Record<string, unknown> | undefined;
  removeSource(id: string): void;
  addLayer(layer: Record<string, unknown> & { id: string }): void;
  getLayer(id: string): Record<string, unknown> | undefined;
  removeLayer(id: string): void;
  once(type: "load", cb: () => void): void;
  __load(): void;
}

function makeFakeMap(): FakeMap {
  const sources = new Map<string, Record<string, unknown>>();
  const layers = new Map<string, Record<string, unknown>>();
  const loadCbs = new Set<() => void>();
  return {
    sources,
    layers,
    loaded: false,
    isStyleLoaded() {
      return this.loaded;
    },
    addSource(id, spec) {
      sources.set(id, spec);
    },
    getSource(id) {
      return sources.get(id);
    },
    removeSource(id) {
      sources.delete(id);
    },
    addLayer(layer) {
      layers.set(layer.id, layer);
    },
    getLayer(id) {
      return layers.get(id);
    },
    removeLayer(id) {
      layers.delete(id);
    },
    once(_type, cb) {
      loadCbs.add(cb);
    },
    __load() {
      this.loaded = true;
      for (const cb of [...loadCbs]) cb();
    },
  };
}

function tileBytes(z: number, x: number, y: number): ArrayBuffer {
  return new TextEncoder().encode(`t${z}/${x}/${y}`).buffer;
}

/** The `mapatlas-offline://` handler registered via `addProtocol`. */
function protocolHandler(): ProtocolHandler {
  const call = addProtocolMock.mock.calls.find(
    ([name]) => name === "mapatlas-offline",
  );
  if (!call) throw new Error("mapatlas-offline protocol was not registered");
  return call[1];
}

describe("createOfflineTileLayer", () => {
  let map: FakeMap;

  beforeEach(() => {
    map = makeFakeMap();
  });
  // Note: `addProtocolMock` is intentionally never cleared — the protocol is
  // registered once, guarded by module-level state in offline-layer.ts, so
  // clearing it here would strand `protocolHandler()` after the first test.

  it("defers addSource/addLayer until the style loads", () => {
    const read: TileReader = () => Promise.resolve(undefined);
    const layer = createOfflineTileLayer(read);
    layer.addTo(map as unknown as Parameters<typeof layer.addTo>[0]);
    expect(map.sources.size).toBe(0);

    map.__load();
    expect(map.sources.size).toBe(1);
    expect(map.layers.size).toBe(1);
  });

  it("reads a stored tile with no network access", async () => {
    const local = new Map<string, ArrayBuffer>([["1/0/0", tileBytes(1, 0, 0)]]);
    const read: TileReader = (z, x, y) =>
      Promise.resolve(local.get(`${z}/${x}/${y}`));
    const layer = createOfflineTileLayer(read, { attribution: "© Offline" });
    layer.addTo(map as unknown as Parameters<typeof layer.addTo>[0]);
    map.__load();

    const source = [...map.sources.values()][0]!;
    const tileUrl = (source["tiles"] as string[])[0]!.replace(
      "{z}/{x}/{y}",
      "1/0/0",
    );
    const result = await protocolHandler()({ url: tileUrl });
    expect(new Uint8Array(result.data)).toEqual(
      new Uint8Array(tileBytes(1, 0, 0)),
    );
  });

  it("returns a blank (transparent) tile when the reader has no bytes", async () => {
    const read: TileReader = () => Promise.resolve(undefined);
    const layer = createOfflineTileLayer(read);
    layer.addTo(map as unknown as Parameters<typeof layer.addTo>[0]);
    map.__load();

    const source = [...map.sources.values()][0]!;
    const tileUrl = (source["tiles"] as string[])[0]!.replace(
      "{z}/{x}/{y}",
      "2/1/1",
    );
    const result = await protocolHandler()({ url: tileUrl });
    // A 1x1 PNG: non-empty and starts with the PNG magic byte.
    expect(result.data.byteLength).toBeGreaterThan(0);
    expect(new Uint8Array(result.data)[0]).toBe(0x89);
  });

  it("rejects an unknown reader id", async () => {
    await expect(
      protocolHandler()({ url: "mapatlas-offline://not-a-real-reader/1/0/0" }),
    ).rejects.toThrow();
  });

  it("carries attribution and zoom bounds onto the source", () => {
    const read: TileReader = () => Promise.resolve(undefined);
    const layer = createOfflineTileLayer(read, {
      attribution: "© Offline",
      minZoom: 10,
      maxZoom: 16,
    });
    layer.addTo(map as unknown as Parameters<typeof layer.addTo>[0]);
    map.__load();

    const source = [...map.sources.values()][0]!;
    expect(source["attribution"]).toBe("© Offline");
    expect(source["minzoom"]).toBe(10);
    expect(source["maxzoom"]).toBe(16);
  });

  it("removes the source, layer, and reader on remove()", async () => {
    const read: TileReader = () => Promise.resolve(undefined);
    const layer = createOfflineTileLayer(read);
    layer.addTo(map as unknown as Parameters<typeof layer.addTo>[0]);
    map.__load();
    const [sourceId] = [...map.sources.keys()];
    const tileUrl = (map.sources.get(sourceId!)!["tiles"] as string[])[0]!;

    layer.remove();
    expect(map.sources.size).toBe(0);
    expect(map.layers.size).toBe(0);
    await expect(
      protocolHandler()({ url: tileUrl.replace("{z}/{x}/{y}", "0/0/0") }),
    ).rejects.toThrow();
  });
});
