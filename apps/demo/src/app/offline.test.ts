// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";

import type { OfflineRegion, TileSource } from "@mapatlas/core";

/**
 * The install step, tested directly.
 *
 * **Why not only through the panel.** The panel's tests mock this module, so the body below is
 * never run there — a mutation replacing the reported ids with `[]` survived every one of them.
 * The status this returns is what a scenario will read, so it is tested where it is produced.
 */

const seen = vi.hoisted(() => ({ installs: 0, lastRegions: 0 }));
vi.mock("@mapatlas/maplibre", () => ({
  pmtilesArchiveRegistrar: () => ({ add: () => undefined }),
}));
vi.mock("@mapatlas/offline-pmtiles", () => ({
  createPMTilesRegionStore: () => ({}),
  installOfflineArchives: ({ regions }: { regions: readonly OfflineRegion[] }) => {
    seen.installs += 1;
    seen.lastRegions = regions.length;
    // Deliberately different from anything the manifests name: the status must not be able to
    // pick this up, because these are registrations rather than storage.
    return ["registered-url-1", "registered-url-2"];
  },
}));
vi.mock("@mapatlas/storage-idb", () => ({ createIdbMapAssetStore: () => ({}) }));

const { installDownloadedRegions } = await import("./offline.js");

const SOURCES = [{ id: "demo-basemap" }, { id: "demo-terrain" }] as unknown as TileSource[];
const offlineWith = (regions: OfflineRegion[]) =>
  ({ assets: {}, store: { list: async () => regions } }) as never;

/** `over` is loosely typed so a test can pass `sizeBytes: undefined` — under
 *  `exactOptionalPropertyTypes` that differs from omitting it, and a manifest without a
 *  size is the case under test. */
const region = (over: Record<string, unknown> = {}): OfflineRegion =>
  ({
    id: "r1",
    sizeBytes: 100,
    sourceIds: ["demo-terrain", "demo-basemap"],
    ...over,
  }) as unknown as OfflineRegion;

describe("installDownloadedRegions", () => {
  it("reports nothing on a first visit, and does not install", async () => {
    // An empty store is what a first visit looks like — a valid state, not a failure, and there
    // is nothing to register.
    const before = seen.installs;

    await expect(installDownloadedRegions(offlineWith([]), SOURCES)).resolves.toStrictEqual({
      regions: 0,
      storedSourceIds: [],
      bytes: 0,
    });
    expect(seen.installs).toBe(before);
  });

  it("reports the ids the manifests name, not the urls that were registered", async () => {
    // **The distinction the whole status rename is about.** `installOfflineArchives` returns this
    // realm's registrations; those outlive a delete and say nothing about storage. The status is
    // storage-scoped, so it comes from the manifests.
    const status = await installDownloadedRegions(offlineWith([region()]), SOURCES);

    expect(status.storedSourceIds).toStrictEqual(["demo-basemap", "demo-terrain"]);
    expect(status.storedSourceIds, "the status picked up registered urls").not.toContain(
      "registered-url-1",
    );
  });

  it("still installs, which is the reason it runs before the map mounts", async () => {
    const before = seen.installs;

    await installDownloadedRegions(offlineWith([region()]), SOURCES);

    expect(seen.installs).toBe(before + 1);
    expect(seen.lastRegions).toBe(1);
  });

  it("sums the bytes across regions, and treats a manifest without a size as zero", async () => {
    // `sizeBytes` is optional on the published type; adding `undefined` would render as NaN and
    // read as a size.
    const status = await installDownloadedRegions(
      offlineWith([region({ id: "a", sizeBytes: 100 }), region({ id: "b", sizeBytes: undefined })]),
      SOURCES,
    );

    expect(status.bytes).toBe(100);
    expect(status.regions).toBe(2);
  });

  it("reports each source once, however many regions name it", async () => {
    const status = await installDownloadedRegions(
      offlineWith([region({ id: "a" }), region({ id: "b" })]),
      SOURCES,
    );

    expect(status.storedSourceIds).toStrictEqual(["demo-basemap", "demo-terrain"]);
  });
});
