// SPDX-License-Identifier: Apache-2.0

/**
 * The page the T5.3 browser scenarios drive: the real `<EventComposer>` mounted through real
 * React, against Chromium's native form machinery.
 *
 * The numeric legs live here because this is the boundary happy-dom mis-implements: its
 * number-input validity is a regex, not the finite-double parse the HTML number state
 * requires — it rejects finite `"1e2"` and admits spellings whose parse is non-finite. Only a
 * real browser can establish the `badInput` gate the composer's number handling relies on.
 *
 * **`setup` remounts by key.** Handoff and cancellation are terminal per instance (ADR-0027),
 * so a second scenario needs a new composition — exactly as a consumer would mount one.
 */
import { StrictMode, createElement } from "react";
import { createRoot } from "react-dom/client";

import type { MapEvent, StorageAdapter } from "@mapatlas/core";
import type { FieldSpec } from "@mapatlas/react";
import { EventComposer } from "@mapatlas/react";
import { TripReview } from "@mapatlas/react";
import { createIdbStorageAdapter } from "@mapatlas/storage-idb";

type SaveInput = Parameters<Parameters<typeof EventComposer>[0]["onSave"]>[0];

interface ComposerSetup {
  fields?: FieldSpec[];
  categories?: { value: string; label: string }[];
  occurredAt?: number;
  mode?: "comment" | "photo";
  /** Attach an analyzer that reports egress by actually attempting a network request. */
  analyzer?: { id: string; runsRemotely: boolean };
  /** Persist through a real IndexedDB adapter, as a consumer would, instead of recording. */
  persist?: boolean;
}

declare global {
  interface Window {
    composer: {
      /** Mount a fresh composer instance and reset the records below. */
      setup(config: ComposerSetup): void;
      saves: SaveInput[];
      cancels: number;
      /** Every store method the composer invoked; the numeric scenarios expect none. */
      storeCalls: string[];
      /** Id of the event the consumer persisted, when `persist` was asked for. */
      persistedId?: string | undefined;
      /** The persisted event as it was read back out of IndexedDB. */
      readEvent(id: string): Promise<MapEvent | undefined>;
      /** The bytes behind a blob key, as a plain array so it crosses the bridge. */
      readBlob(key: string): Promise<number[] | undefined>;
      /** Which element currently has focus, by class — the mode scenarios read this. */
      activeClass(): string;
      /**
       * Close the loop: mount `TripReview` over the *same* adapter the composer wrote to, with
       * the event the consumer just persisted. A separate adapter would prove only that two
       * stores can hold bytes; the claim is that what the composer wrote, the review can show.
       */
      review(eventId: string): Promise<void>;
      /** URLs the analyzer actually requested. The disclosure scenario expects none. */
      egress: string[];
    };
  }
}

const container = document.querySelector("#root");
if (container === null) throw new Error("composer harness page has no #root");
const root = createRoot(container);

/** Records every method it is asked for and answers vacuously, like the unit lane's fake. */
function recordingStore(): StorageAdapter {
  const answer = <T>(name: string, result: T): (() => Promise<T>) => {
    return () => {
      window.composer.storeCalls.push(name);
      return Promise.resolve(result);
    };
  };
  return {
    saveTrack: answer("saveTrack", undefined),
    getTrack: answer("getTrack", undefined),
    listTrackSummaries: answer("listTrackSummaries", []),
    deleteTrack: answer("deleteTrack", undefined),
    saveEvent: answer("saveEvent", undefined),
    getEvent: answer("getEvent", undefined),
    listEvents: answer("listEvents", []),
    deleteEvent: answer("deleteEvent", undefined),
    putBlob: answer("putBlob", "harness-key"),
    getBlob: answer("getBlob", undefined),
    deleteBlob: answer("deleteBlob", undefined),
    clearAll: answer("clearAll", undefined),
  };
}

let instance = 0;

/** One real adapter for the whole page, on a database name the scenarios can reason about. */
const persistent = createIdbStorageAdapter({ databaseName: "mapatlas-composer-e2e" });

window.composer = {
  saves: [],
  cancels: 0,
  storeCalls: [],
  readEvent: (id) => persistent.getEvent(id),
  readBlob: async (key) => {
    const blob = await persistent.getBlob(key);
    if (blob === undefined) return undefined;
    return [...new Uint8Array(await blob.arrayBuffer())];
  },
  activeClass: () => document.activeElement?.className ?? "",
  review: async (eventId) => {
    const event = await persistent.getEvent(eventId);
    if (event === undefined) throw new Error(`no persisted event ${eventId}`);
    root.render(
      createElement(
        StrictMode,
        null,
        createElement(TripReview, {
          track: {
            id: "reviewed",
            startedAt: event.occurredAt - 1_000,
            endedAt: event.occurredAt + 1_000,
            status: "finalized",
            origin: "recorded",
            points: [
              { lat: 59.32, lng: 18.05, t: event.occurredAt - 1_000 },
              { lat: 59.34, lng: 18.07, t: event.occurredAt + 1_000 },
            ],
            segments: [
              {
                id: "s1",
                startIndex: 0,
                endIndex: 1,
                startedAt: event.occurredAt - 1_000,
                endedAt: event.occurredAt + 1_000,
              },
            ],
          },
          events: [event],
          store: persistent,
          sources: [
            {
              id: "base",
              kind: "raster",
              transport: "template",
              // `tiles.invalid` is the host the browser fixtures actually serve. Pointing at
              // an unserved host would make the map log an AJAXError per tile, and the console
              // guard would fail this scenario for the map's noise rather than for the photo it
              // is about — the fixtures are served rather than the errors ignored.
              url: "https://tiles.invalid/{z}/{x}/{y}.png",
              attribution: "harness",
            },
          ],
        }),
      ),
    );
  },
  egress: [],
  setup: (config) => {
    window.composer.saves = [];
    window.composer.cancels = 0;
    window.composer.storeCalls = [];
    window.composer.persistedId = undefined;
    window.composer.egress = [];
    const { persist = false, analyzer: spec, ...composerProps } = config;
    // A real egress boundary: this analyzer does not pretend to send, it sends. The scenario
    // asserts on requests the page actually made, so "nothing was sent" is a fact about the
    // network rather than about a fake's bookkeeping.
    const analyzer =
      spec === undefined
        ? undefined
        : {
            id: spec.id,
            runsRemotely: spec.runsRemotely,
            analyze: async () => {
              const url = `/__analyzer__/${spec.id}`;
              window.composer.egress.push(url);
              await fetch(url).catch(() => undefined);
              return { labels: [{ label: "sent", confidence: 1 }], model: spec.id };
            },
          };
    instance += 1;
    root.render(
      createElement(
        StrictMode,
        null,
        createElement(EventComposer, {
          key: instance,
          at: { lat: 59.33, lng: 18.06 },
          store: persist ? persistent : recordingStore(),
          ...(analyzer === undefined ? {} : { analyzer }),
          onSave: (input) => {
            window.composer.saves.push(input);
            if (!persist) return;
            // What a consumer actually does with the handoff: reattach the position the
            // composer was opened at, mint an id, and persist. From here the blob is the
            // consumer's — the round-trip scenario reads it back through the same adapter.
            const id = `evt-${String(instance)}`;
            const event: MapEvent = { ...input, id, position: { lat: 59.33, lng: 18.06 } };
            void persistent.saveEvent(event).then(() => {
              window.composer.persistedId = id;
            });
          },
          onCancel: () => {
            window.composer.cancels += 1;
          },
          ...composerProps,
        }),
      ),
    );
  },
};
