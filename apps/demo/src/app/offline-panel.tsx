// SPDX-License-Identifier: Apache-2.0

/**
 * The demo's offline-region control.
 *
 * **What it is for.** Everything else in this app works because a server is reachable. This is
 * the one control that makes the map's bytes local.
 *
 * **The store is authoritative, and `useOfflineRegions` is what makes it so.** The published hook
 * re-lists after every mutation and guards the stale-load and store-replacement races; a
 * hand-rolled list → mutate → list here would be a second implementation of that, wrong in the
 * ways the hook already documents.
 *
 * **What the list proves, and what it does not.** Re-reading the store proves the *manifest*
 * state — that a region exists and which sources it names. It does **not** prove the archives
 * were completely copied: a manifest naming three sources while only two blobs landed lists
 * identically, and `installOfflineArchives` does not read the blobs either. The missing one
 * becomes observable only when PMTiles asks for bytes, which is 5b's evidence and not this
 * panel's claim. The wording below is chosen to say the narrower, true thing.
 */

import { useCallback, useState } from "react";
import type { ReactElement } from "react";

import type { TileSource } from "@mapatlas/core";
import { useOfflineRegions } from "@mapatlas/react";

import { demoRegionRequest, installDownloadedRegions } from "./offline.js";
import type { DemoOffline, OfflineStatus } from "./offline.js";

export interface OfflinePanelProps {
  readonly offline: DemoOffline;
  readonly sources: TileSource[];
  readonly status: OfflineStatus;
  readonly onChanged: (status: OfflineStatus) => void;
}

type Busy = "idle" | "downloading" | "deleting";

export function OfflinePanel({
  offline,
  sources,
  status,
  onChanged,
}: OfflinePanelProps): ReactElement {
  const { regions, download, remove } = useOfflineRegions(offline.store);
  const [busy, setBusy] = useState<Busy>("idle");
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [deleted, setDeleted] = useState(false);

  /**
   * **Nothing declared, nothing to download.**
   *
   * `download({ sourceIds: [] })` is legal: it loops over no sources and writes a manifest of
   * zero bytes. The panel would then report a stored region that contains nothing, and re-reading
   * the store would faithfully confirm it — a vacuous success no readback can catch. A demo
   * opened with no archive URLs is a valid state (it renders a blank style), so the answer is to
   * refuse the download rather than to treat the state as broken.
   */
  const downloadable = sources.length > 0;

  const doDownload = useCallback(async () => {
    setBusy("downloading");
    setFailure(undefined);
    setDeleted(false);
    try {
      await download(demoRegionRequest(sources));
      onChanged(await installDownloadedRegions(offline, sources));
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy("idle");
    }
  }, [download, offline, onChanged, sources]);

  const doDelete = useCallback(async () => {
    setBusy("deleting");
    setFailure(undefined);
    try {
      for (const region of regions) await remove(region.id);
      /**
       * **What deletion actually leaves behind.** The persistent region is gone; the protocol
       * registration in *this* realm is not, and bytes already cached may still answer. An
       * uncached range now goes to `MapAssetStore`, finds nothing and raises
       * `MissingArchiveError` — so the current document is neither cleanly serving nor cleanly
       * offline, and only a reload reaches the authoritative post-delete state. Saying "still
       * serving" claimed more than is true; saying "gone" claims less.
       */
      setDeleted(true);
      // Storage-scoped and therefore true: the manifests and blobs are gone. Nothing here
      // claims anything about this realm's registrations, which outlive the delete.
      onChanged({ regions: 0, storedSourceIds: [], bytes: 0 });
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy("idle");
    }
  }, [onChanged, regions, remove]);

  return (
    <section className="app-offline" id="offline">
      <h2>Offline map</h2>
      <p
        id="offline-status"
        data-regions={String(status.regions)}
        data-stored={status.storedSourceIds.join(",")}
        data-bytes={String(status.bytes)}
        data-busy={busy}
        data-downloadable={String(downloadable)}
      >
        {!downloadable
          ? "No map archives are configured, so there is nothing to store."
          : status.regions === 0
            ? "No region downloaded. The map needs the network."
            : `${String(status.regions)} region stored, ${String(status.bytes)} bytes, naming ${
                status.storedSourceIds.length === 0
                  ? "no sources"
                  : status.storedSourceIds.join(", ")
              }.`}
      </p>
      {deleted ? (
        <p id="offline-deleted">
          Deleted from offline storage. Reload to reset this map&rsquo;s installed archives and
          cached bytes.
        </p>
      ) : null}
      <button
        id="offline-download"
        type="button"
        onClick={() => void doDownload()}
        disabled={busy !== "idle" || !downloadable}
      >
        Download this region
      </button>
      <button
        id="offline-delete"
        type="button"
        onClick={() => void doDelete()}
        disabled={busy !== "idle" || regions.length === 0}
      >
        Delete downloaded region
      </button>
      {failure === undefined ? null : (
        <p id="offline-failure" role="alert">{`The region was not stored: ${failure}`}</p>
      )}
    </section>
  );
}
