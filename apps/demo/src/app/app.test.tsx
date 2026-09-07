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
import type { DemoStorage } from "./storage.js";

/**
 * The shell, rendered.
 *
 * **`MapCanvas` is mocked here, and that is not a shortcut.** It constructs a real MapLibre map,
 * which needs a WebGL context this lane does not have; whether it draws is the browser lane's
 * question and is asserted there. What this lane can see is what the shell *hands* it — the
 * source stack, the terrain option — and that the shell reports its own state honestly.
 */
vi.mock("@mapatlas/react", () => ({
  MapCanvas: (props: Record<string, unknown>) =>
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

let root: Root | undefined;
let host: HTMLElement | undefined;

const render = async (here: URL, stores: DemoStorage): Promise<HTMLElement> => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(createElement(StrictMode, null, createElement(App, { here, storage: stores })));
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

  it("hands MapCanvas the stack the URL asked for", async () => {
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
