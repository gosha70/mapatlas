# T5.4 — `<TripReview>`

> Bars set 2026-09-04, **before implementation**, against `main` at `5c9516e`. The survey found
> the map, stats and chart halves fully served by existing core seams (`computeStats`,
> `computeLapStats`, `ChannelDescriptor` carrying `label`/`unit`/`precision`), and two things
> the §9 signature could not do at all.

## What the survey found, and what it changed

Two gaps were contract-level, not implementation-level, and are settled before any code:

1. **Photos had no route.** Scope said "events/photos"; §9 had no `StorageAdapter`, so a
   `blobKey` could not be resolved. `store` is now a required prop (ADR-0028).
2. **Replay had no criterion.** The word appeared once in the whole spec tree, in the scope
   line itself. It is now **T5.5**, with semantics recorded in ADR-0030.

A third was a hidden ambiguity: "no channels" has five readings, and `channels?` "defaults to
all" did not say all of what. Settled in ADR-0029 — the default is the *descriptors*.

A fourth looked like the same class and was not. Start/finish marks appear in no `MapCanvas`
prop, which reads like scope naming something the signature cannot do — the shape of the `store`
gap exactly. It is not: `EventPresentation` already owns their styling and the controller
already renders them from the track, on a channel distinct from event marks. Nothing is needed.
Recorded because the wrong conclusion here costs an additive API change and a re-solve of SSR
and mount handling that `MapCanvas` already did.

## Settled calls

1. **Charting is hand-rolled SVG, not a library — ADR-0031.** Recorded there rather than here:
   a dependency decision on a published package is asked again by whoever later wants to add a
   chart library, and they will not be reading this plan.
2. **The chart region is absent, not empty, when nothing is chartable** (ADR-0029). Absence is
   the AC's word and the two are visually different.
3. **Photos render from `url` directly and from `blobKey` through the store**, with object URLs
   revoked on unmount, as in the composer.
4. **`TripReview` renders a finalized track.** It takes `Track`, not a draft or a live
   recording; `livePoint` belongs to `MapCanvas`.

## Field bars

- Start and finish marks are placed from the track's first and last points, and are
  distinguishable from each other and from event marks.
- A channel charts against **time**, not sample index — an evenly-spaced plot of unevenly-timed
  samples misstates the trip, and pause segments make the spacing uneven by construction.
- The descriptor's `label` and `unit` are rendered verbatim; `precision` governs displayed
  decimals. The engine never derives any of the three.
- Stats come from `computeStats`, not recomputed here — a second implementation would drift.

## Testing lanes

- **Vitest / happy-dom** — the five channel readings, stats rendering, photo resolution through
  a fake store, mark placement, absent-vs-empty chart region.
- **Playwright** — the map half, as `MapCanvas` is already exercised: a finalized trip renders
  with its line and both marks, and a photo written by the composer's own path is read back and
  displayed. The unit lane cannot establish either.

## Increments

1. **Map + events + marks.** `TripReview` composes `MapCanvas` — it does not drive the
   controller itself, and it adds no marks route, because neither is needed. §9's
   `EventPresentation` already declares `startMarker?(t)` and `finishMarker?(t)` with neutral
   built-in defaults, and the controller already builds them from the track through
   `buildTrackEndpointFeatures`, rendering them as `trackMarks` — **a separate channel from
   `eventMarks`, so they are not clickable events and `onEventClick` is unaffected**. Passing
   `track` is the whole of it. What this increment owns is composition and `onEventClick`
   pass-through, not mark rendering. No stats, no charts, no photos.
2. **Stats panel + channel charts.** `computeStats` output rendered; charts from descriptors,
   with all five "no channels" readings falsified.
3. **Photos.** `blobKey` resolved through `store`, `url` rendered directly, object URLs
   revoked; the browser round-trip against a real adapter.
4. **Surface + closure.** Exported, §9 conformance including the new `store` prop, out of
   `NOT_YET_BUILT`, `tasks.md`. **`TripReviewInternal` goes into `MUST_NOT_ESCAPE`** alongside
   `MapCanvasInternal` — it exists only so tests can inject the controller seam, and the barrel
   test will otherwise let it out without anyone noticing. Noted here rather than left for the
   closure increment to remember, because that increment is about exports and is exactly where
   an extra one hides.

## Required mutations

- chart a channel against sample index rather than time → the uneven-spacing bar fails;
- default `channels` to the keys found in data rather than the descriptors → ADR-0029 fails;
- render an empty chart frame when nothing is chartable → the absent-not-empty bar fails;
- derive a label or unit for a key with no descriptor → the ADR-0009 neutrality bar fails;
- recompute stats locally instead of calling `computeStats` → the single-implementation bar
  fails;
- resolve a `MediaRef` with `url` through the store → the no-lookup bar fails;
- skip `URL.revokeObjectURL` on unmount → the leak bar fails;
- place the finish mark from the last *event* rather than the last point → the mark bar fails.
