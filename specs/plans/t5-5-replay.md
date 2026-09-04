# T5.5 — Replay

> Bars set 2026-09-04, **before implementation**, against `main` at `1de7e64`. The survey found
> the marker's route already built — `showLivePosition` on the controller, surfaced by
> `MapCanvas` as `livePoint` — and the chart's segment boundaries already exposed by T5.4. One
> thing was genuinely missing: nothing in core answers *where was the track at time t*.

## The one architectural decision, settled first

**Core owns position-at-time; React owns playback.** `positionAt` is published from
`@mapatlas/core` (ADR-0032) as a pure projection with no renderer, clock or playback state.

The rule it encodes is not replay's. "Do not invent travel through a pause" is already stated by
the rendered line and by the channel charts, and a third implementation inside React is the
drift `computeStats` exists to prevent — plus a consumer writing their own replay would have no
way to match `TripReview`. ADR-0030 makes *playback state* internal; it never said the geometry
had to be.

## Settled calls

1. **Mounts paused at `first.t`.** The cursor starts at the first point's timestamp with the
   marker on the first point, and nothing advances until an explicit Play. Opening a review
   should not start a time-dependent action on its own, and inventing autoplay is choosing a
   policy the contract did not.
2. **A pause holds at the last point before it.** `A` ends at 100, `B` begins at 200: 150 and
   199 both return `A`'s last point; 200 returns `B`'s first. The alternative leaks a future
   observation backwards in time.
3. **Linear in lat/lng**, between the two bracketing samples of one segment — the geometry the
   track itself supplies. No geodesic path for animation's sake.
4. **Out of range is `undefined`, not clamped.** The cursor constrains itself to
   `[first.t, last.t]`, so that arm is reachable only through direct use of the projection —
   exactly the caller who should not get a fabricated answer.

## Field bars

- The chart cursor and the map marker read the **same** cursor value; they cannot disagree.
- Scrubbing moves both. Play advances the cursor; Pause stops it where it stands.
- The marker's position always comes from `positionAt`, never from a second computation.
- A track with one point, or with a single instantaneous segment, plays without dividing by
  zero and without an infinite duration.

## Testing lanes

- **Vitest** — `positionAt` in core, every semantic in ADR-0032 pinned separately; then the
  React state machine over a controlled clock, since a real one makes "advanced by 1s" a race.
- **Playwright** — that the marker actually moves on the map, which the unit lane cannot
  establish: it asserts what was handed to the controller, not what MapLibre drew.

## Increments

1. **`positionAt` in core.** The projection and its seven semantics, published and conformance-
   checked. No React.
2. **The cursor and its controls.** Play/pause/scrub in `TripReview`, paused at `first.t`, the
   marker driven through `livePoint`.
3. **The chart cursor**, reading the same value, and the browser scenario.

## Required mutations

- move a pause timestamp to the next segment's first point → the hold bar fails;
- interpolate across a segment boundary → the never-between-segments bar fails;
- clamp an out-of-range `t` to an endpoint instead of returning `undefined` → fails;
- ordinary division on adjacent samples sharing a timestamp → fails (and would be `NaN`, not a
  wrong answer, which is worse for a caller);
- accept a non-finite `t` instead of throwing → fails;
- autoplay on mount → the paused-at-start bar fails;
- initialise the cursor anywhere but `first.t` → fails;
- omit `positionAt` from the core barrel or its §1 conformance → fails;
- let the chart cursor and the map marker read different values → fails.
