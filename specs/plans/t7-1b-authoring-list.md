# T7.1b — authoring and list flows

> Bars set 2026-09-08, **before any candidate implementation**, against `main` at `d48363f`
> (the merge of PR #33, which closed T7.1). Four things are settled and cited below rather than
> re-decided; one of them is a boundary a previous task deferred to this one and which this plan
> declines.

## What is settled — cite, do not re-open

1. **T7.1b discharges one criterion of `PRD.md` §6**, not Phase 7's exit: *"A trip drawn by hand is
   byte-for-byte the same shape as a recorded one: same review, same stats, same export."* The
   sensor channel is **T7.1c**'s and the getting-started documentation **T7.2**'s; they discharge
   the exit together.
2. **Persistence is a settled dependency, not a criterion.** T7.1's Done record in `tasks.md` says
   so and names the evidence: `e2e/app-loop.e2e.ts` finalizes a trip with an event and a photo,
   reloads for real, and reads all three back out of the app's own stores. A T7.1b test that
   re-asserts persistence is testing what T7.1 closed. The exception is narrow and real: if some
   behaviour introduced here *specifically threatens* persistence semantics — a draft that writes
   partial state, say — that behaviour needs its own assertion, and the reason has to be stated.
3. **`/lab` retirement is out of scope.** The root app now supersedes `/lab` as the product
   demonstration, but `/lab` remains an **evidence fixture** until each lab-owned browser assertion
   is mapped to an equivalent root-app oracle or deliberately retired. That audit — scenario →
   equivalent root-app evidence? → migrate or delete; if none, is the old claim still required? →
   only then remove — is its own cleanup task. Hiding it inside authoring work would trade known
   evidence for an assumption that the new scenarios are equivalent.
4. **`npm run demo` stays the development runner.** It registers no service worker deliberately;
   the production browser lane is where deployable behaviour is proved. Nothing here changes that.

## Survey — what the repo already has

Findings, before any of them are planned around:

- **T7.1b is assembly, not construction — more so than T7.1 was.** `useTrackList` and
  `useTrackDraft` are both published from `@mapatlas/react`, and **`MapCanvas` already takes
  `draft`, `drawMode` and `onDraw`** (`DrawModeHandlers`: `onVertexAdd`, `onVertexMove`, optional
  `onVertexClick`). The renderer side of drawing exists and is covered by
  `e2e/map-canvas.e2e.ts`. Nothing under `packages/` is expected to change; if something must,
  that is an `api.md` change and an ADR, not a quiet addition.
- **The value is `"authored"`, not `"drawn"`.** `Track.origin` is typed `TrackOrigin` and
  `packages/core/src/draft.ts:428` sets `origin: "authored"`. The acceptance criterion names the
  *field*; the plan names the value so a test is not written against a word that does not exist.
- **A draft built `from` a recorded track becomes `"authored"` too** — asserted at
  `packages/core/src/draft.test.ts:810`. So an "edit this recorded trip" affordance silently
  relabels the trip's provenance. That is a defensible engine behaviour and **not** a feature to
  add here casually; if the demo offers editing at all, the relabelling is the thing to observe.
- **Set-times is a required step, not a nicety.** `toTrack()` throws `TrackDraftIncompleteError`
  while `untimedIndices` is non-empty. A draw→save flow that skips timing does not fail at review,
  it fails at save — which fixes the increment order rather than leaving it to taste.
- **The demo has no list surface at all.** `app.tsx` calls `listTrackSummaries()` exactly once, in
  `openStores`, to prove the database opens; nothing renders a past trip. This is the gap T7.1's
  closure record names as T7.1b's first observable.
- **Existing draw evidence is renderer- and binding-level only**: `e2e/map-canvas.e2e.ts`,
  `packages/react/src/map-canvas.test.ts`, `packages/react/src/use-track-draft.test.ts`. There is
  no app-level authoring flow anywhere, so nothing here can be discharged by citing what exists.

## Scope fence

**In:** a trip list on the root route built from `listTrackSummaries()`; reopening a listed trip
into the existing `TripReview`; the **draw → set-times → pin → save** flow named in `tasks.md`,
over `useTrackDraft` and `MapCanvas`'s published draw mode; and the equivalence evidence that a
drawn trip reviews and exports like a recorded one.

**Out, on the record:** the sensor channel (**T7.1c**) · getting-started documentation (**T7.2**) ·
`/lab` retirement (its own cleanup task, per *What is settled* 3) · editing a recorded trip, unless
an increment argues for it and observes the provenance relabelling · trip deletion UI beyond what
`useTrackList.remove` already publishes, if an increment needs it at all · search, sort, paging or
any list affordance the criterion does not ask for · eviction, quota and resume, which remain
unbuilt and unowned.

## Increments, and the argument for this order

1. **The trip list.** `useTrackList` on the root route, and a listed trip reopening into
   `TripReview`. *Observable:* a trip recorded in this document appears in the list after a
   reload, and reviewing it shows the trip that was recorded. First because *"appears in the
   list"* is half of the acceptance criterion and cannot be observed until the list exists — and
   because it closes the surface gap T7.1 recorded rather than leaving it open across two tasks.
2. **Draw → set times → pin → save.** Draw mode over `MapCanvas`, `interpolateTimes` (or
   `setTimeAt`) for the untimed vertices, an event pinned on the authored geometry, and `save()`.
   *Observable:* a drawn track is stored with `origin: "authored"`, **carries the pinned event**,
   and appears in the list from increment 1.

   Second because the save refuses while vertices are untimed, so the timing step is inside this
   increment and not a later polish.

   **The pin is where the ordering problem lives, and it is not the recorded one.** In the recorded
   loop, `useTrackRecorder` publishes `track` only after `stop()` resolves, so an event dropped
   mid-trip is stored unbound and bound at finalize — the decision and its reasoning are in the
   header of `apps/demo/src/app/loop.tsx`, which is the only place they are recorded. Authoring has
   the same shape for a different reason: a draft is not a track and has no id until `save()`
   returns one,
   so an event pinned while drawing cannot carry a `trackId` either. The event is created first and
   bound to the id `save()` returns — and an event left unbound is unreachable from the trip for
   ever, which is why the observable is the **reopened** review and export containing it, not the
   write succeeding.
3. **The equivalence claim.** *Observable:* the **pair** — one recorded trip and one drawn trip,
   compared. Last because the pair cannot exist until both halves do.

If the survey during an increment finds a reason to reorder, it says why rather than reordering
silently.

## Bars

- **The equivalence claim is relational, so the unit under test is the pair.** A test that asserts
  a drawn trip's export "looks right" against a hand-written expectation is not this criterion: it
  passes while the *recorded* export drifts away from it. The oracle is a diff between the two
  documents produced in the same run.
- **The comparison is structural, and the provenance assertion is separate.** These are two
  claims and conflating them makes the first one impossible: a value diff of two independently
  produced trips can never come out as exactly `{origin}`, because ids, coordinates, timestamps,
  `trackId` references and the GPS fields a recorder supplies all differ **legitimately**. What
  ADR-0014 actually contracts is that *"review, stats, export, offline, and presentation work on an
  authored track with no special cases — the only difference is one enum field"*. So:

  - **one complete structural comparison** — the same set of keys, with the same types at each key,
    compared recursively over the whole document rather than at a chosen depth, for the review's
    inputs and for the exported file;
  - **`origin` asserted separately and by value** — `"recorded"` on one and `"authored"` on the
    other. `TrackOrigin` is `"recorded" | "authored" | "imported"`, so both sides are named rather
    than one being asserted and the other assumed.

  There is **no** "and whatever else is necessarily different" clause. A difference the comparison
  is going to tolerate is declared before the comparison is written, or it is a failure.
- **The optional GPS fields are ruled on up front, in the increment that writes the comparison.**
  `TrackPoint` carries `accuracyM`, `altitudeM`, `altitudeAccuracyM`, `speedMps` and `headingDeg`,
  all optional, and a recorder supplies what the platform gave it while an authored point has none
  of them. That is a **structural** difference — a key present on one side and absent on the other
  — so the rule cannot be discovered while debugging a red test. Either they are excluded from the
  comparison by name, with the exclusion listed, or the comparison is over the required keys only
  and says so. Whichever is chosen, the increment states what it therefore does **not** prove.
- **The stats panel is compared as rendered, not as computed.** `Track.stats` being equal is a
  claim about `finalizeTrack`, which the core already tests. A review that computes correctly and
  renders nothing satisfies it. The criterion says *"same stats panel"*.
- **No new public API.** T7.1 changed exactly one published thing (`MapCanvas`'s `initialCamera`,
  ADR-0037) and touched neither `core` nor `maplibre`; the same `git diff` is the expectation here.
  If a binding genuinely cannot express the flow, that is a finding to report with an ADR, not a
  prop added in passing.
- **Persistence is not re-proved.** Per *What is settled* 2. If an increment does assert it, the
  reason is stated in the same breath.

## What will be got wrong

**"The drawn track saved, therefore it is equivalent."** Storage accepting a track says nothing
about how it reviews or exports. This is the same shape as T7.1's *"the map rendered, therefore the
loop works"*, and the same answer applies: each clause of the criterion gets an observable only
that clause can produce.

**Reaching for value equality because the criterion says "byte-for-byte".** It does not mean two
independent trips hold the same bytes — they cannot. It means an authored track goes down the same
model, review, stats and export paths as a recorded one, with provenance as the only discriminator
(ADR-0014). A test chasing value equality either fails for legitimate reasons or is whittled down,
field by field, into a spot-check of whatever survived — which is how *only* stops meaning
anything.

**A pair whose halves were never comparable.** If the drawn trip is built *from* the recorded
track, `origin` is relabelled (`draft.test.ts:810`) and the two are one object wearing two labels,
which proves nothing about authoring. The pair must be two independently produced trips, and the
comparison must be the structural one above.

**Re-proving what T7.1 closed.** Reload durability is settled. A T7.1b scenario that records,
reloads and checks storage is spending a review round on a green claim.

**Testing the platform instead of the app.** Draw mode is a real pointer interaction, and a
scenario that asserts a drag produced a vertex at an exact pixel is asserting Chromium's hit
testing. What the app owns is that a vertex the user placed reached the draft and the draft reached
the store.

**A list that lists whatever it was handed.** `useTrackList` re-lists; a component test that feeds
it two summaries and finds two rows proves rendering, not listing. The app-level claim is that a
trip *this app stored* is in the list a *later document* renders.

## Required mutations

Each of these must turn a named assertion red:

- a drawn track saved with `origin` left as `"recorded"` → the separate provenance assertion fails,
  while the structural comparison stays green — which is the point of splitting them;
- the pinned event never bound to the id `save()` returned → the reopened review and export do not
  carry it, and the increment-2 observable fails;
- the pinned event dropped before `save()` → the same two assertions fail, distinguishing "the
  event was lost" from "the event was stored but orphaned";
- one field dropped from the drawn trip's export → the structural comparison fails, where a
  spot-check of two named fields would not;
- an optional GPS field left in the comparison without being declared → the comparison fails on the
  authored side, which is the red that forces the rule to be stated rather than discovered;
- the list rendered from state held in the current document rather than from the store → the
  after-reload assertion fails;
- `save()` called with untimed vertices → the flow reports `TrackDraftIncompleteError` rather than
  storing a track the review cannot render;
- the stats panel rendered empty while `Track.stats` is still correct → the rendered comparison
  fails, where an object comparison would not;
- a vertex placed on the map that never reaches the draft → the stored geometry differs from what
  was drawn.
