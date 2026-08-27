// SPDX-License-Identifier: Apache-2.0
import "fake-indexeddb/auto";

import { newId } from "@mapatlas/core";
import type { Track } from "@mapatlas/core";
import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_ASSET_DATABASE_NAME, createIdbMapAssetStore } from "./map-asset-store.js";
import type { IdbMapAssetStore } from "./map-asset-store.js";
import { DEFAULT_DATABASE_NAME } from "./schema.js";
import { createIdbStorageAdapter } from "./storage-adapter.js";
import type { IdbStorageAdapter } from "./storage-adapter.js";

const T0 = 1_700_000_000_000;

const closers: { close(): Promise<void> }[] = [];
const names: string[] = [];

function freshPair(): { data: IdbStorageAdapter; assets: IdbMapAssetStore } {
  const suffix = newId();
  const dataName = `mapatlas-data-${suffix}`;
  const assetName = `mapatlas-assets-${suffix}`;
  names.push(dataName, assetName);

  const data = createIdbStorageAdapter({ databaseName: dataName });
  const assets = createIdbMapAssetStore({ databaseName: assetName });
  closers.push(data, assets);
  return { data, assets };
}

afterEach(async () => {
  for (const closer of closers.splice(0)) await closer.close();
  for (const name of names.splice(0)) indexedDB.deleteDatabase(name);
});

const blob = (text: string): Blob => new Blob([text], { type: "application/octet-stream" });

function makeTrack(): Track {
  return {
    id: newId(),
    startedAt: T0,
    status: "finalized",
    origin: "recorded",
    points: [
      { lat: 59.33, lng: 18.06, t: T0 },
      { lat: 59.34, lng: 18.07, t: T0 + 1000 },
    ],
    segments: [{ id: newId(), startIndex: 0, endIndex: 1, startedAt: T0 }],
  };
}

describe("MapAssetStore operations", () => {
  it("round-trips an asset", async () => {
    const { assets } = freshPair();
    await assets.put("region-1.pmtiles", blob("map bytes"));

    const stored = await assets.get("region-1.pmtiles");
    expect(await stored?.text()).toBe("map bytes");
  });

  it("returns undefined for an unknown key", async () => {
    const { assets } = freshPair();
    expect(await assets.get("nothing")).toBeUndefined();
  });

  it("overwrites on a second put", async () => {
    const { assets } = freshPair();
    await assets.put("k", blob("first"));
    await assets.put("k", blob("second"));

    expect(await (await assets.get("k"))?.text()).toBe("second");
    expect(await assets.list()).toEqual(["k"]);
  });

  it("lists what it holds", async () => {
    const { assets } = freshPair();
    await assets.put("b", blob("2"));
    await assets.put("a", blob("1"));

    expect((await assets.list()).sort()).toEqual(["a", "b"]);
  });

  it("deletes one asset, idempotently", async () => {
    const { assets } = freshPair();
    await assets.put("a", blob("1"));
    await assets.put("b", blob("2"));

    await assets.delete("a");
    await assets.delete("a");

    expect(await assets.list()).toEqual(["b"]);
  });

  it("estimates size from what it holds", async () => {
    const { assets } = freshPair();
    await assets.put("a", blob("1234567890"));
    await assets.put("b", blob("12345"));

    expect(await assets.estimateBytes()).toBe(15);
  });

  it("estimates zero when empty", async () => {
    const { assets } = freshPair();
    expect(await assets.estimateBytes()).toBe(0);
  });

  it("survives closing and reopening", async () => {
    const databaseName = `mapatlas-assets-reopen-${newId()}`;
    names.push(databaseName);

    const first = createIdbMapAssetStore({ databaseName });
    await first.put("region.pmtiles", blob("bytes"));
    await first.close();

    const second = createIdbMapAssetStore({ databaseName });
    closers.push(second);
    expect(await (await second.get("region.pmtiles"))?.text()).toBe("bytes");
  });
});

describe("the two stores are genuinely separate (ADR-0016)", () => {
  it("uses different database names by default", () => {
    // Not merely different object stores: sharing a name would put both behind one
    // lifecycle — one deleteDatabase, one upgrade, one accidental clear away from taking
    // the user's trips with the basemap.
    expect(DEFAULT_ASSET_DATABASE_NAME).not.toBe(DEFAULT_DATABASE_NAME);
  });

  it("clearing user data leaves downloaded map assets intact", async () => {
    const { data, assets } = freshPair();
    const track = makeTrack();
    await data.saveTrack(track);
    await assets.put("region.pmtiles", blob("hundreds of megabytes"));

    await data.clearAll();

    // Signing out must not force a re-download.
    expect(await assets.get("region.pmtiles")).toBeDefined();
    expect(await assets.list()).toEqual(["region.pmtiles"]);
    expect(await data.listTrackSummaries()).toEqual([]);
  });

  it("clearing map assets leaves tracks, events and blobs intact", async () => {
    const { data, assets } = freshPair();
    const track = makeTrack();
    const photoKey = await data.putBlob(blob("photo"));
    await data.saveTrack(track);
    await data.saveEvent({
      id: newId(),
      trackId: track.id,
      position: { lat: 59.33, lng: 18.06 },
      occurredAt: T0,
      media: [{ id: newId(), mime: "image/jpeg", blobKey: photoKey }],
      tags: [],
    });
    await assets.put("region.pmtiles", blob("map"));

    await assets.clear();

    expect(await assets.list()).toEqual([]);
    expect(await data.getTrack(track.id)).toEqual(track);
    expect(await data.listEvents()).toHaveLength(1);
    expect(await (await data.getBlob(photoKey))?.text()).toBe("photo");
  });

  it("deleting a track does not reach into the asset store", async () => {
    const { data, assets } = freshPair();
    const track = makeTrack();
    await data.saveTrack(track);
    await assets.put("region.pmtiles", blob("map"));

    await data.deleteTrack(track.id);

    expect(await assets.list()).toEqual(["region.pmtiles"]);
  });

  it("keeps its own keyspace, so identical keys do not collide", async () => {
    const { data, assets } = freshPair();
    // A photo blob and a map asset can be named the same thing without meeting.
    await assets.put("shared-key", blob("map bytes"));
    const photoKey = await data.putBlob(blob("photo bytes"));

    expect(await (await assets.get("shared-key"))?.text()).toBe("map bytes");
    expect(await (await data.getBlob(photoKey))?.text()).toBe("photo bytes");
    expect(await data.getBlob("shared-key")).toBeUndefined();
  });

  it("survives the other store being deleted entirely", async () => {
    const { data, assets } = freshPair();
    await assets.put("region.pmtiles", blob("map"));
    await data.saveTrack(makeTrack());

    // The bluntest instrument a consumer has: dropping the user-data store outright.
    await data.close();
    const dataName = names[names.length - 2];
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase(dataName ?? "");
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    });

    expect(await (await assets.get("region.pmtiles"))?.text()).toBe("map");
  });
});
