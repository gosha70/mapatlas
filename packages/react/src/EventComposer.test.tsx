// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

/**
 * T5.3 acceptance: comment + in-place photo capture saves a MapEvent with
 * media; the analyze path works with `noopAnalyzer`; a remote analyzer's
 * disclosure is shown and user-confirmed labels become tags.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { MapEvent, MediaAnalyzer } from "@mapatlas/core";
import { InMemoryStorageAdapter, noopAnalyzer } from "@mapatlas/core";
import { EventComposer } from "./EventComposer.js";

beforeEach(() => {
  // jsdom lacks object URLs; stub for previews.
  globalThis.URL.createObjectURL = vi.fn(() => "blob:mock");
  globalThis.URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const photo = () =>
  new File([new Uint8Array([1, 2, 3])], "shot.jpg", { type: "image/jpeg" });

function uploadPhoto(): void {
  const input = screen.getByTestId("photo-input") as HTMLInputElement;
  fireEvent.change(input, { target: { files: [photo()] } });
}

describe("EventComposer", () => {
  it("saves a MapEvent with a comment and persisted media (blobKey)", async () => {
    const store = new InMemoryStorageAdapter();
    const onSave = vi.fn<(i: Omit<MapEvent, "id" | "position">) => void>();

    render(
      <EventComposer
        at={{ lat: 1, lng: 2 }}
        store={store}
        onSave={onSave}
        onCancel={() => {}}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText(/what did you see/i), {
      target: { value: "a heron" },
    });
    uploadPhoto();
    await waitFor(() => expect(screen.getByAltText("Captured")).toBeTruthy());

    fireEvent.click(screen.getByText("Save event"));

    expect(onSave).toHaveBeenCalledTimes(1);
    const input = onSave.mock.calls[0]![0];
    expect(input.comment).toBe("a heron");
    expect(input.media).toHaveLength(1);
    expect(input.media[0]!.blobKey).toBeTruthy();
    // The blob really landed in the store.
    expect(await store.getBlob(input.media[0]!.blobKey!)).toBeDefined();
  });

  it("runs the analyze path with noopAnalyzer (no labels, still saveable)", async () => {
    const onSave = vi.fn();
    render(
      <EventComposer
        at={{ lat: 0, lng: 0 }}
        analyzer={noopAnalyzer}
        onSave={onSave}
        onCancel={() => {}}
      />,
    );
    uploadPhoto();
    await waitFor(() => screen.getByText("Analyze photo"));
    fireEvent.click(screen.getByText("Analyze photo"));
    await waitFor(() => screen.getByText("No labels suggested."));
    fireEvent.click(screen.getByText("Save event"));
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("shows a remote-analyzer disclosure and turns confirmed labels into tags", async () => {
    const analyzer: MediaAnalyzer = {
      id: "remote-vision-llm",
      runsRemotely: true,
      analyze: async () => ({
        labels: [{ label: "gull", confidence: 0.9 }],
        model: "remote-vision-llm",
      }),
    };
    const onSave = vi.fn<(i: Omit<MapEvent, "id" | "position">) => void>();

    render(
      <EventComposer
        at={{ lat: 0, lng: 0 }}
        analyzer={analyzer}
        onSave={onSave}
        onCancel={() => {}}
      />,
    );

    // Disclosure visible before any analysis.
    expect(screen.getByRole("note").textContent).toMatch(/runs remotely/i);

    uploadPhoto();
    await waitFor(() => screen.getByText("Analyze photo"));
    fireEvent.click(screen.getByText("Analyze photo"));

    const checkbox = await screen.findByRole("checkbox");
    fireEvent.click(checkbox); // confirm the "gull" label
    fireEvent.click(screen.getByText("Save event"));

    expect(onSave).toHaveBeenCalledTimes(1);
    const input = onSave.mock.calls[0]![0];
    expect(input.tags).toContain("gull");
    expect(input.media[0]!.analysis?.labels[0]!.label).toBe("gull");
  });
});
