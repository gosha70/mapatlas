# Continuing MAP-ATLAS — instructions for a new session

Read `CLAUDE.md`, then `specs/tasks.md` for the current task, then this file. This file exists
because a previous session repeatedly overcomplicated work and misidentified problems, and the
specific failure modes are cheap to avoid once named.

---

## Where the work is

**Phase 7 has exited and M1 is reached.** **ADR-0042** is the decision — the evidence, the
alternative not taken, the consequences and the reversal rule — and `roadmap.md`'s exit carries a
dated note pointing at it: `PRD.md` §6's first criterion is met for a developer who **builds
the packages from a checkout** — `api.md` §0 takes them there, every fenced block in it is checked,
and both lanes run the example — and is **not** met for one who runs `npm install @mapatlas/react`,
because nothing is published. The exit was taken on the reading that **§6 names no registry**, and
`api.md` §0 states the situation plainly so no reader is misled while that stands. **Publishing is
post-v1**, in `roadmap.md`'s list, not an omission in Phase 7.

If a later owner rules that §6 does require a registry install, that is an amendment to ADR-0042
and to `roadmap.md`'s note, plus a release task — versioning off `0.0.0`, a publish workflow with provenance,
org ownership, and what `check:packaging` should assert about a *published* artifact rather than a
packed one. It is not a reinterpretation of the note.

**So there is no phase to finish. What is buildable is `tasks.md`'s Phase 8** — three follow-ups,
post-v1, unowned and unordered, each with acceptance criteria written when they were recorded rather
than when someone picks them up.

- **T8.1 — the fixture-build flake.** Tracked in **issue #30**; read it first. Its acceptance
  criterion is deliberately awkward: the failure must be made **reproducible on demand** before it
  is fixed, because a change that merely stops it being observed is indistinguishable from one that
  fixed it.
- **T8.2 — per-package READMEs.** Five of six packages ship none, and the sixth's code is checked by
  nothing. `check:docs`'s rules are already per-document, so the mechanism exists.
- **T8.3 — the `/lab` retirement audit.** Each lab-owned browser assertion mapped to a root-app
  oracle or deliberately retired, shown by the mapping rather than by the suite staying green —
  deleting a scenario also leaves it green.

Two things remain recorded and **not** written up as tasks. Neither is assigned; both are named so
they are not discovered as surprises.

- **`tasks.md` under-records what is built.** It carries a **Done** record for 13 of its 52 tasks.
  The first in document order is T4.6, and Phases 0–3 — 28 tasks, every one built, tested and
  shipping inside the packed tarballs — carry none, as does T5.5, whose replay cursor `TripReview`
  renders today. The README's status block is projected from those records and says so in its own
  words: *a zero means no Done record, not no completed work*. **Backfilling them is a real task and
  a hazardous one** — every existing record cites PRs, commits and plans, and writing the **36
  built tasks that lack one** from memory is exactly what mistake 7c exists to stop. (Phase 8's
  three are unrecorded because they are unbuilt, which is a different thing; the totals in the
  README's block count both.) Whoever takes it on reads the history, not
  the recollection.
- **Eviction-aware re-download, quota UI and download resume remain unbuilt.** T6.1 fenced them out,
  T6.2's survey answered them as questions rather than scope, `architecture.md`'s claim that the
  store *"supports eviction-aware re-download"* was removed because nothing implements it, and no
  task since has taken any of them on.

### T7.2 is closed (2026-09-10, PRs #41, #42 and #43)

`specs/api.md` §0 is the getting-started path, and it shows code that runs: six of its seven fenced
blocks are the same bytes as a file under `examples/quick-start`, and the seventh — the install
command — is generated from the packages this repository builds. `check:docs` fails the build when
either drifts, in either direction. `tasks.md` holds the authoritative Done record;
`specs/plans/t7-2-getting-started.md` is history now, not a work plan.

**ADR-0041** records the boundary the whole task turned on: the example is built and run as a
**packed consumer**, never through the workspace, in two lanes that cannot be one — `check:packaging`
compiles it in a job with no browser, and `e2e/quick-start.e2e.ts` runs it from a build made by the
project's own vite. Neither may fall back to a `paths` entry, a project reference or a vite alias.
An example that only builds inside this repository proves the example works *here*, which is not the
claim anyone is making.

**Map data is explicit consumer-supplied configuration.** The example points at a same-origin
`/basemap.pmtiles` and the browser lane cuts a synthetic archive and serves it there. Removing the
configured source must take the named-colour oracle to zero — if the map still paints without it,
the example is drawing from something the reader was never given.

**The demo's missing import affordance is ruled an accepted limitation**, not a Phase 7 exit
requirement, and §0 states it: the engine publishes `geoJSONToTrack` (§10), `core` tests it, and
`app-channel.e2e.ts` drives an export → import round trip through the demo's own storage seam. The
question T7.1c's close-out left open is therefore closed, in the open, as it asked.

### T7.1c is closed (2026-09-09, PR #38, merged as `c36d151`)

The demo records a telemetry channel through the published `SensorSource` seam, charts it in
review, and carries the evidence that the chart survives an export and a re-import unchanged.
`tasks.md` holds the authoritative Done record with one bullet per plan requirement;
`specs/plans/t7-1c-channel-demo.md` is history now, not a work plan. Nothing under `packages/`
changed, and two of the three increments changed no application code at all.

**ADR-0040** records that an authored trip carries no sensor channels, and the equivalence
comparison declares the channel paths citing it — a scoped statement written *before* the
declaration, in the increment that caused the red, with the claim itself asserted separately by
value because an exclusion is not evidence.

### T7.1b is closed (2026-09-08, PR #35, merged as `7828d9f`)

The demo lists its stored trips and reopens one for review, authors a trip by hand — draw, set
times, pin an event, save — and carries the evidence that an authored trip is the same kind of
thing as a recorded one. `tasks.md` holds the authoritative Done record with one bullet per plan
requirement; `specs/plans/t7-1b-authoring-list.md` is history now, not a work plan. Nothing under
`packages/` changed across the whole task.

**`/lab` is still an evidence fixture, and its retirement is still nobody's task yet.** The root
app now supersedes it as the product demonstration, which is what made retirement *thinkable* —
but `/lab` remains the subject of five merged browser scenarios, and removing it before each of
those assertions is mapped to an equivalent root-app oracle would trade known evidence for an
assumption. The audit is its own cleanup task: per scenario, is there equivalent root-app
evidence? If yes, migrate or delete; if no, is the old claim still required? Only then remove.

### T7.1 is closed (2026-09-08)

The demo app ships: the loop over published bindings, GeoJSON export, a consumer
`EventPresentation`, a self-hosted OpenStreetMap basemap over the Copernicus DEM, a downloadable
region, and an application shell that survives a reload with its own origin unreachable.
`tasks.md` carries the authoritative Done record with the criterion-by-criterion evidence;
`specs/plans/t7-1-demo-app.md` is history now, not a work plan. PRs #26, #28, #29, #31 and #32 are
merged; the offline slice (`c050a48`, `026f028`, `de6133b`) lands with `codex/t7-1-offline`.

**"Offline" now means two things in this repository, and they fail independently.** Map data
offline is Phase 6's and ADR-0035's: an archive is served from `MapAssetStore` under its own url.
App-shell offline is T7.1's and ADR-0039's: the built shell is precached by a worker generated
from the emitted bundle, which owns the shell and never a map archive. A test that establishes one
establishes nothing about the other — and **user-data offline was never a network concern at all**,
since recording has always written to IndexedDB, so cutting the network and watching a recording
succeed asserts something that was already true.

Phases 0–6 are complete and merged: core, persistence, the web recorder, the MapLibre renderer,
and the whole React surface `api.md` §9 publishes (`MapCanvas`, `EventComposer`, `TripReview`,
plus replay). `NOT_YET_BUILT` in `packages/react/src/index.test.ts` is retired — it went red four
times, each time a component reached the barrel unverified, which is what forced it into the
exact §9 checks.

### T6.2 is merged (PR #23, 2026-09-05)

Persistence UX ships: the root route reports whether the origin is persistent, requests it from a
real button a person activated, reports all five answers distinguishably, and carries static
install-first guidance. Demo-only — nothing published changed. `tasks.md` carries the
authoritative Done record; `specs/plans/t6-2-persistence-ux.md` is history now, not a work plan.

Its increment 0 also corrected the record: **automatic eviction takes an origin's data together**,
so the browser cannot spare a user's trips by taking basemaps first and cannot leave a region
manifest naming an archive it removed. ADR-0016 had said both, one sentence apart. Do not
reintroduce the selective-eviction story anywhere.

### T6.1 is merged (PR #20, 2026-09-05)

`OfflineRegionStore` ships: the licence flag, the store over `MapAssetStore`, the archive
protocol seam, the renderer's `pmtilesArchiveRegistrar()`, and the offline render with its
positive control. `tasks.md` carries the authoritative Done record and names what discharges
each criterion; `specs/plans/t6-1-region-store.md` is history now, not a work plan.

**What is worth carrying forward from it**, because both cost a review round each:

- The two sections below — the provenance bar, and the mistakes list — are *not* T6.1-specific.
  They are why that task landed with falsifiable evidence, and T6.2 applied them unchanged.
- **"Offline" was narrowed to *map data* offline**, deliberately and on the record (ADR-0035,
  T6.1 in `tasks.md`, the Phase 6 exit in `roadmap.md`). The app shell is still served from its
  own origin; making *that* work offline is T7.1's criterion — restated at the top of this file,
  because it is the assumption Phase 7 is most likely to inherit without checking.

### T4.6 is closed. T6.1 does not reopen it

**This section used to say the opposite, and it was stale.** It claimed T4.6's rendered-state
evidence, pause differential and performance baseline were outstanding, and that one offline
scenario would discharge a T4.6 exit alongside T6.1's. `tasks.md` is authoritative and marks
T4.6 **Done** (2026-09-01, PR #9 and #10), naming what discharges each criterion: `lab.e2e.ts`
for egress on both seams, `render-differential.e2e.ts` for the pause as a set relation,
`performance-baseline.e2e.ts` for the baseline. Nothing in T6.1 is needed for any of them.

What T6.1 inherits from T4.6 is **infrastructure, not an exit**: the `/lab` route, the fixture
track and simulated GPS in `apps/demo/src/lab/`, and the two archives `npm run fixture:build`
cuts — `terrain.pmtiles` (raster-DEM) and `contours.pmtiles` (vector MVT) — which happen to be
exactly the DEM/vector stack T6.1's own bar demands. Reusing them is why T6.1's offline scenario
was cheap to write. It closes **T6.1 only**.

Read a claim that increment 4 also closes something in T4.6 as a mistake, wherever it appears.

### The bar that was got wrong, and how it was met

Kept because the shape generalises, not because T6.1 still needs it.

*"Proving bytes were copied locally, not range-requested"* was the middle claim of T6.1's AC, and
**zero network requests is not evidence for it.** A service worker, an HTTP cache hit, or a
`blob:` URL minted earlier all produce zero requests while proving nothing about the store. The
claim is about *provenance* — which code path supplied the bytes — and it split across the seam
where each half is observable:

- **Unit, at the protocol seam:** the store-backed handler MapLibre calls returns exactly the
  bytes `put()` stored, keyed by what `download()` wrote. Byte identity is asserted there, with
  the stored blob overwritten afterwards so a reader that re-fetched its url is caught.
- **Browser:** the archive host cut *after* the app and archives have loaded, region present →
  tiles render; region deleted, same cut → render fails. That second half is the positive
  control, and without it the first proves only that something rendered.

Two things had to be corrected in the building, and both are the general lesson:

- **Cut the network after load, not before** — otherwise the app never boots and the failure
  looks like the test working. Make that failure *legible*: `/lab` publishes a failed-step
  marker, and the waits watch for it, so the mistake surfaces in seconds instead of as a timeout.
- **A request count is not a copy.** The first version counted every archive request across the
  download *and* the render that followed, so the render's range reads could vouch for a copy
  that never happened. Requests are now counted per archive and split by kind: a plain GET is a
  copy, a range read is the renderer reading. The vacuous version passed a mutation the real one
  kills.

## The mistakes to not repeat

### 1. Do not confuse "the check exists" with "the obligation is discharged"

Saying "coverage and gap check done — obligations 2 and 3" was wrong. The checks existed, were
unit-tested and were wired into an orchestrator that had never run against S3. An obligation
whose only exercise is a fake returning `{status: 404}` is *implemented*, not discharged.

Say **which**, not **whether**: name what is verified, what is not, and whether the remaining
work is confirmatory or exploratory.

### 2. Before planning around a blocker, check the blocker is real — and check the *route*, not
just the host

Two decisions in T4.6 dissolved on a five-minute check after standing for multiple review
rounds. A third — "the licence text is unreachable" — was a claim about **one URL probed three
times**, written up as a claim about the document. The text was available the whole time from
`documentation.dataspace.copernicus.eu`.

Tells that a blocker is a lookup wearing a decision's costume:

- it names an *input* ("pending whether X") rather than a *condition*
- it justifies itself by cost or lead time, when none of its own criteria turn on either
- it has been re-probed at one address rather than sought by several routes

The rule is **check first**, not "the blocker is probably fake" — sometimes the answer is
legitimately "not yet knowable", and that is a cheap, correct result.

### 3. Put a gate where the risk is, not where it is convenient

The licence check was ordered first in the build, argued as "cheapest-and-most-decisive first".
That was right for a distributable archive and wrong for everything else: a missing legal string
then blocked the writer, the tile reader and the contour source, none of which redistribute
anything. The obligation is about **distribution**; gating **execution** on it was a design
error.

When a gate blocks more than its own concern, move the gate — do not add an escape hatch. The
fix here was a `distributable: false` mode that writes to a `.dev` path and must carry a
`NOT-FOR-DISTRIBUTION` marker: one obligation traded for another, with no flag that lets a
*distributable* build skip the licence.

### 4. When a measurement fails, suspect the instrument first

The contour probe produced **five** successive false failures, all with the same signature (an
open chain with negative area error), every one an instrument fault rather than a chain defect:

1. rings identified by measured width — clipped multi-tile rings looked missing
2. seam continuity sought as a shared vertex, which simplification legitimately removes
3. stitching dropped the buffer *box* but kept the buffer *overlap*
4. two snapping resolutions between edge dedup and the cycle graph
5. **a grid key is not a proximity test** — two points 1.672 units apart in a two-unit grid
   round into adjacent cells and never merge

Practical rules that follow:

- identify features by their **tag**, never by measuring their geometry
- assert the precondition was actually reached, do not infer it from scale or setup
  (a gzip run once built no leaf directories while looking like a leaf-directory test)
- if a fix makes results *worse*, the diagnosis is wrong — stop and re-diagnose
- after two instrument faults on the same question, **freeze the harness and hand it over**
  rather than continuing to debug from inside

### 5. Ask whether a passing result would look identical if it were broken

Several checks passed for the wrong reason:

- a hit-test agreement test placed both lanes at identical coordinates, removing the difference
  it was examining
- an attribution check scanned every archive entry, and since the declared strings come *from*
  the licence, any archive carrying `LICENSE` passed with no credit emitted
- `git status` and the remote-tracking ref reported push state that was simply stale

For any check that guards something that matters, name the observation that distinguishes
working from bypassed, and assert *that* — not the absence of an alarm.

### 6. A test that a stylesheet arrived says nothing about whether the result is readable

The root route's layout tests asserted the things a test can see: the font family was
`system-ui`, and the control's box was neither flush against the viewport nor spanning it. Both
held. **Every assertion passed while the headings were invisible** — the stylesheet fixed a text
colour and declared no background, so under a dark canvas the intro, the status headline, the
guidance heading and all three step titles rendered near-black on near-black.

Neither lane could have caught it. The unit lane has no canvas; the browser lane asserted exactly
what it was told to. It was found by **opening the page**, which is the check neither lane makes,
and it is the only finding on that branch that came from looking rather than reading.

The remedy is one CSS rule and one assertion — the body's computed `backgroundColor` is not
transparent, which is what separates "declared a background" from "inherited whatever the canvas
is". The lesson is larger than the rule: when a change is visual, look at it.

### 7c. A bar quoted from a spec is not a verified bar

Before implementation, verify load-bearing plan claims against the current contract and code. T7.1c
found **three** planning statements that were authoritative-looking and false in implementation:

- `PRD.md` §6's *"attaches a telemetry channel to every track point"* — stronger than ADR-0009,
  and unmeetable by any polling source;
- the plan's *"charted through `TripReview`'s `channels` prop"* — the prop **narrows** the charted
  set; ADR-0029's default already enabled it, and no wiring was needed;
- the plan's *"the imported trip has an id of its own and appears as its own row"* —
  `geoJSONToTrack` preserves `properties.id` and `origin`, so an import **overwrites** its source.

Each had been repeated forward from a document rather than read against the code. **Preserve the
original statement, record the correction beside it, and change the evidence — not the engine — to
match the actual contract.** All three corrections here are dated amendments; none rewrote history.

The common rule, and it is the same failure as the ADR-0026 misattribution recorded in the standing
conventions — that citation came out of a conversation summary, these came out of a plan:
**citation establishes provenance; verification establishes truth.** A number, a quote or a
prediction repeated from a document is a pointer to where someone once checked something. It is not
the check. Read the source before you build on it, and say so when it turns out to disagree.

Related: 7b below is what happens when the *evidence* is allowed to grow to fit the failures instead.

### 7d. A command in a document is a claim; run it

A fenced block that a reader is invited to copy is an assertion about what happens when they do,
and reading it proves nothing. T7.2's install block was generated from the right constants, matched
its projection byte for byte, and was wrong twice.

`npm pack packages/core` does not pack `packages/core`. npm reads a bare path as a **package spec**
and resolves it as the GitHub shorthand `packages/core`, failing with *"Repository not found"*; only
`./packages/core` is seen as a path. And the block moved between two directories — build in the
checkout, install in the reader's project — without ever saying so, which would have installed the
engine back into the workspace that had just built it. The walkthrough that "proved" the block
worked had silently supplied the missing `cd`, which is precisely what a reader would not.

Both were found by executing the block with real paths and looking at where the files landed, and
neither could have been found any other way: the projector was consistent, the gate was green, and
the prose was accurate. **Generation makes a block impossible to drift; it does not make it
correct.** Run it, then check the side effects — not just the exit code.

Related: 7c above is the same rule for a *quoted* claim. Citation establishes provenance;
verification establishes truth.

### 7b. A tolerated-difference list grown from failures is a spot-check wearing a rule's clothes

T7.1b's equivalence comparison declares the fields it will not compare — the GPS values only a
recorder can supply. The bar said those must be **named before the comparison is written**, and
the run produced the counterexample twice in one sitting. The first execution reported
`simplifiedSegments[][].accuracyM`: the Douglas–Peucker cache holds `TrackPoint`s too, so the same
fields appear under a spelling nobody had enumerated. The second reported
`features[].properties.accuracyM[]` and `[][]`: the export carries per-point values as arrays.

Both would have been *fixed* by appending whatever the red run printed. That is the trap, and it
is not obvious while it is happening — each addition looks like a correction, the list grows one
true entry at a time, and what is left at the end is a comparison that tolerates exactly the
differences that happened to occur. **A tolerated-difference list grown from failures is
indistinguishable from a spot-check**, which is the thing the bar exists to forbid.

The answer is that a declaration has to be a *scoped statement made in advance* rather than an
enumeration: the fields were named once, in one list, and the declaration was made to cover a path
**and everything beneath it** at real path boundaries — so a third spelling of the same field is
covered by the rule rather than by a new line. Applies to any allow-list, ignore-list or expected
failures file: if it grew by one entry per red run, it is not a rule and nobody can check it.

### 7. A test that asks the platform to agree with you is testing the platform

A test that calls `navigator.storage.persist()` and expects `true` asserts Chromium's engagement
heuristics about a test page. It passes or fails for reasons unrelated to the code, and when it
passes it reads as evidence that persistence works. Three engines decide by heuristic and one
asks a human; none of them owes a test an answer.

What is assertable is the code's own behaviour around the call: **when** it happens (never on
load), **how many times** (exactly one per activation, none while the status check is in flight),
and that **each answer is reported as the thing it is**. The browser lane counts the native call
by wrapping and forwarding it, so the platform still decides and a control that hard-coded an
outcome is caught.

Same shape as "zero network requests is not evidence" (T6.1) — and **T7.1 is storage-adjacent
throughout**, so it will meet this again on its first offline round-trip test.

---

## Standing conventions in this repo

- **Never commit or push without explicit instruction.** A `PreToolUse` hook enforces both; run
  the approval `touch` in its own Bash call, never compounded with the git command. A compound
  `add && commit` that is blocked drops the `add` too.
- **State push status from `git ls-remote` and `.git/logs/refs/remotes/origin/<branch>`**, never
  from `git status`. Something on this machine pushes commits without being asked — event-driven,
  lagging ~10–320 s, not per-commit, carrying whatever backlog exists. Unidentified. A single
  `ls-remote` immediately after committing can be raced.
- **Verify claims about state with a command rather than from memory.** Three ledger claims in
  one session resolved differently than stated.
- **Search the issues before investigating a recurring CI failure** — by the failing test's name
  and by the distinctive part of the error text, not by a guess at what someone would have called
  it. A failure that has happened before usually has a record, and that record holds the leads
  already ruled out. Add the new occurrence to the existing issue rather than repeating the
  investigation: issue #30's fixture flake was diagnosed twice, the second time reaching the same
  lead and re-testing a hypothesis the issue already recorded as eliminated.
- **`git checkout <path>` restores from the *index*, not from HEAD.** With a file staged and then
  edited, it silently discards the unstaged edits and leaves the staged version — which looks like
  a successful restore. Mutation-testing a file that already carries staged review fixes is exactly
  the shape that bites: the mutant is reverted and so are the fixes. **Copy the file to a scratch
  path before mutating it and restore from there**, and verify with `cmp` or a hash rather than
  trusting that the restore did what it looked like. An untracked file is worse: `git checkout`
  reports nothing at all and changes nothing.
- **Mutation-test every guard**: break the subject, confirm the test goes red. A guard whose
  mutation survives is either dead code or untested; both matter.
- **Do not add unobservable defensive code.** If removing a guard leaves the suite green, it is a
  claim nobody can check. Remove it or make the protected path observable.
- **Label verification honestly.** Gate runs and mutations you ran yourself are *author
  verification*. Say so. Independent adjudication is worth a lot more and should be marked.
- **`gh pr edit` can fail silently on this repository.** It goes through the GraphQL API, which
  returns a Projects-classic deprecation error; `gh` prints it and exits **without changing the
  title or body**, so a PR keeps whatever GitHub generated from the first commit. Read the PR back
  after editing, and use `gh api -X PATCH repos/<owner>/<repo>/pulls/<n> -f title=… -F body=@file`
  instead, which is REST and works. Worth knowing before it is read as one's own mistake.
- Every source file needs `// SPDX-License-Identifier: Apache-2.0`; commits use `-s`.
- Gates: `npm run verify` (build, typecheck, lint, coverage, isolation scan, SPDX scan, prettier,
  packaging check) and `npm run test:browser`. Check the **exit code**, not the printed output.

---

## T4.6's items, for the record — all of them closed

> **Nothing here is outstanding.** `tasks.md` marks T4.6 Done (2026-09-01, PR #9 and #10). This
> list is kept as history, because item 9 stood as "outstanding" here long after the work that
> discharged it had merged, and a struck-through record is harder to misread than a deleted one.

1. ~~Adopt the contour toolchain as dependencies.~~ **Done.** `d3-contour` 4.0.2, `geojson-vt`
   4.0.3 and `vt-pbf` 3.1.3 are pinned dependencies, and `scripts/fixture/contour.mjs` traces
   isolines and cuts them to MVT, and the build writes a second archive from it.
2. ~~Confirm the PMTiles writer at fixture scale.~~ **Done.** `s2-pmtiles` 1.1.2 is adopted and
   `scripts/fixture/archive.mjs` writes real archives, over `FileWriter` — `BufferWriter` is
   unusable at scale.
3. ~~A real tile reader, and wiring it in.~~ **Done.** `scripts/fixture/source.mjs` range-reads a
   GLO-30 COG with no GeoTIFF dependency; `scripts/fixture/deps.mjs` binds it and a real S3 probe
   behind the build's seams, which are async. It is part of the discharged terrain path.
4. ~~Wire the contour source into the build.~~ **Done.** A second archive per ADR-0025, levels
   from the declared region's samples, envelope still read for interpolation and tiling.
5. ~~**Produce an actual archive**~~ **Done.** `npm run fixture:build` cuts the terrain
   archive from the real release: 8 tiles, 1,493,696 bytes, reproducible byte for byte.
6. ~~Measure archive size~~ **Done.** 1,493,696 bytes, measured (ADR-0024 criterion 6).
7. ~~The fixture track: ≥5k points, two-segment pause, two event marks.~~ **Done.**
   `apps/demo/src/lab/fixture-track.ts`.
8. ~~`/lab` route in `apps/demo`, plus simulated GPS.~~ **Done.** `apps/demo/src/lab/lab.ts` and
   `simulated-geolocation.ts`; the route is driven by `render-differential.e2e.ts` and
   `performance-baseline.e2e.ts`.
9. ~~Rendered-state evidence, the three-capture differential over the pause, and the
   frame-time/memory baseline.~~ **Done.** `lab.e2e.ts` settles the render and compares each
   source against the stack missing it; `render-differential.e2e.ts` proves the pause as a set
   relation, 0 added and 0 lost against a bridged control contributing 827 corridor pixels;
   `performance-baseline.e2e.ts` records frame time and memory with no thresholds. See
   `tasks.md` for the authoritative statement of what discharges each.

One qualification that a summary will round away if you let it: Bar 2 is discharged **on
topology**. The synthetic run's ≤0.8% area agreement does *not* hold universally on real data —
10 of 128 cases reach 6.54%. If area fidelity is ever promoted into the requirement, Bar 2 stops
being discharged. Decide that deliberately; do not inherit it from the synthetic figure.

---

## How to work here

Small increments, each with tests and mutations, each ending at a coherent commit boundary.
Propose the commit message; do not commit until told. Prefer finishing one thing to starting
three. When a review finding arrives, fix the finding — and check whether the same class of
error appears elsewhere before declaring done.

Above all: when something looks like a hard problem, spend five minutes checking whether it is
one. In this task, three times out of three, it was not.
