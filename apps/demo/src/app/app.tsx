// SPDX-License-Identifier: Apache-2.0

/**
 * The demo app — the shell.
 *
 * **Assembled only from package entry points.** The storage adapters come from
 * `@mapatlas/storage-idb` by bare name, the types from `@mapatlas/core`, and everything the loop
 * uses from `@mapatlas/react`. That restriction is the point rather than a convenience: this app
 * is the evidence that the seams compose for someone who ran `npm install`, and an app reaching
 * into `dist` paths or internals would demonstrate that the repo works, not that the packages do.
 *
 * **What this file owns.** Opening the two stores and reporting honestly whether they opened,
 * resolving the tile stack from the URL, and carrying T6.2's settings panels. The
 * record → pin → photo → review loop is `loop.tsx`'s (increment 2); export is not built yet
 * (increment 3). The status line below reports what *this* file can claim — that storage is open
 * and how many sources were declared — and deliberately says nothing about the loop, which has
 * its own status line and its own observables.
 */

import { useEffect, useMemo, useState } from "react";
import type { ReactElement } from "react";

import { Loop } from "./loop.js";
import { InstallPanel, PersistencePanel } from "./panels.js";
import {
  BLANK_STYLE,
  DEMO_CAMERA,
  demoTerrain,
  demoTileSources,
  readDemoSources,
} from "./sources.js";
import { createDemoStorage } from "./storage.js";
import type { DemoStorage } from "./storage.js";

/** What the shell can honestly report about itself. */
export type ShellStatus = "starting" | "ready" | "failed";

export interface AppProps {
  /** Where the archives are. Absent renders the blank style, which is a valid state. */
  readonly here: URL;
  /**
   * The stores, injected so a test can supply doubles.
   *
   * Defaulted at the **call site**, never here: a default parameter is applied when a caller
   * passes `undefined` explicitly, so a test injecting `undefined` would silently get the real
   * IndexedDB-backed pair and pass or fail on whatever the environment happened to provide.
   * T6.2's `null`-sentinel lesson, applied before it can bite twice.
   */
  readonly storage: DemoStorage;
}

/**
 * Prove the stores are usable, rather than merely constructed.
 *
 * `createIdbStorageAdapter` and `createIdbMapAssetStore` open lazily, so holding them proves
 * nothing at all — a database that cannot be opened looks identical until something reads it.
 * One read of each is the smallest thing that distinguishes the two, and it is why this reports
 * `ready` from an effect rather than from render.
 */
async function openStores(storage: DemoStorage): Promise<void> {
  await storage.trips.listTrackSummaries();
  await storage.assets.list();
}

export function App({ here, storage }: AppProps): ReactElement {
  const [status, setStatus] = useState<ShellStatus>("starting");
  const [failure, setFailure] = useState<string | undefined>(undefined);

  // Stable across renders: `MapCanvas` treats a new `sources` array as a new stack, and rebuilding
  // it every render would churn the source stack on every keystroke elsewhere in the app.
  const sources = useMemo(() => demoTileSources(readDemoSources(here)), [here]);
  const terrain = useMemo(() => demoTerrain(readDemoSources(here)), [here]);

  useEffect(() => {
    let live = true;
    openStores(storage).then(
      () => {
        if (live) setStatus("ready");
      },
      (error: unknown) => {
        if (!live) return;
        setFailure(error instanceof Error ? error.message : String(error));
        setStatus("failed");
      },
    );
    return () => {
      // React 19 StrictMode mounts, unmounts and remounts effects in development, and a resolved
      // promise from the first pass must not report into the second.
      live = false;
    };
  }, [storage]);

  return (
    <main className="app">
      <h1 className="app-title">MAP-ATLAS field logger</h1>
      <p
        id="shell-status"
        className="app-status"
        data-status={status}
        data-sources={String(sources.length)}
      >
        {status === "ready"
          ? `Storage open. ${String(sources.length)} tile source${sources.length === 1 ? "" : "s"}.`
          : status === "failed"
            ? `Storage failed: ${failure ?? "unknown"}`
            : "Opening storage…"}
      </p>

      <Loop
        storage={storage}
        sources={sources}
        style={BLANK_STYLE}
        terrain={terrain}
        initialCamera={DEMO_CAMERA}
      />

      <PersistencePanel />
      <InstallPanel />

      <p className="app-lab">
        The fixture harness is at <a href="/lab">/lab</a>.
      </p>
    </main>
  );
}

/** What `main.ts` mounts. Storage is constructed here, once, outside React's lifecycle. */
export function createApp(here: URL): ReactElement {
  return <App here={here} storage={createDemoStorage()} />;
}
