// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

/**
 * T5.4 acceptance: renders a finalized trip — stats, a scrubbable/playable
 * replay, and browsable events with photos.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { MapEvent, Track } from "@mapatlas/core";
import { TripReview } from "./TripReview.js";

const TRACK: Track = {
  id: "t1",
  startedAt: 0,
  endedAt: 125_000,
  status: "finalized",
  points: [
    { lat: 51.5, lng: -0.1, t: 0 },
    { lat: 51.51, lng: -0.09, t: 60_000 },
    { lat: 51.52, lng: -0.08, t: 120_000 },
  ],
  simplified: [
    { lat: 51.5, lng: -0.1, t: 0 },
    { lat: 51.52, lng: -0.08, t: 120_000 },
  ],
  distanceM: 2400,
};

const EVENTS: MapEvent[] = [
  {
    id: "e1",
    position: { lat: 51.5, lng: -0.1 },
    occurredAt: 1,
    comment: "a heron",
    media: [{ id: "m1", mime: "image/jpeg", url: "blob:mock" }],
    tags: ["heron"],
  },
];

afterEach(cleanup);

describe("TripReview", () => {
  it("renders trip stats", () => {
    render(<TripReview track={TRACK} events={EVENTS} />);
    expect(screen.getByTestId("stat-distance").textContent).toBe("2.40 km");
    expect(screen.getByTestId("stat-points").textContent).toBe("2");
    expect(screen.getByTestId("stat-events").textContent).toBe("1");
    expect(screen.getByTestId("stat-duration").textContent).toBe("2m 05s");
  });

  it("scrubs the replay position along the track", () => {
    render(<TripReview track={TRACK} events={EVENTS} />);
    const slider = screen.getByLabelText("Replay position") as HTMLInputElement;
    expect(screen.getByTestId("replay-position").textContent).toContain(
      "51.50000",
    );
    fireEvent.change(slider, { target: { value: "1" } });
    expect(screen.getByTestId("replay-position").textContent).toContain(
      "51.52000",
    );
  });

  it("toggles play/pause", () => {
    render(<TripReview track={TRACK} events={EVENTS} />);
    const button = screen.getByRole("button", { name: "Play" });
    fireEvent.click(button);
    expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();
  });

  it("browses events with comments, tags and photos", () => {
    render(<TripReview track={TRACK} events={EVENTS} />);
    expect(screen.getByText("a heron")).toBeTruthy();
    expect(screen.getByText("heron")).toBeTruthy();
    expect(screen.getByAltText("Event")).toBeTruthy();
  });
});
