// @vitest-environment happy-dom
// SPDX-License-Identifier: Apache-2.0
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { StrictMode, createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MapAssetStore, StorageAdapter } from "@mapatlas/core";

import { App } from "./app.js";
import { DEMO_CAMERA } from "./sources.js";
import type { DemoOffline } from "./offline.js";
import type { DemoStorage } from "./storage.js";

/**
 * The shell, rendered.
 *
 * **`Loop` is doubled here, and that is not a shortcut.** It builds a real MapLibre map and a
 * real recorder, neither of which exists in this lane; whether the loop works is `loop.test.tsx`'s
 * question and the browser lane's. What this lane can see is the boundary the *shell* owns — the
 * stack it resolves from the URL and hands down, and whether it reports its own state honestly.
 */
vi.mock("./loop.js", () => ({
  Loop: (props: Record<string, unknown>) =>
    createElement("div", {
      "data-testid": "map",
      "data-sources": String((props["sources"] as unknown[]).length),
      "data-terrain": props["terrain"] === null ? "none" : "on",
      // Serialised rather than counted: the camera is the one prop whose *value* decides whether
      // anything is drawn at all, and "a camera was passed" is satisfied by a camera pointing at
      // open ocean.
      "data-camera": JSON.stringify(props["initialCamera"] ?? null),
    }),
}));

const url = (query = ""): URL => new URL(`http://demo.invalid/${query}`);

/** A store pair whose reads a test controls. Neither method is optional: both are read on mount. */
function storage(
  over: { trips?: () => Promise<unknown>; assets?: () => Promise<unknown> } = {},
): DemoStorage & {
  tripReads: number;
  assetReads: number;
} {
  const doubles = {
    tripReads: 0,
    assetReads: 0,
    trips: {
      listTrackSummaries: () => {
        doubles.tripReads += 1;
        return (over.trips ?? (() => Promise.resolve([])))();
      },
    } as unknown as StorageAdapter,
    assets: {
      list: () => {
        doubles.assetReads += 1;
        return (over.assets ?? (() => Promise.resolve([])))();
      },
    } as unknown as MapAssetStore,
  };
  return doubles;
}

/**
 * A region store that holds nothing, for the shell's own tests.
 *
 * The shell's job is to install what is stored **before** the map mounts; whether an archive is
 * served is `offline.test.tsx`'s. An empty store is the first-visit state and is what these
 * tests want: the map should still render.
 */
const emptyOffline = (): DemoOffline =>
  ({
    store: {
      download: async () => {
        throw new Error("the shell's tests do not download");
      },
      list: async () => [],
      delete: async () => undefined,
      estimateSize: async () => 0,
    },
    assets: {},
  }) as unknown as DemoOffline;

let root: Root | undefined;
let host: HTMLElement | undefined;

const render = async (
  here: URL,
  stores: DemoStorage,
  makeOffline = emptyOffline,
): Promise<HTMLElement> => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      createElement(
        StrictMode,
        null,
        createElement(App, {
          here,
          storage: stores,
          makeOffline,
        }),
      ),
    );
  });
  return host;
};

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = undefined;
  host?.remove();
  document.body.innerHTML = "";
});

const statusOf = (root: HTMLElement): HTMLElement => {
  const found = root.querySelector<HTMLElement>("#shell-status");
  if (found === null) throw new Error("the shell rendered no status");
  return found;
};

describe("the shell reports what it can actually claim", () => {
  it("opens both stores and says so", async () => {
    // **Constructed is not open.** Both adapters open lazily, so holding them proves nothing —
    // a database that cannot be opened looks identical until something reads it. One read of
    // each is the smallest observation that separates the two.
    const stores = storage();
    const app = await render(url(), stores);

    expect(stores.tripReads, "the trip store was never read").toBeGreaterThan(0);
    expect(stores.assetReads, "the asset store was never read").toBeGreaterThan(0);
    expect(statusOf(app).dataset["status"]).toBe("ready");
  });

  it("reports a failure as a failure, naming it", async () => {
    // Not "starting" forever, and not "ready" — a shell that swallowed the error would show a
    // blank map and give a reader nothing to act on.
    const app = await render(url(), storage({ assets: () => Promise.reject(new Error("no idb")) }));

    expect(statusOf(app).dataset["status"]).toBe("failed");
    expect(app.textContent ?? "").toContain("no idb");
  });

  it("hands the loop the stack the URL asked for", async () => {
    const app = await render(
      url("?terrain=https://a.invalid/t.pmtiles&contours=https://a.invalid/c.pmtiles"),
      storage(),
    );
    const map = app.querySelector<HTMLElement>('[data-testid="map"]');

    expect(map?.dataset["sources"]).toBe("2");
    expect(map?.dataset["terrain"], "a DEM was declared but terrain was not raised").toBe("on");
  });

  it("opens the map at the demo's camera, not at MapLibre's world view", async () => {
    // **The defect this replaced.** With no camera the map opened on the whole world while the
    // archives cover 0.08 degrees of one massif; the canvas mounted, the attribution rendered,
    // the source count was right, and not one tile was ever fetched. Asserting the value rather
    // than its presence is the difference between the two.
    const app = await render(url("?terrain=https://a.invalid/t.pmtiles"), storage());
    const map = app.querySelector<HTMLElement>('[data-testid="map"]');

    expect(map?.dataset["camera"], "the map was left at the default view").toBe(
      JSON.stringify(DEMO_CAMERA),
    );
  });

  it("renders with no archives at all, and raises no terrain", async () => {
    // A valid state, not a degraded one: it is what a consumer sees before downloading anything.
    // Terrain naming a source that does not exist would be a broken style, not a plain map.
    const app = await render(url(), storage());
    const map = app.querySelector<HTMLElement>('[data-testid="map"]');

    expect(map?.dataset["sources"]).toBe("0");
    expect(map?.dataset["terrain"]).toBe("none");
    expect(statusOf(app).dataset["sources"]).toBe("0");
  });
});

describe("the settings panels are the app's own", () => {
  it("mounts the persistence control and the installation guidance exactly once each", async () => {
    // **Under StrictMode**, which double-invokes effects: the mount functions *append*, so
    // without cleanup the page would carry two of each. That is the failure T5.3 hit, and the
    // one a demo must not hide — so the assertion is `1`, not `>= 1`.
    const app = await render(url(), storage());

    expect(app.querySelectorAll("#persistence")).toHaveLength(1);
    expect(app.querySelectorAll("#install-guidance")).toHaveLength(1);
  });

  it("takes them away when the app unmounts", async () => {
    const app = await render(url(), storage());
    expect(app.querySelectorAll("#persistence")).toHaveLength(1);

    act(() => {
      root?.unmount();
    });
    root = undefined;

    expect(app.querySelectorAll("#persistence"), "the control outlived the app").toHaveLength(0);
    expect(app.querySelectorAll("#install-guidance")).toHaveLength(0);
  });
});

describe("archives are installed before the map exists", () => {
  it("does not mount the map while the store is still being read", async () => {
    // **The ordering ADR-0036 requires, observed rather than assumed.** The renderer registers
    // its PMTiles protocol lazily and does not retroactively serve an archive installed after
    // MapLibre has already asked for a tile — so a map mounted first goes to the network for
    // bytes that were already on disk, and offline fails for a reason nothing reports.
    let finishListing: () => void = () => undefined;
    const pending = new Promise<void>((settle) => {
      finishListing = settle;
    });
    const offline = (): DemoOffline =>
      ({
        store: {
          download: async () => {
            throw new Error("not used");
          },
          list: async () => {
            await pending;
            return [];
          },
          delete: async () => undefined,
          estimateSize: async () => 0,
        },
        assets: {},
      }) as unknown as DemoOffline;

    const app = await render(url(), storage(), offline);

    expect(
      app.querySelector('[data-testid="map"]'),
      "the map mounted before the store was read",
    ).toBeNull();
    expect(statusOf(app).dataset["status"]).toBe("starting");

    await act(async () => {
      finishListing();
      await Promise.resolve();
    });

    expect(app.querySelector('[data-testid="map"]')).not.toBeNull();
    expect(statusOf(app).dataset["status"]).toBe("ready");
  });

  it("publishes no stored-state reading until the region store has actually been read", async () => {
    /**
     * **The placeholder must not be published as a measurement.** `offlineStatus` starts as
     * `NOTHING_STORED` — zero regions, no sources — because nothing has looked in the store yet.
     * The panel treats what it is handed as a reading and marks it confirmed, so rendering it
     * during startup told a returning user "No region downloaded" with `data-regions="0"`, about
     * a store that turned out to hold a region.
     *
     * The read below therefore **resolves to a region**: a deferred read that ended up empty
     * would make the eager zero accidentally correct, and this would pass with the gate removed.
     */
    let finishListing: (() => void) | undefined;
    const offline = (): DemoOffline =>
      ({
        store: {
          download: async () => {
            throw new Error("this test does not download");
          },
          list: () =>
            new Promise((settle) => {
              finishListing = () => {
                settle([{ id: "r1", sizeBytes: 4096, sourceIds: ["demo-terrain"] }]);
              };
            }),
          delete: async () => undefined,
          estimateSize: async () => 4096,
        },
        assets: {},
      }) as unknown as DemoOffline;

    const app = await render(
      url("?terrain=http://archives.invalid/terrain.pmtiles"),
      storage(),
      offline,
    );

    expect(finishListing, "the region store was never read").toBeDefined();
    expect(statusOf(app).dataset["status"]).toBe("starting");
    expect(
      app.querySelector("#offline-status"),
      "an unread placeholder was published as a stored-state reading",
    ).toBeNull();

    await act(async () => {
      finishListing?.();
      await Promise.resolve();
    });

    // And once the read has landed, the panel reports what it found — confirmed, because now
    // there is something behind the number.
    const line = app.querySelector("#offline-status");
    expect(line?.getAttribute("data-confirmed")).toBe("true");
    expect(line?.getAttribute("data-regions")).toBe("1");
    expect(line?.getAttribute("data-stored")).toBe("demo-terrain");
  });

  it("reports nothing served on a first visit, which is not a failure", async () => {
    const app = await render(url(), storage());

    expect(app.querySelector("#offline-status")?.getAttribute("data-regions")).toBe("0");
    expect(app.querySelector("#offline-status")?.getAttribute("data-stored")).toBe("");
    expect(statusOf(app).dataset["status"], "an empty store was treated as a failure").toBe(
      "ready",
    );
  });
});

describe("a failed installation is reported, not sat in", () => {
  it("shows a failure and mounts no map when reading the region store rejects", async () => {
    // **The gate's own failure mode.** Installation now blocks the map, so an install that
    // rejects and is swallowed turns a storage or protocol error into a permanently blank page
    // stuck at "starting" — worse than the network trip the gate exists to prevent, because
    // nothing reports it.
    const offline = (): DemoOffline =>
      ({
        store: {
          download: async () => {
            throw new Error("not used");
          },
          list: async () => {
            throw new Error("the region store would not open");
          },
          delete: async () => undefined,
          estimateSize: async () => 0,
        },
        assets: {},
      }) as unknown as DemoOffline;

    const app = await render(url(), storage(), offline);

    expect(statusOf(app).dataset["status"], "the app sat in starting forever").toBe("failed");
    expect(app.textContent ?? "").toContain("the region store would not open");
    expect(
      app.querySelector('[data-testid="map"]'),
      "a map mounted over a failed install",
    ).toBeNull();

    // **And no stored-state reading either.** This path produced one no more than `starting` did:
    // the read is what rejected. Publishing the placeholder here would tell someone whose region
    // store would not open that they have no region, which is a different and unfounded claim
    // from the one the shell's own status line is making.
    expect(
      app.querySelector("#offline-status"),
      "a failed read published a stored-state reading anyway",
    ).toBeNull();
  });
});
