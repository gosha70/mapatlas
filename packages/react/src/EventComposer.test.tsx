// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createMemoryStorageAdapter, noopAnalyzer } from "@mapatlas/core";
import type { MapEvent, MediaAnalyzer } from "@mapatlas/core";
import { EventComposer } from "./EventComposer";

beforeAll(() => {
  // jsdom does not implement object URLs.
  URL.createObjectURL = vi.fn(() => "blob:mock");
  URL.revokeObjectURL = vi.fn();
});
afterEach(cleanup);

const AT = { lat: 47.6, lng: -122.33 };

function addPhoto(): void {
  const input = document.querySelector(
    'input[type="file"]',
  ) as HTMLInputElement;
  const file = new File([new Uint8Array([1, 2, 3])], "p.jpg", {
    type: "image/jpeg",
  });
  fireEvent.change(input, { target: { files: [file] } });
}

describe("EventComposer", () => {
  it("captures a comment + photo and saves a MapEvent input with media", async () => {
    const onSave = vi.fn<(i: Omit<MapEvent, "id" | "position">) => void>();
    render(<EventComposer at={AT} onSave={onSave} onCancel={() => {}} />);

    fireEvent.change(screen.getByPlaceholderText("What happened here?"), {
      target: { value: "a heron" },
    });
    addPhoto();
    await waitFor(() => expect(screen.getByAltText("Captured")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledTimes(1);
    const input = onSave.mock.calls[0]![0];
    expect(input.comment).toBe("a heron");
    expect(input.media).toHaveLength(1);
    expect(input.media[0]!.url).toBe("blob:mock");
    expect(typeof input.occurredAt).toBe("number");
  });

  it("uses the file-capture attributes for in-place photo capture", () => {
    render(<EventComposer at={AT} onSave={() => {}} onCancel={() => {}} />);
    const input = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    expect(input.getAttribute("accept")).toBe("image/*");
    expect(input.getAttribute("capture")).toBe("environment");
  });

  it("persists photos via a store as blobKeys when one is provided", async () => {
    const store = createMemoryStorageAdapter();
    const onSave = vi.fn<(i: Omit<MapEvent, "id" | "position">) => void>();
    render(
      <EventComposer
        at={AT}
        store={store}
        onSave={onSave}
        onCancel={() => {}}
      />,
    );
    addPhoto();
    await waitFor(() => expect(screen.getByAltText("Captured")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    const ref = onSave.mock.calls[0]![0].media[0]!;
    expect(ref.blobKey).toBeDefined();
    expect(ref.url).toBeUndefined();
    expect(await store.getBlob(ref.blobKey!)).toBeDefined();
  });

  it("runs the analyze path with noopAnalyzer (no labels suggested)", async () => {
    render(
      <EventComposer
        at={AT}
        analyzer={noopAnalyzer}
        onSave={() => {}}
        onCancel={() => {}}
      />,
    );
    addPhoto();
    await waitFor(() => expect(screen.getByAltText("Captured")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Analyze photo" }));
    await waitFor(() =>
      expect(screen.getByText("No labels suggested.")).toBeTruthy(),
    );
  });

  it("shows a remote-analyzer disclosure and lets the user confirm labels", async () => {
    const remote: MediaAnalyzer = {
      id: "remote-vision",
      runsRemotely: true,
      analyze: () =>
        Promise.resolve({
          labels: [
            { label: "bird", confidence: 0.9 },
            { label: "water", confidence: 0.5 },
          ],
        }),
    };
    const onSave = vi.fn<(i: Omit<MapEvent, "id" | "position">) => void>();
    render(
      <EventComposer
        at={AT}
        analyzer={remote}
        onSave={onSave}
        onCancel={() => {}}
      />,
    );
    // Disclosure is visible before any analysis.
    expect(screen.getByRole("note").textContent).toContain("remote service");

    addPhoto();
    await waitFor(() => expect(screen.getByAltText("Captured")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Analyze photo" }));
    await waitFor(() => expect(screen.getByText(/bird/)).toBeTruthy());

    // Deselect "water"; keep "bird".
    fireEvent.click(screen.getByRole("checkbox", { name: /water/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    const input = onSave.mock.calls[0]![0];
    expect(input.tags).toEqual(["bird"]);
    expect(input.media[0]!.analysis?.labels.map((l) => l.label)).toEqual([
      "bird",
    ]);
    expect(input.media[0]!.analysis?.model).toBe("remote-vision");
  });
});
