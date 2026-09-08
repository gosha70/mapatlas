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

const installed = vi.hoisted(() => ({ calls: 0, storedSourceIds: ["demo-basemap"] }));
vi.mock("./offline.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("./offline.js");
  return {
    ...actual,
    installDownloadedRegions: async (offline: { store: { list: () => Promise<unknown[]> } }) => {
      installed.calls += 1;
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
  over: { download?: () => Promise<OfflineRegion>; delete?: () => Promise<void> } = {},
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
          if (over.delete !== undefined) return over.delete();
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
});

describe("downloading a region", () => {
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
