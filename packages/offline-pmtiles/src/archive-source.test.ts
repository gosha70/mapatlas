// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createMemoryMapAssetStore } from "@mapatlas/core/testing";
import type { MapAssetStore, OfflineRegion, TileSource } from "@mapatlas/core";
import type { PMTiles } from "pmtiles";

import {
  MissingArchiveError,
  createStoredArchiveSource,
  installOfflineArchives,
} from "./archive-source.js";
import { createPMTilesRegionStore } from "./region-store.js";
import type { RegionFetch } from "./region-store.js";

const archive = (id: string, over: Partial<TileSource> = {}): TileSource =>
  ({
    id,
    kind: "raster-dem",
    transport: "pmtiles",
    url: `https://self-hosted.invalid/${id}.pmtiles`,
    attribution: "fixture",
    offlineLicensed: true,
    ...over,
  }) satisfies TileSource;

const REGION = {
  name: "test region",
  bbox: [10, 50, 11, 51] as [number, number, number, number],
  minZoom: 8,
  maxZoom: 12,
};

/** Distinguishable bytes per url, so a reader that fetched cannot be mistaken for one that read. */
const BODY = (id: string): Uint8Array<ArrayBuffer> => {
  const bytes = new Uint8Array(new ArrayBuffer(64));
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = (id.charCodeAt(index % id.length) + index) % 256;
  }
  return bytes;
};

const fetcher = (): RegionFetch => ({
  bytes: (url) => Promise.resolve(new Blob([BODY(url)])),
  size: (url) => Promise.resolve(BODY(url).byteLength),
});

const bytesOf = async (blob: Blob | undefined): Promise<Uint8Array> =>
  new Uint8Array(await (blob ?? new Blob()).arrayBuffer());

/** Downloads one region and hands back everything a reader would be given. */
const downloaded = async (
  sources: TileSource[],
  sourceIds: string[],
): Promise<{ assets: MapAssetStore; region: OfflineRegion; sources: TileSource[] }> => {
  const assets = createMemoryMapAssetStore();
  const store = createPMTilesRegionStore({ sources, assets, fetcher: fetcher() });
  const region = await store.download({ ...REGION, sourceIds });
  return { assets, region, sources };
};

const keyOf = async (assets: MapAssetStore, sourceId: string): Promise<string> => {
  const keys = (await assets.list()).filter(
    (key) => key.includes("/archive/") && key.endsWith(`/${sourceId}`),
  );
  expect(keys, `exactly one archive for ${sourceId}`).toHaveLength(1);
  return keys[0] as string;
};

describe("createStoredArchiveSource", () => {
  it("returns exactly the bytes download() stored, for the whole archive", async () => {
    // The provenance claim, at the seam where it is observable. Zero network requests would
    // prove nothing here — a service worker or a warm HTTP cache produces zero requests too.
    // What this asserts is byte identity between what `put()` holds and what the reader yields.
    const { assets } = await downloaded([archive("terrain")], ["terrain"]);
    const key = await keyOf(assets, "terrain");
    const stored = await bytesOf(await assets.get(key));

    const source = createStoredArchiveSource({ assets, key, url: "https://x.invalid/t.pmtiles" });
    const read = new Uint8Array((await source.getBytes(0, stored.byteLength)).data);

    expect(read.byteLength).toBe(64);
    expect([...read], "byte for byte").toEqual([...stored]);
  });

  it("reads the stored bytes even when they differ from what the url would serve", async () => {
    // The mutation this exists for: a reader that fetches its url instead of reading the store
    // passes every same-bytes test, because `download()` stored what it fetched. Overwriting
    // the stored blob separates the two, and only a store-backed reader can see the change.
    const { assets } = await downloaded([archive("terrain")], ["terrain"]);
    const key = await keyOf(assets, "terrain");
    const replacement = new Uint8Array([9, 8, 7, 6]);
    await assets.put(key, new Blob([replacement]));

    const source = createStoredArchiveSource({
      assets,
      key,
      url: "https://self-hosted.invalid/terrain.pmtiles",
    });
    expect([...new Uint8Array((await source.getBytes(0, 4)).data)]).toEqual([9, 8, 7, 6]);
  });

  it("serves an arbitrary range out of the middle, as a range request would", async () => {
    const { assets } = await downloaded([archive("terrain")], ["terrain"]);
    const key = await keyOf(assets, "terrain");
    const stored = await bytesOf(await assets.get(key));

    const source = createStoredArchiveSource({ assets, key, url: "https://x.invalid/t.pmtiles" });
    const read = new Uint8Array((await source.getBytes(16, 8)).data);
    expect([...read]).toEqual([...stored.slice(16, 24)]);
  });

  it("answers with the source's own url, so the style is the same offline and online", async () => {
    // If this returned a local key, the offline style would differ from the online one and
    // every layer, filter and expression built on those ids would have two forms to maintain.
    const assets = createMemoryMapAssetStore();
    const source = createStoredArchiveSource({
      assets,
      key: "mapatlas/archive/r1/terrain",
      url: "https://self-hosted.invalid/terrain.pmtiles",
    });
    expect(source.getKey()).toBe("https://self-hosted.invalid/terrain.pmtiles");
  });

  it("fails loudly when the archive is gone, rather than answering with no bytes", async () => {
    // Reachable: map assets are evictable (ADR-0016), so a manifest can outlive its bytes.
    // Empty bytes would decode as "the archive has nothing here" and render as blank map.
    const assets = createMemoryMapAssetStore();
    const source = createStoredArchiveSource({
      assets,
      key: "mapatlas/archive/r1/terrain",
      url: "https://self-hosted.invalid/terrain.pmtiles",
    });
    await expect(source.getBytes(0, 16)).rejects.toThrow(MissingArchiveError);
  });
});

describe("installOfflineArchives", () => {
  const registrar = (): { add: (archive: PMTiles) => void; added: PMTiles[] } => {
    const added: PMTiles[] = [];
    return {
      added,
      add: vi.fn((entry: PMTiles) => {
        added.push(entry);
      }),
    };
  };

  it("registers each downloaded archive under the url MapLibre will ask for", async () => {
    const { assets, region, sources } = await downloaded(
      [archive("terrain"), archive("contours")],
      ["terrain", "contours"],
    );
    const protocol = registrar();
    const served = installOfflineArchives({ regions: [region], sources, assets, protocol });

    expect(served).toEqual([
      "https://self-hosted.invalid/terrain.pmtiles",
      "https://self-hosted.invalid/contours.pmtiles",
    ]);
    expect(protocol.added.map((entry) => entry.source.getKey())).toEqual(served);
  });

  it("registers archives that read the stored bytes, keyed by what download() wrote", async () => {
    // The two halves joined: the url the style names, resolving to the blob this region wrote.
    // A key derived any other way would agree with `download()` until the day one of them moved.
    const { assets, region, sources } = await downloaded([archive("terrain")], ["terrain"]);
    const stored = await bytesOf(await assets.get(await keyOf(assets, "terrain")));

    const protocol = registrar();
    installOfflineArchives({ regions: [region], sources, assets, protocol });

    const registered = protocol.added[0] as PMTiles;
    const read = new Uint8Array((await registered.source.getBytes(0, stored.byteLength)).data);
    expect([...read], "the registered archive serves the downloaded bytes").toEqual([...stored]);
  });

  it("lets the most recently downloaded region win when two cover the same source", async () => {
    // `Protocol` keys by url and the last `add` wins, so the order is the rule. "Whichever
    // list() yielded last" is not a rule anyone can reason about when one copy is stale.
    const assets = createMemoryMapAssetStore();
    const sources = [archive("terrain")];
    const store = createPMTilesRegionStore({ sources, assets, fetcher: fetcher() });
    const older = {
      ...(await store.download({ ...REGION, sourceIds: ["terrain"] })),
      downloadedAt: 1,
    };
    const newer = {
      ...(await store.download({ ...REGION, sourceIds: ["terrain"] })),
      downloadedAt: 2,
    };

    const protocol = registrar();
    installOfflineArchives({ regions: [newer, older], sources, assets, protocol });

    expect(protocol.added).toHaveLength(2);
    const last = protocol.added[1] as PMTiles;
    await assets.put(`mapatlas/archive/${newer.id}/terrain`, new Blob([new Uint8Array([42])]));
    expect(
      [...new Uint8Array((await last.source.getBytes(0, 1)).data)],
      "the registration left standing reads the newer region's archive",
    ).toEqual([42]);
  });

  it("ranks a region with no downloadedAt below one that has it", async () => {
    // `downloadedAt` is optional on `OfflineRegion`, so a hand-built or older manifest can
    // arrive without one. It sorts first, and therefore loses: a region that cannot say when it
    // was downloaded has no claim to being the newer copy.
    const { assets, region, sources } = await downloaded([archive("terrain")], ["terrain"]);
    // Built by omitting the key, not by assigning `undefined`: under `exactOptionalPropertyTypes`
    // those are different types, and only the first is what a manifest lacking the field
    // actually deserialises to.
    const undated: OfflineRegion = { ...REGION, id: "undated", sourceIds: ["terrain"] };

    const protocol = registrar();
    installOfflineArchives({ regions: [region, undated], sources, assets, protocol });

    const last = protocol.added[1] as PMTiles;
    await assets.put(`mapatlas/archive/${region.id}/terrain`, new Blob([new Uint8Array([7])]));
    expect(
      [...new Uint8Array((await last.source.getBytes(0, 1)).data)],
      "the dated region is the registration left standing",
    ).toEqual([7]);
  });

  it("skips a manifest entry for a source this app no longer configures", async () => {
    // Not a refusal: the region records a past download, no style can name an unconfigured
    // source, and there is no url to register it under. Unlike download(), where a skip would
    // produce a region that lies about its own contents.
    const { assets, region } = await downloaded([archive("terrain")], ["terrain"]);
    const protocol = registrar();
    const served = installOfflineArchives({ regions: [region], sources: [], assets, protocol });
    expect(served).toEqual([]);
    expect(protocol.added).toEqual([]);
  });

  it("registers nothing when no region has been downloaded", async () => {
    const assets = createMemoryMapAssetStore();
    const protocol = registrar();
    expect(
      installOfflineArchives({ regions: [], sources: [archive("terrain")], assets, protocol }),
    ).toEqual([]);
    expect(protocol.added).toEqual([]);
  });
});
