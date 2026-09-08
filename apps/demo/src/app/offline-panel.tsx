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

/** Which button's work failed, so the notice can name it without describing the store. */
type Attempt = "download" | "delete";

/**
 * A failed attempt, reported **without claiming what is stored**.
 *
 * The first version of this notice read *"The region was not stored: …"* for every failure, and
 * that sentence is false in two of the three ways it can be reached. A rejected **delete** leaves
 * the region exactly where it was. And `doDownload` does two things: `download()` copies the
 * archives, then `installDownloadedRegions` re-lists and registers them — so a rejection from the
 * second arrives *after* the bytes are stored. In both cases the panel asserted a durable state
 * that was the opposite of the truth, and in the download case it invited the reader to download
 * everything again.
 *
 * Neither replacement sentence claims a state either. "The region could not be deleted" would be
 * its own version of the same mistake: `doDelete` removes regions in a loop, so a rejection on the
 * third leaves the first two gone. What this can honestly report is which attempt failed and why.
 */
interface Failure {
  readonly attempt: Attempt;
  readonly why: string;
}

export function OfflinePanel({
  offline,
  sources,
  status,
  onChanged,
}: OfflinePanelProps): ReactElement {
  const { regions, download, remove } = useOfflineRegions(offline.store);
  const [busy, setBusy] = useState<Busy>("idle");
  const [failure, setFailure] = useState<Failure | undefined>(undefined);
  const [deleted, setDeleted] = useState(false);
  /**
   * Whether `status` is still a reading of the store.
   *
   * **Its own state, deliberately not derived from `failure`.** It was derived, and both handlers
   * clear `failure` as they start — so pressing either button after a failure immediately
   * re-published the stale snapshot as confirmed, before the retry had established anything. The
   * two answer different questions: `failure` is what to tell the reader about the last attempt,
   * this is whether the numbers beside it still mean something.
   *
   * Invalidated when a mutation *starts*, because from that moment the store may be changing
   * under the last reading; restored only after a successful path has produced a new one. A
   * failure leaves it invalid, which is the same thing said in the other direction: nothing here
   * infers a store state from which button was pressed.
   */
  const [confirmed, setConfirmed] = useState(true);

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
    setConfirmed(false);
    try {
      await download(demoRegionRequest(sources));
      onChanged(await installDownloadedRegions(offline, sources));
      // Last, and only here: the reading it publishes is what makes the numbers true again.
      setConfirmed(true);
    } catch (error) {
      setFailure({
        attempt: "download",
        why: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy("idle");
    }
  }, [download, offline, onChanged, sources]);

  const doDelete = useCallback(async () => {
    setBusy("deleting");
    setFailure(undefined);
    setConfirmed(false);
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
      // Every region was removed, so the emptiness above is established rather than assumed.
      setConfirmed(true);
    } catch (error) {
      setFailure({
        attempt: "delete",
        why: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy("idle");
    }
  }, [onChanged, regions, remove]);

  return (
    <section className="app-offline" id="offline">
      <h2>Offline map</h2>
      {/**
       * **While an attempt is unresolved this reports nothing, rather than the last thing it
       * knew.** `status` only advances on success, so a download that stored the archives and
       * then failed to install them left this line saying "No region downloaded" with
       * `data-regions="0"` — beside a Delete button the hook had already enabled, because
       * `useOfflineRegions` re-lists on every mutation and had seen the region. A partial delete
       * does the same with the pre-delete count. Both are a stale snapshot presented as current.
       *
       * The numeric and source attributes are **removed**, not zeroed: a `0` is a reading, and a
       * reader — human or scenario — cannot tell a measured zero from a missing one. Nothing here
       * infers what the attempt did to the store; it says the reading is not current, and a
       * successful operation restores it.
       *
       * **The wording claims no cause.** It read "could not be read", which is true of only one
       * of the routes here: `installDownloadedRegions` can list the store perfectly and then fail
       * while registering, a download can fail before any read is attempted, and a deletion fails
       * while mutating rather than while reading. What is known is that the attempt did not
       * complete and the snapshot is no longer confirmed.
       */}
      {confirmed ? (
        <p
          id="offline-status"
          data-confirmed="true"
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
      ) : (
        <p
          id="offline-status"
          data-confirmed="false"
          data-busy={busy}
          data-downloadable={String(downloadable)}
        >
          {failure === undefined
            ? "What is stored is not confirmed while this attempt is running."
            : "The last attempt did not complete, so what is stored is no longer confirmed. " +
              "Reload to read it again."}
        </p>
      )}
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
        <p id="offline-failure" role="alert" data-attempt={failure.attempt}>
          {`The ${failure.attempt === "download" ? "download" : "deletion"} did not complete: ${failure.why}`}
        </p>
      )}
    </section>
  );
}
