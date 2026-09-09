# T7.1c — the channel demo

> Bars set 2026-09-08, **before any candidate implementation**, against `main` at `abfd39f`
> (the merge of PR #36, which closed T7.1b). Every survey finding below was read out of the code
> at that commit and is cited by file; nothing here is inherited from a summary.

## What is settled — cite, do not re-open

1. **T7.1c discharges one criterion of `PRD.md` §6**, not Phase 7's exit: *"Adding a `SensorSource`
   (even the fake) attaches a telemetry channel to every track point, charts it in review, and
   exports it — with zero core changes."*

   > **Amended 2026-09-09, during increment 1.** The sentence quoted above was `PRD.md`'s at the
   > time this plan was written, and it is **stronger than the engine's contract** — quoting it
   > without checking it against ADR-0009 is the mistake, not the plan's use of it. A polling
   > source cannot attach a sample to the first kept fix (`start()` schedules an interval and does
   > not read at zero) and `mergeSensorSamples` excludes samples newer than a point; ADR-0009
   > already made `channels` optional, merged into **kept** points under a `maxAgeMs` policy, with
   > sensor failure non-fatal. `PRD.md` §6 now reads *"attaches available telemetry samples to the
   > kept track points"*, with its own dated note. **No bar in this plan changes**: `tasks.md`'s
   > T7.1c observable — channel arrays exported, re-import reproducing the chart — was always
   > compatible with sparse samples, and increment 1's evidence asserts what the fixture can
   > honestly claim rather than what the old sentence asked for. `tasks.md` states the acceptance criterion as *"the
   exported file contains the channel arrays and re-importing reproduces the chart"*. The
   getting-started documentation is **T7.2**'s and closes the phase.
2. **The channel was fenced here on 2026-09-06**, before T7.1's plan was written. T7.1's scope line
   still names "a fake polling sensor channel" and carries a note saying so; nothing in T7.1 or
   T7.1b wires a `SensorSource`.
3. **Persistence, the trip list and the authoring flow are settled dependencies.** T7.1 closed
   reload durability and T7.1b closed listing and authoring. A T7.1c test re-asserting any of them
   is spending a review round on a green claim.
4. **`/lab` retirement remains out of scope**, and remains nobody's task until the audit runs:
   `/lab` is an evidence fixture until each lab-owned browser assertion is mapped to an equivalent
   root-app oracle or deliberately retired.

## Survey — what the repo already has

- **The sensor seam is published and this is assembly.** `useTrackRecorder` takes
  `sensors?: SensorSource[]` (`packages/react/src/use-track-recorder.ts:39`) and hands them to the
  recorder; `createPollingSensorSource` is exported from `core`
  (`packages/core/src/index.ts:65`, implemented at `sensors-polling.ts:172`). A fake channel is a
  `read` function handed to that. **No package change is expected on this path.**
- **The export already carries channels, and `core` already tests it.**
  `packages/core/src/portability.ts:170` builds one parallel array per channel key, sorted so the
  document does not depend on insertion order, with `channelDescriptors` beside them;
  `portability.test.ts` covers the round trip. **Reuse it; do not re-prove it in the browser.**
- **The chart is renderable and, better, comparable.** `TripReview` renders
  `<figure class="mapatlas-trip-chart" data-channel="…">` containing one
  `<polyline class="mapatlas-trip-chart-line" points="…">` per segment
  (`packages/react/src/trip-review.ts:425`). The `points` attribute is an exact geometry string —
  which is what makes "reproduces the chart" assertable as an identity rather than as a
  resemblance.
- **ADR-0029's rule is already enforced by the component.** `chartable()`
  (`trip-review.ts:318`) starts from the **descriptors** and keeps only those some point actually
  sampled, and empty polylines are filtered out — so a declared-but-unsampled channel renders no
  figure at all. That is the accepted consequence the ADR records, and it is what a chart
  assertion must be written against.

### The finding that decides this plan

**A channel is structurally recorded-only, and the boundary is in the React binding rather than
in the model.** `core`'s `TrackDraft.append(p: DraftTrackPoint)` (`draft.ts:43`) accepts a point
carrying `channels`, and the draft holds them throughout — descriptors at `:117`, a deep copy per
point at `:136`, seeding `from` a track at `:227`, carried to the finalized track at `:432`. But
`@mapatlas/react`'s `useTrackDraft.append` takes a bare `LatLng` and **strips to `{lat, lng}`**
(`use-track-draft.ts:124`), for a different reason entirely: a vertex must arrive untimed so the
timing step cannot be skipped. There is no published mutator that attaches a channel value to an
authored point, and `use-track-draft.ts` mentions channels nowhere.

**This is correct rather than a gap. A hand-drawn trip has no sensor to sample.**

## The decision this plan takes, rather than discovering it in increment 3

**Authored trips carry no channels, recorded in an ADR, and `app-equivalence.e2e.ts` declares the
channel paths with that ADR as the stated reason.**

Increment 1 breaks the standing equivalence check the moment it lands: recorded trips gain
`points[].channels`, the track gains `channels` descriptors, and the export gains its channel
arrays, none of which an authored trip has. **That red is the check working**, and there are three
ways to answer it, two of which are wrong:

- *Weaken the oracle* — compare less, or stop comparing the export. This is the spot-check that
  `CONTINUE.md`'s mistake 7b exists to forbid.
- *Paint a fake channel onto drawn points* so the shapes match. This invents data to satisfy a
  test, and would make the demo teach that a hand-drawn trip carries sensor readings.
- *Declare it, with the reason recorded* — which is what 7b's own rule prescribes: a scoped
  statement made in advance, not a list grown from failures.

So the ADR is written **in increment 1, before the declaration**, and the declaration cites it.
Widening `useTrackDraft.append` to accept channels is a published API change and is **out of
scope**; if a later task wants authored channels, that is its own ADR and its own `api.md` change.

## Where the re-import happens, decided here rather than in increment 3

`tasks.md` asks that *"re-importing reproduces the chart"*, and **the demo has export and no
import**: T7.1's acceptance criterion named export only, and nothing since added a way back in.
So increment 3's observable has to say where the second track comes from, and there are two
readings.

**The decision: the scenario imports through the app's own storage seam.** The exported file is
parsed by `core`'s published importer and written through `createDemoStorage()` — the same probe
shape `app-equivalence.e2e.ts` already uses to read the app's stores — after which the app lists
and reviews it like any other stored trip. This discharges the criterion as `tasks.md` states it,
adds no surface, and keeps the *attributable to the imported document* bar meaningful: the
imported trip has an id of its own and appears as its own row, so a chart read from it cannot be
the original's chart by accident.

> **Amended 2026-09-09, on increment 3's own finding.** The last sentence is **disproved by the
> repository**. `geoJSONToTrack` carries `properties.id` through (`portability.ts:390`) and
> preserves the document's `origin` — core's round-trip test asserts that deliberately — so an
> imported track has neither a new identity nor an `"imported"` label, and saving it *overwrites*
> the trip it came from. Attribution therefore comes from **absence** rather than from a second
> row: the scenario deletes the original, **reloads**, proves through the storage seam that
> `getTrack(originalId)` is `undefined` and that no summary carries that id, imports into that
> fresh document, and **reloads again** so the app rebuilds its list from IndexedDB. The reappeared
> row is attributable to the imported document because no track with that id existed immediately
> before the import, and neither surviving document could have drawn the second chart. Nothing
> asserts `origin === "imported"`; the importer's contract is preservation.
>
> The recording is also kept **eventless**, which this plan did not say. `deleteTrack` removes the
> track's events and any blob only they referenced, and the export carries media *references*
> rather than bytes — so a trip with a photo would make this an accidental media-import test,
> passing or failing for reasons unrelated to channels.

**An import affordance in the demo is not built here, and is recorded as unowned.** It is a real
feature, `tasks.md`'s T7.1c line does not name it, and inventing it inside a channel task is the
kind of widening this repository's plans exist to prevent. But it should be visible rather than
discovered later: `PRD.md` lists import among the engine's features, and **a demo that can export
and cannot import is a limitation of the demo standing against Phase 7's exit** — *"`PRD.md` §6
met end-to-end"*. It belongs with eviction, quota and download resume on the unowned list, not in
a T7.2 survey's surprises.

## Scope fence

**In:** a fake polling `SensorSource` in the demo, wired at `useTrackRecorder`'s published seam; the
channel persisted on the recorded track's points; charted in review through `TripReview`'s
`channels` prop; carried through export and back through import; the ADR and the declaration that
keep the equivalence scenario honest.

**Out, on the record:** any real sensor or device API · a channel on authored trips, and any
widening of `useTrackDraft` to permit one · **an import affordance in the demo, which stays
unowned** (above) · charting in the live map · more than one channel unless an increment argues
that one cannot show what two would · getting-started documentation (**T7.2**) · `/lab` retirement
· eviction, quota and resume, still unbuilt and unowned.

## Increments, and the argument for this order

1. **Record and persist the channel**, plus the ADR and the declaration above. *Observable:* a
   recorded trip's stored points carry the declared key and the track carries a matching
   `ChannelDescriptor`; the equivalence scenario stays green **for a stated reason**. First
   because nothing downstream exists without samples, and because this is the increment that
   breaks the standing check — the answer belongs with the break, not two increments later.
2. **Chart it in review.** *Observable:* the review renders a figure for the declared key with a
   non-empty polyline, and a declared-but-unsampled channel renders none — reached as a
   **deliberate** state, a descriptor declared with the samples withheld, rather than as a side
   effect of the sensor failing to start. Otherwise that observable is the mutation rather than
   the thing the mutation is meant to break. Second because a chart needs samples.

   > **Amended 2026-09-09, on the increment's own finding.** The scope fence above says this is
   > charted *"through `TripReview`'s `channels` prop"*. **No prop wiring was required.** ADR-0029
   > makes an omitted `channels` mean the track's *declared descriptors*, and `chartable()` then
   > keeps only those some point actually sampled — so the component charts the demo's channel with
   > nothing passed at all, and the prop **narrows** that set rather than enabling it. Increment 2
   > therefore adds browser evidence and **no product change**: `git diff -- apps` is empty for it.
   > Recorded rather than left standing, because a plan that says a prop is the enabling path sends
   > the next reader looking for wiring that was never needed. The existing component discharged
   > the assembly more directly than this plan predicted.
3. **The round trip.** *Observable:* **the pair** — the chart rendered from the re-imported track
   is identical to the chart rendered before the export. Last because the pair cannot exist until
   both halves do.

If the survey during an increment finds a reason to reorder, it says why rather than reordering
silently.

## Bars

- **"Re-importing reproduces the chart" is relational, so the unit under test is the
  export–import pair.** A test asserting that an imported track "has a chart" is satisfied by any
  chart, and one asserting a hand-written expectation passes while the *pre-export* chart drifts
  away from it. The oracle is the rendered `points` attribute of every polyline, per channel,
  before and after — an identity, not a resemblance.
- **The imported chart must be rendered from the imported track.** The obvious vacuity here is a
  scenario that re-reads the same review it already had; the increment must show the second chart
  came from a document built out of the exported file, and a mutation that renders the original
  twice has to fail.
- **A descriptor is not a sample.** ADR-0029 makes a declared-but-unsampled channel
  indistinguishable from an undeclared one, so `data-channel` being present is not evidence that
  anything was recorded. The assertion pairs the figure's presence with a **non-empty** polyline.
- **Do not re-prove `portability`.** The parallel-array encoding and its round trip are `core`'s
  and are tested there. What this task owns is that the *demo* puts samples in and gets a chart
  out; a browser test re-asserting the encoding is testing the wrong layer.
- **No new public API.** T7.1 changed one published thing and T7.1b changed none; the same
  `git diff -- packages` is the expectation. The sensor seam already exists, so needing to widen
  anything is a finding to report, not a prop to add.
- **The equivalence scenario stays green by declaration, never by weakening.** The declaration
  names the channel paths and cites the ADR. A mutation that widens it beyond the channel paths —
  swallowing an unrelated difference — must fail.

## What will be got wrong

**"A chart appeared, therefore the channel round-tripped."** `TripReview` will render a chart for
any track that has samples, including the one already in memory. The claim is an identity between
two renders, and the second must be attributable to the imported document.

**Sampling something the recorder would have anyway.** A fake channel whose values are derived from
position or time is indistinguishable from geometry the track already carries, so a chart could be
reproduced from a document that dropped every channel array. The read has to produce values
nothing else in the document could regenerate — **and be deterministic**, so a run reproduces.
Both properties, not one: a clock- or position-derived read is reproducible and regenerable, and a
random read is neither regenerable nor reproducible. A seeded sequence is both.

**Confusing "the descriptor survived" with "the samples survived."** The export carries both, and
an import that restored descriptors while dropping samples renders no figure at all — which is a
*different* failure from one that restored nothing, and the assertions should tell them apart.

**Re-proving T7.1b.** The equivalence scenario is a standing check and this task must keep it
green; it is not this task's evidence and does not need extending beyond the declaration.

## Required mutations

Each must turn a named assertion red:

- the sensor declared but never sampled → no `channels` on any stored point, and the review
  renders no figure;
- samples recorded but the descriptor omitted → `chartable()` finds nothing and the chart is
  absent, distinguishably from the case above;
- the export dropping the channel arrays while keeping `channelDescriptors` → the round-trip pair
  differs, and the "descriptor is not a sample" assertion is what names why;
- the second chart rendered from the original track rather than the imported one → the pair
  assertion passes only because nothing was imported, so it must fail;
- the equivalence declaration widened past the channel paths → an unrelated structural difference
  is swallowed and the comparison stops meaning anything;
- a fake channel painted onto authored points to make the shapes match → the ADR's claim and the
  demo's behaviour disagree, and the authored-trip assertion that no channel exists must fail.
