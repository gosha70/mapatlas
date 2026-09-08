// @vitest-environment happy-dom
// SPDX-License-Identifier: Apache-2.0
import { act, createElement, StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { OfflineRegion, TileSource } from "@mapatlas/core";

import type { OfflineStatus } from "./offline.js";

/**
 * The offline control, driven through the shipped component.
 *
 * **What it must report, and why substrings are not enough.** A download that copied two archives
 * out of three, or none at all, looks identical to a working one from a control that only says
 * "done" — and the difference is exactly what increment 5 exists to prove. So the panel reports
 * counts and source ids, and these tests read them.
 */

const installed = vi.hoisted(() => ({
  calls: 0,
  storedSourceIds: ["demo-basemap"],
  /** Reject *after* `download()` has stored the archives — the second half of `doDownload`. */
  rejects: false,
}));
vi.mock("./offline.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("./offline.js");
  return {
    ...actual,
    installDownloadedRegions: async (offline: { store: { list: () => Promise<unknown[]> } }) => {
      installed.calls += 1;
      if (installed.rejects) throw new Error("the archive could not be registered");
      const regions = await offline.store.list();
      return regions.length === 0
        ? { regions: 0, storedSourceIds: [], bytes: 0 }
        : { regions: regions.length, storedSourceIds: installed.storedSourceIds, bytes: 4096 };
    },
  };
});

const { OfflinePanel } = await import("./offline-panel.js");

const SOURCES = [{ id: "demo-basemap" }, { id: "demo-terrain" }] as unknown as TileSource[];

/** A store whose contents a test controls. */
function store(
  over: {
    download?: () => Promise<OfflineRegion>;
    /** Given the id and the held list, so an override can remove some regions and then fail. */
    delete?: (id: string, held: OfflineRegion[]) => Promise<void>;
  } = {},
) {
  const held: OfflineRegion[] = [];
  const spy = { downloads: 0, deletes: 0 };
  return {
    spy,
    held,
    offline: {
      assets: {},
      store: {
        download: async () => {
          spy.downloads += 1;
          const region = { id: `r${String(held.length + 1)}`, sizeBytes: 4096 } as OfflineRegion;
          if (over.download !== undefined) return over.download();
          held.push(region);
          return region;
        },
        list: async () => [...held],
        delete: async (id: string) => {
          spy.deletes += 1;
          if (over.delete !== undefined) return over.delete(id, held);
          const at = held.findIndex((region) => region.id === id);
          if (at >= 0) held.splice(at, 1);
          return undefined;
        },
        estimateSize: async () => 4096,
      },
    },
  };
}

let root: Root | undefined;
let host: HTMLElement | undefined;

/**
 * The panel is **controlled**, so the harness has to be its parent.
 *
 * A first version recorded `onChanged` and never fed the result back, leaving `status.regions` at
 * zero — so the delete button stayed disabled after a download and two tests failed for a reason
 * that was entirely the harness's. The real parent holds this state; so does this.
 */
const render = async (
  offline: unknown,
  initial: OfflineStatus = { regions: 0, storedSourceIds: [], bytes: 0 },
) => {
  const seen: OfflineStatus[] = [];
  const Host = () => {
    const [status, setStatus] = useState(initial);
    return createElement(OfflinePanel, {
      offline: offline as never,
      sources: SOURCES,
      status,
      onChanged: (next: OfflineStatus) => {
        seen.push(next);
        setStatus(next);
      },
    });
  };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(createElement(StrictMode, null, createElement(Host)));
  });
  return { seen };
};

/** Render with a chosen source stack, for the no-sources case. */
const renderWith = async (offline: unknown, sources: TileSource[], initial: OfflineStatus) => {
  const seen: OfflineStatus[] = [];
  const Host = () => {
    const [status, setStatus] = useState(initial);
    return createElement(OfflinePanel, {
      offline: offline as never,
      sources,
      status,
      onChanged: (next: OfflineStatus) => {
        seen.push(next);
        setStatus(next);
      },
    });
  };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(createElement(StrictMode, null, createElement(Host)));
  });
  return { seen };
};

const click = async (id: string) => {
  const target = host?.querySelector<HTMLElement>(id);
  if (!target) throw new Error(`no ${id}`);
  await act(async () => {
    target.click();
  });
};

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = undefined;
  host?.remove();
  document.body.innerHTML = "";
  installed.calls = 0;
  installed.rejects = false;
});

describe("downloading a region", () => {
  it("restores the confirmed reading once a download succeeds", async () => {
    // The positive half of the invalidation below: if the state were never restored, the panel
    // would report nothing for ever and the tests that assert absence would all pass.
    const { offline } = store();

    await render(offline);
    await click("#offline-download");

    const line = host?.querySelector("#offline-status");
    expect(line?.getAttribute("data-confirmed")).toBe("true");
    expect(line?.getAttribute("data-regions")).toBe("1");
    expect(line?.getAttribute("data-stored")).toBe("demo-basemap");
  });

  it("invalidates the reading as soon as an attempt starts, before it can have failed", async () => {
    /**
     * **Invalidation belongs to the start of the mutation, not to its failure**, and the two are
     * only distinguishable here — on a *first* attempt, where no failure has happened yet. From
     * the moment `download()` is called the store may be changing, so the numbers beside it have
     * stopped being a reading of it. A version that invalidated only in the `catch` passes every
     * retry assertion, because after a failure the state is already invalid and simply stays that
     * way; this is the case that tells them apart.
     */
    let release: ((region: OfflineRegion) => void) | undefined;
    const { offline, held } = store({
      download: async () =>
        new Promise<OfflineRegion>((settle) => {
          release = (region) => {
            held.push(region);
            settle(region);
          };
        }),
    });

    await render(offline);
    await click("#offline-download");

    expect(release, "the download never reached the store").toBeDefined();
    expect(host?.querySelector("#offline-failure"), "this case is before any failure").toBeNull();
    const inFlight = host?.querySelector("#offline-status");
    expect(inFlight?.getAttribute("data-busy")).toBe("downloading");
    expect(inFlight?.getAttribute("data-confirmed")).toBe("false");
    expect(
      inFlight?.hasAttribute("data-regions"),
      "the previous reading was still published while the store was being written",
    ).toBe(false);

    await act(async () => {
      release?.({ id: "r1", sizeBytes: 4096 } as OfflineRegion);
    });
    expect(host?.querySelector("#offline-status")?.getAttribute("data-confirmed")).toBe("true");
  });

  it("does not republish the stale reading when a retry starts", async () => {
    /**
     * **The window this closes.** Confirmation was derived from `failure`, and both handlers clear
     * `failure` as they begin — so pressing Download again after a failure re-published the
     * pre-failure numbers as `data-confirmed="true"` the instant the retry started, before it had
     * established anything at all. The reading is invalidated when the mutation *starts*, so the
     * assertion below is taken **while the retry is still in flight**.
     */
    let release: ((region: OfflineRegion) => void) | undefined;
    let firstCall = true;
    const { offline, held } = store({
      download: async () => {
        if (firstCall) {
          firstCall = false;
          throw new Error("quota exceeded");
        }
        // A download that has not settled: the panel is mid-retry for as long as this is pending.
        return new Promise<OfflineRegion>((settle) => {
          release = (region) => {
            held.push(region);
            settle(region);
          };
        });
      },
    });

    await render(offline);
    await click("#offline-download");
    expect(host?.querySelector("#offline-status")?.getAttribute("data-confirmed")).toBe("false");

    await click("#offline-download");

    // Mid-flight: the failure notice is gone, because the retry cleared it, and that is exactly
    // the moment the old derivation published the stale numbers again.
    expect(host?.querySelector("#offline-failure"), "the retry never started").toBeNull();
    expect(release, "the retry never reached the store").toBeDefined();
    const inFlight = host?.querySelector("#offline-status");
    expect(inFlight?.getAttribute("data-busy")).toBe("downloading");
    expect(inFlight?.getAttribute("data-confirmed")).toBe("false");
    expect(
      inFlight?.hasAttribute("data-regions"),
      "the pre-failure reading came back the moment the retry began",
    ).toBe(false);

    // And it comes back only when the retry has produced a reading of its own.
    await act(async () => {
      release?.({ id: "r1", sizeBytes: 4096 } as OfflineRegion);
    });

    const settled = host?.querySelector("#offline-status");
    expect(settled?.getAttribute("data-confirmed")).toBe("true");
    expect(settled?.getAttribute("data-regions")).toBe("1");
  });

  it("reports what the store holds afterwards, not that a button was pressed", async () => {
    // Read back from the store rather than from the operation's own return: a download that
    // resolved while storing nothing would otherwise report success.
    const { offline, spy } = store();

    const { seen } = await render(offline);
    await click("#offline-download");

    expect(spy.downloads).toBe(1);
    expect(installed.calls, "the store was never read back after downloading").toBeGreaterThan(0);
    expect(seen.at(-1)).toMatchObject({ regions: 1, storedSourceIds: ["demo-basemap"] });
  });

  it("surfaces a failed download instead of silently reporting nothing", async () => {
    const { offline } = store({
      download: async () => {
        throw new Error("quota exceeded");
      },
    });

    await render(offline);
    await click("#offline-download");

    expect(host?.querySelector("#offline-failure")?.textContent ?? "").toContain("quota exceeded");
  });

  it("does not say nothing was stored when the archives were stored and the install failed", async () => {
    /**
     * **`doDownload` is two operations, and only the first one stores.** `download()` copies the
     * archives; `installDownloadedRegions` then re-lists and registers them. A rejection from the
     * second arrives with the bytes already in the store — so the notice this once carried,
     * *"The region was not stored"*, was exactly false, and it invited the reader to press
     * Download again and copy everything a second time.
     */
    const { offline, held } = store();
    installed.rejects = true;

    await render(offline);
    await click("#offline-download");

    // The premise: the archives really are stored. Without this the assertion below would hold
    // for a run in which the download had failed too, which is a different case entirely.
    expect(held, "nothing was stored, so this is not the case under test").toHaveLength(1);

    const notice = host?.querySelector("#offline-failure");
    expect(notice?.textContent ?? "").toContain("the archive could not be registered");
    expect(notice?.getAttribute("data-attempt")).toBe("download");
    expect(
      notice?.textContent ?? "",
      "the notice claimed nothing was stored while the archives were in the store",
    ).not.toContain("not stored");

    /**
     * **And the status line stops reporting too.** `status` only advances on success, so it still
     * holds the pre-download reading — zero regions — while the archives are in the store and the
     * hook has already enabled Delete against them. The attributes are gone rather than zeroed: a
     * `0` here is indistinguishable from a measured zero.
     */
    const line = host?.querySelector("#offline-status");
    expect(line?.getAttribute("data-confirmed")).toBe("false");
    expect(line?.hasAttribute("data-regions"), "a stale region count survived the failure").toBe(
      false,
    );
    expect(line?.hasAttribute("data-stored")).toBe(false);
    expect(line?.hasAttribute("data-bytes")).toBe(false);
    expect(line?.textContent ?? "").not.toContain("No region downloaded");

    // The contradiction made concrete: this button is enabled off the hook's own re-list, so the
    // line above cannot be allowed to say there is nothing there.
    expect(host?.querySelector<HTMLButtonElement>("#offline-delete")?.disabled).toBe(false);
  });
});

describe("a region with no sources is refused, not stored", () => {
  it("does not offer a download when no archives are configured", async () => {
    // **The vacuous success this closes.** `download({ sourceIds: [] })` is legal: it loops over
    // no sources and writes a manifest of zero bytes. The panel would then report a stored region
    // containing nothing, and re-reading the store would faithfully confirm it — readback cannot
    // catch this. A demo opened with no archive URLs is a valid state, so the download is refused
    // rather than the state treated as broken.
    const { offline, spy } = store();

    await renderWith(offline, [], { regions: 0, storedSourceIds: [], bytes: 0 });

    expect(host?.querySelector<HTMLButtonElement>("#offline-download")?.disabled).toBe(true);
    expect(host?.querySelector("#offline-status")?.getAttribute("data-downloadable")).toBe("false");

    await click("#offline-download");
    expect(spy.downloads, "a region with no sources was stored").toBe(0);
  });

  it("offers it once there is a stack to store", async () => {
    const { offline } = store();

    await render(offline);

    expect(host?.querySelector<HTMLButtonElement>("#offline-download")?.disabled).toBe(false);
  });
});

describe("deleting a region", () => {
  it("is offered only when there is something to delete", async () => {
    const { offline } = store();

    await render(offline);
    expect(host?.querySelector<HTMLButtonElement>("#offline-delete")?.disabled).toBe(true);

    await click("#offline-download");
    expect(host?.querySelector<HTMLButtonElement>("#offline-delete")?.disabled).toBe(false);
  });

  it("reports neither a wrong claim nor a stale count when a delete is partial", async () => {
    /**
     * **Genuinely partial, because that is the case both defects hide in.** `doDelete` removes
     * regions in a loop, so a rejection part-way through leaves *some* gone. The notice this once
     * carried — "the region was not stored" — was the opposite of the truth for a region that had
     * been stored and not removed; and the status line went on displaying the pre-delete count for
     * a store that no longer matched it.
     *
     * Nothing below asserts what the store now holds. The panel did not read it, and inferring it
     * from which button was pressed is the mistake being closed.
     */
    let attempts = 0;
    const { offline, held } = store({
      delete: async (id, kept) => {
        attempts += 1;
        if (attempts > 1) throw new Error("the store went away");
        kept.splice(
          kept.findIndex((region) => region.id === id),
          1,
        );
      },
    });

    await render(offline);
    await click("#offline-download");
    await click("#offline-download");
    expect(host?.querySelector("#offline-status")?.getAttribute("data-regions")).toBe("2");

    await click("#offline-delete");

    // The premise: one region really was removed and one really was not. Without it this would
    // pass for a delete that failed on its first call, which is a different case.
    expect(attempts, "the loop stopped before it could be partial").toBeGreaterThan(1);
    expect(held, "the deletion was not partial, so this is not the case under test").toHaveLength(
      1,
    );

    const notice = host?.querySelector("#offline-failure");
    expect(notice?.textContent ?? "").toContain("the store went away");
    expect(notice?.getAttribute("data-attempt")).toBe("delete");
    expect(
      notice?.textContent ?? "",
      "a failed delete reported that the region had not been stored",
    ).not.toContain("not stored");

    const line = host?.querySelector("#offline-status");
    expect(line?.getAttribute("data-confirmed")).toBe("false");
    expect(
      line?.getAttribute("data-regions"),
      "the pre-delete count survived a deletion that changed the store",
    ).toBeNull();
    expect(line?.textContent ?? "").not.toContain("2 region");
  });

  it("invalidates the reading while a deletion is in flight", async () => {
    // The same rule on the other button: from the first `remove()` the count beside it has
    // stopped being a reading of the store, whether or not the loop goes on to fail.
    let release: (() => void) | undefined;
    const { offline } = store({
      delete: async (id, kept) =>
        new Promise<void>((settle) => {
          release = () => {
            kept.splice(
              kept.findIndex((region) => region.id === id),
              1,
            );
            settle();
          };
        }),
    });

    await render(offline);
    await click("#offline-download");
    expect(host?.querySelector("#offline-status")?.getAttribute("data-regions")).toBe("1");

    await click("#offline-delete");

    expect(release, "the deletion never reached the store").toBeDefined();
    expect(host?.querySelector("#offline-failure"), "this case is before any failure").toBeNull();
    const inFlight = host?.querySelector("#offline-status");
    expect(inFlight?.getAttribute("data-busy")).toBe("deleting");
    expect(inFlight?.getAttribute("data-confirmed")).toBe("false");
    expect(
      inFlight?.hasAttribute("data-regions"),
      "the pre-delete count was still published while the store was being emptied",
    ).toBe(false);

    await act(async () => {
      release?.();
    });
    const settled = host?.querySelector("#offline-status");
    expect(settled?.getAttribute("data-confirmed")).toBe("true");
    expect(settled?.getAttribute("data-regions")).toBe("0");
  });

  it("removes every stored region and reports none left", async () => {
    const { offline, spy } = store();

    const { seen } = await render(offline);
    await click("#offline-download");
    await click("#offline-delete");

    expect(spy.deletes).toBe(1);
    expect(seen.at(-1)).toMatchObject({ regions: 0, bytes: 0 });
  });

  it("makes no machine-readable claim that this realm's registrations are gone", async () => {
    // **The failure this closes, and it is the sharper half.** The prose was corrected first
    // while the status still reported `served: []`, which says "this document no longer serves
    // those archives" — false, because the PMTiles registrations outlive the delete and cached
    // data may still answer. A scenario reading that attribute would have passed while the realm
    // was still serving: the right assertion against the wrong fact.
    //
    // Every field the panel exposes is storage-scoped. What a reload resets is said in words,
    // next to the button that makes it necessary, and is deliberately not modelled as state
    // nobody consumes.
    const { offline } = store();

    await render(offline);
    await click("#offline-download");
    await click("#offline-delete");

    const line = host?.querySelector("#offline-status");
    expect(line?.getAttribute("data-stored"), "storage is empty, which is true").toBe("");
    expect(
      line?.getAttribute("data-served"),
      "a registration-scoped claim reappeared in the status",
    ).toBeNull();
    expect(
      line?.getAttribute("data-installed"),
      "a registration-scoped claim reappeared in the status",
    ).toBeNull();
    // The realm's state is described where a person will act on it, not asserted as data.
    expect(host?.querySelector("#offline-deleted")?.textContent ?? "").toContain("Reload");
  });

  it("says the realm needs a reload, rather than that it is clean or still serving", async () => {
    // **Neither claim was true.** The persistent region is gone, but the protocol registration in
    // this realm is not, and bytes already cached may still answer — while an *uncached* range
    // now finds nothing in `MapAssetStore` and raises `MissingArchiveError`. So the document is
    // neither serving nor offline, and only a reload reaches the authoritative state. An earlier
    // version reported the deleted sources as still served, which claimed more than is true.
    // Stored for real first: the button's enablement comes from the hook's list, so a status
    // prop claiming a region while the store holds none would leave the control disabled and the
    // assertion below would pass against a click that never happened.
    const { offline } = store();

    await render(offline);
    await click("#offline-download");
    await click("#offline-delete");

    const note = host?.querySelector("#offline-deleted")?.textContent ?? "";
    expect(note).toContain("Reload");
    expect(note, "the panel claimed the archives were still serving").not.toContain("serving");
  });
});
