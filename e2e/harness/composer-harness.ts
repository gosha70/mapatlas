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

import type { StorageAdapter } from "@mapatlas/core";
import type { FieldSpec } from "@mapatlas/react/event-composer";
import { EventComposer } from "@mapatlas/react/event-composer";

type SaveInput = Parameters<Parameters<typeof EventComposer>[0]["onSave"]>[0];

interface ComposerSetup {
  fields?: FieldSpec[];
  categories?: { value: string; label: string }[];
  occurredAt?: number;
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

window.composer = {
  saves: [],
  cancels: 0,
  storeCalls: [],
  setup: (config) => {
    window.composer.saves = [];
    window.composer.cancels = 0;
    window.composer.storeCalls = [];
    instance += 1;
    root.render(
      createElement(
        StrictMode,
        null,
        createElement(EventComposer, {
          key: instance,
          at: { lat: 59.33, lng: 18.06 },
          store: recordingStore(),
          onSave: (input) => {
            window.composer.saves.push(input);
          },
          onCancel: () => {
            window.composer.cancels += 1;
          },
          ...config,
        }),
      ),
    );
  },
};
