// SPDX-License-Identifier: Apache-2.0

import { PMTiles } from "pmtiles";
import type { RangeResponse, Source } from "pmtiles";

import type { MapAssetStore, OfflineRegion, TileSource } from "@mapatlas/core";

import { archiveKey } from "./region-store.js";

/**
 * A region's manifest names a source whose archive blob is no longer in the asset store.
 *
 * Reachable, and not a programming error: `MapAssetStore` holds evictable bytes (ADR-0016), so
 * a browser reclaiming quota can take an archive while its manifest survives — and any consumer
 * with a key can `delete()` one. Raised rather than answered with empty bytes, because empty
 * bytes decode as "this archive contains nothing here", which renders as an ocean where the map
 * should be. A blank map is the failure ADR-0017 is about; an error is at least legible.
 */
export class MissingArchiveError extends Error {
  readonly key: string;

  constructor(key: string) {
    super(
      `no archive is stored under ${JSON.stringify(key)}. The region's manifest still names it, ` +
        `so the bytes were evicted or deleted after download; re-download the region.`,
    );
    this.name = "MissingArchiveError";
    this.key = key;
  }
}

/**
 * A PMTiles `Source` that reads a downloaded archive out of the `MapAssetStore`.
 *
 * This is the offline half of the provenance claim. Online, `pmtiles` reads an archive with
 * HTTP range requests; offline it reads the same ranges out of a stored `Blob`, and the bytes
 * it returns are the bytes `download()` wrote — nothing re-fetches, and nothing consults an
 * HTTP cache. That distinction is the whole point: zero network requests would also be produced
 * by a service worker or a warm cache, neither of which is a downloaded region.
 *
 * `getKey()` returns the source's **own url**, unchanged. MapLibre asks for
 * `pmtiles://<TileSource.url>`, `Protocol` looks the archive up by that key, and so an offline
 * map and an online one run the *same style*. Rewriting urls to point at local storage would
 * mean the style differs by connectivity, and every layer, filter and expression built on those
 * ids would have two forms to keep in step.
 */
export function createStoredArchiveSource(options: {
  assets: MapAssetStore;
  key: string;
  url: string;
}): Source {
  const { assets, key, url } = options;
  return {
    getKey: () => url,
    getBytes: async (offset: number, length: number): Promise<RangeResponse> => {
      const blob = await assets.get(key);
      if (blob === undefined) throw new MissingArchiveError(key);
      // `Blob.slice` clamps to the blob's end, which is what a range request does too, so a
      // reader asking for more than the archive holds gets the tail rather than an error.
      const data = await blob.slice(offset, offset + length).arrayBuffer();
      // No `etag`: these bytes are immutable under this key. `archiveKey` is per region and
      // source and written once by `download()`, so there is no version for a reader to be
      // stale against — and inventing one would let `pmtiles` retry against an identity that
      // means nothing here.
      return { data };
    },
  };
}

/** The slice of `pmtiles`'s `Protocol` this needs — injectable, so a test needs no MapLibre. */
export interface ArchiveRegistrar {
  add(archive: PMTiles): void;
}

/**
 * Point the PMTiles protocol at every archive these regions downloaded.
 *
 * Call it once after `store.list()`, with a registrar obtained from the renderer, and **before
 * the first `pmtiles` source is added** — not "before the map is created", which under the
 * renderer's lazy registration names an instant at which no `Protocol` exists yet. An archive
 * registered after MapLibre has already requested a tile from that url does not retroactively
 * serve it.
 *
 * From then on any style url the regions cover resolves locally, and anything they do not still
 * goes to the network. Returns the urls now served locally, so a consumer can say which layers
 * are actually offline instead of guessing from the absence of requests.
 */
export function installOfflineArchives(options: {
  regions: readonly OfflineRegion[];
  sources: readonly TileSource[];
  assets: MapAssetStore;
  protocol: ArchiveRegistrar;
}): string[] {
  const { regions, sources, assets, protocol } = options;
  const served: string[] = [];
  // Oldest first, so that when two regions cover the same source the most recently downloaded
  // registration is the one left standing — `Protocol` keys by url and the last `add` wins.
  // Both copies are whole archives of the same source, so this decides only *which* copy is
  // read; it is ordered anyway, because "whichever `list()` happened to yield last" is a rule
  // nobody can reason about when one of the two turns out to be stale.
  const ordered = [...regions].sort((a, b) => (a.downloadedAt ?? 0) - (b.downloadedAt ?? 0));
  for (const region of ordered) {
    for (const sourceId of region.sourceIds ?? []) {
      const source = sources.find((candidate) => candidate.id === sourceId);
      // A manifest naming a source this app no longer configures. Skipped, not refused: the
      // region is a record of a past download, and there is no url to register it under. No
      // style can reference an unconfigured source, so nothing will ask for these bytes —
      // unlike `download()`, where skipping would produce a region that lies about its own
      // contents.
      if (source === undefined) continue;
      const key = archiveKey(region.id, sourceId);
      protocol.add(new PMTiles(createStoredArchiveSource({ assets, key, url: source.url })));
      served.push(source.url);
    }
  }
  return served;
}
