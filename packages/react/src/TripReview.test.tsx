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
import type { MapEvent, Track } from "@mapatlas/core";
import { TripReview } from "./TripReview";

beforeAll(() => {
  URL.createObjectURL = vi.fn(() => "blob:mock");
  URL.revokeObjectURL = vi.fn();
});
afterEach(cleanup);

const TRACK: Track = {
  id: "t1",
  startedAt: 1_000_000,
  endedAt: 1_000_000 + 3_600_000, // 1h
  status: "finalized",
  points: [
    { lat: 47.6, lng: -122.33, t: 0 },
    { lat: 47.61, lng: -122.34, t: 1 },
    { lat: 47.62, lng: -122.35, t: 2 },
  ],
  simplified: [
    { lat: 47.6, lng: -122.33, t: 0 },
    { lat: 47.62, lng: -122.35, t: 2 },
  ],
  distanceM: 2500,
};

const EVENTS: MapEvent[] = [
  {
    id: "e1",
    position: { lat: 47.605, lng: -122.335 },
    occurredAt: 1,
    comment: "a pin",
    media: [{ id: "m1", mime: "image/jpeg", url: "blob:mock" }],
    tags: ["bird"],
  },
];

describe("TripReview", () => {
  it("shows trip stats", () => {
    render(<TripReview track={TRACK} events={EVENTS} />);
    expect(screen.getByText("2.50 km")).toBeTruthy();
    expect(screen.getByText("01:00:00")).toBeTruthy(); // 1h duration
    expect(screen.getByText("2")).toBeTruthy(); // simplified point count
    expect(screen.getByText("1")).toBeTruthy(); // event count
  });

  it("scrubs the replay cursor", () => {
    render(<TripReview track={TRACK} events={EVENTS} />);
    const range = screen.getByLabelText("Replay position") as HTMLInputElement;
    expect(range.max).toBe("1"); // simplified has 2 points → indices 0..1
    fireEvent.change(range, { target: { value: "1" } });
    expect(screen.getByText("47.62000, -122.35000")).toBeTruthy();
  });

  it("toggles replay playback", () => {
    render(<TripReview track={TRACK} events={EVENTS} />);
    const play = screen.getByRole("button", { name: "Play" });
    fireEvent.click(play);
    expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();
  });

  it("browses an event's detail and photo", async () => {
    render(<TripReview track={TRACK} events={EVENTS} />);
    fireEvent.click(screen.getByRole("button", { name: /a pin/ }));
    expect(screen.getByLabelText("Event detail")).toBeTruthy();
    expect(screen.getByText("bird")).toBeTruthy();
    await waitFor(() => expect(screen.getByAltText("a pin")).toBeTruthy());
  });
});
