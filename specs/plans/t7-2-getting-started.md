# T7.2 — getting started

> Bars set 2026-09-09, **before any candidate implementation**, against `main` at `3cc2256`
> (the merge of PR #39, which closed T7.1c). Every survey finding below was read out of the code
> or the specs at that commit and is cited; nothing is repeated forward from a plan.
>
> **Amended 2026-09-10 (increment 1), in the required-mutations list only.** One mutation was
> written here that cannot reach the assertion it names. It is struck through rather than deleted,
> with the mutation that does reach it beside it — a bar that was wrong is evidence about how this
> plan was written, and a list that quietly loses its mistakes cannot be audited.

## What is settled — cite, do not re-open

1. **T7.2 discharges one criterion of `PRD.md` §6**, and it is the first one listed: *"A developer
   can embed the React `<MapCanvas>` + recorder + event composer and get the full
   record→pin→photo→review loop working in an afternoon, reading only `api.md`."* `tasks.md` states
   the acceptance criterion as *"a new consumer following the doc reaches a working map+event
   loop."*
2. **T7.2 is the last planned task before Phase 7's exit**, which `roadmap.md` states as *"the
   success criteria in `PRD.md` §6 are demonstrably met end-to-end, offline"* — delegating entirely
   to §6. It does not add its own requirements.
3. **The demo is finished and is not this task's to extend.** The loop, export, the trip list, hand
   authoring, the telemetry channel, the offline region and the offline app shell are all built,
   all have browser evidence, and all have Done records. T7.2 is *derived from* `api.md` and from
   what the demo already does; it is not a licence to add product to make the prose easier.
4. **`/lab` retirement remains its own cleanup task**, and eviction, quota and download resume
   remain unbuilt and unowned.

## The disposition this plan is required to settle first

**The demo exposes export and offers no import affordance. This plan rules it an accepted
limitation of the demo, not a Phase 7 exit requirement**, and records where that is written:

- `roadmap.md`'s Phase 7 exit delegates to `PRD.md` §6 and adds nothing.
- §6's demo criterion is *"records a trip and events fully offline, persists across reload, and
  exports valid GeoJSON"* — **export only**.
- Import appears in §4 item 14 and in §5's *In* list, sections titled *"Core user stories (engine
  capabilities)"* and *"Scope (v1 = the engine)"*. The engine has import, `core` tests it, and
  T7.1c proved the export → import round trip through the demo's own storage seam.

So no document requires the affordance and Phase 7's exit does not turn on it. **What T7.2 does owe
it is visibility**: the getting-started path must say plainly that the demo exports and does not
import, and that the *importer is published* — a consumer who needs it is not blocked by the
engine, only by the demo's surface. It stays on the unowned list.

**If the reviewer rules the other way, that is an amendment to `PRD.md` or `roadmap.md` and a task
of its own**, not something this plan absorbs.

## Survey — what the repo already has

- **The root README is materially false, and it is the front door.** It says *"Phase 0 complete;
  core implementation begins in Phase 1"* and *"No product runtime logic exists yet — the engine's
  data model, seams, and track logic are Phase 1"*. Phases 0–6 and T7.1, T7.1b and T7.1c are all
  merged. A getting-started path whose first page contradicts the repository is not a getting-started
  path.
- **Five packages of six ship no README at all.** Only `@mapatlas/maplibre` has one
  (`@mapatlas/core`, `@mapatlas/react`, `@mapatlas/recorder-web`, `@mapatlas/storage-idb` and
  `@mapatlas/offline-pmtiles` have none), so a consumer arriving from npm at any of the other five
  gets nothing.
- **The one README that carries code has none of it checked.** `check-packaging.mjs:322` asserts
  only that `README.md` *exists* in the packed tarball. Its install snippet, its stylesheet import
  and its `setWorkerUrl` call are prose as far as any gate is concerned.
- **`verify` has no documentation gate.** Build, typecheck, lint, coverage, isolation, SPDX,
  prettier and packaging — nothing reads a document for accuracy.
- **The root README carries zero code blocks.** There is nothing to drift yet, which is the one
  piece of luck in this survey: the first snippet this repository publishes can be born checked.
- **`api.md` is a contract, not a tutorial.** 1,325 lines across ten sections; §9 alone declares
  `useTrackRecorder`, `useEventLog`, `MapCanvas`, `EventComposer`, `TripReview` and the rest. A
  quick start placed *outside* it would become a second contract that drifts — which is one of the
  two reasons it goes inside.
- **The demo already is the worked example**, and it is assembled only from published entry points —
  `apps/demo/src/app/loop.tsx` says so, and `check-packaging` proves that those **imports resolve**
  from packed tarballs in a scratch project. What it does not do is build the demo from those
  artifacts: the demo is compiled and served through the workspace, so "the demo works" is not
  evidence that a consumer's project would. What the
  demo is *not* is minimal: it carries offline regions, a service worker, a trip list, authoring and
  a channel, none of which belong in an afternoon's first loop.

## The bar this task turns on

**"A new consumer following the doc reaches a working map+event loop" is a claim about executing
the doc's code, and the only honest way to hold it is to execute the doc's code.**

Prose describing an API drifts the first time the API moves, silently, and looks correct the whole
time — which is `CONTINUE.md`'s mistake **7c** wearing a different hat: a snippet repeated forward
from an interface rather than checked against it. This repository already refuses that shape
elsewhere: `check-packaging.mjs` proves consumer imports by *packing and resolving* rather than by
reading `package.json`, and `attribution.test.ts` pins a rendered string to a checked-in file so the
map and the archive cannot come to say different things.

So the getting-started example is **a real source file**, the same bytes as what the document
displays, with a gate in `verify` that fails when the two disagree — and it is built and run **as a
consumer, not as a workspace member.**

**That distinction is the whole claim, and getting it wrong would make the evidence worthless.**
`tsc --build` inside this monorepo resolves `@mapatlas/*` through TypeScript project references, and
vite resolves them through the aliases in `apps/demo/vite.config.ts` — *"every alias here is a bare
package name resolving to its built entry: what `npm install` would give"*. A new consumer has
neither. An example that compiled and ran under those would prove that the example works **here**,
which is exactly what nobody is asking. `check-packaging.mjs` already refuses that shape for
imports: it packs the tarballs, installs them into a scratch project, and resolves there, because a
`package.json` read in place cannot tell you what a consumer gets.

The example is therefore proved **twice, in two lanes, against the same packed artifacts** — and
the two proofs are stated separately because they cannot be one. CI's `gates` job has no Chromium,
and `check-packaging` deletes its scratch project when it is done, so "install the tarballs and run
the app" is not a thing one gate does:

- **`verify`, through `check-packaging`:** install the packed tarballs into an isolated project and
  **compile or bundle the exact example** there — the same bytes the document shows — with no
  workspace resolution available. This is the extension of what that script already does, from
  *does this import resolve* to *does this example build*, and it runs in a job with no browser.
- **The browser lane, independently:** build and serve that same packed-consumer artifact and
  **execute the full loop** against it, with the four observables above.

**Neither lane may fall back to a workspace alias.** A `paths` entry, a project reference or a vite
alias that quietly rescues an import turns both proofs back into "it works here". If the example
only builds inside the repository, that is a finding about the packages, not a detail of the
harness.

**And the documentation target is one document, because `PRD.md` §6 says one.** The criterion is
that a developer gets the loop working *"reading only `api.md`"*. A separate getting-started page
that links to `api.md` makes the answer *two* documents, and reading "only" as "chiefly" is
reinterpreting the criterion rather than meeting it — which is precisely the move mistake **7c**
exists to stop.

**So the quick start goes inside `specs/api.md`**, as a section of the contract it is derived from,
with its code blocks held by the drift gate like any other. The root README **links** to it and adds
**no instructional code of its own** — its only content beyond that link is the generated status
block below, which is projected rather than written. `tasks.md` phrases T7.2 as *"docs derived from `api.md`"*, which a section of
`api.md` satisfies in the strongest available sense — it is not merely derived from the contract, it
is part of it, and it cannot drift from the neighbouring declarations without the same file being
edited.

**If the reviewer prefers a separate page, that is an explicit amendment to `PRD.md` §6 and
`tasks.md`**, dated and recorded like the three T7.1c corrections — not something this plan decides
by rewording.

What the example may not do, either way, is depend on knowledge that exists in this repository and
nowhere a consumer can see: no `specs/` beyond `api.md`, no `apps/demo` source, no `e2e/harness`.

## Scope fence

**In:** a quick-start section **inside `specs/api.md`** taking a consumer from an empty project to
the full record → pin → photo → review loop; a minimal example that is real, compiled and exercised; a mechanical
check that the document and the example cannot diverge; the root README corrected to what is true;
and the import-affordance limitation made visible.

**Out, on the record:** any new product in the demo or the packages · an import affordance
(above) · a documentation site, generator or theme · tutorials beyond the one criterion — offline,
authoring, channels and the analyzer each have their own Done record and their own evidence, and a
quick start that covered them would not be an afternoon · `/lab` retirement · eviction,
quota and resume · **per-package READMEs**, which the survey found missing on five of six packages
and which are a real gap — dispositioned below rather than absorbed.

**The per-package README gap is recorded, not fixed here.** Five of the six packages ship **no
README** — the packages themselves publish; what a consumer landing on them finds is nothing — and
the sixth ships code no gate reads. That is a publishing-surface problem with its own shape — every
package needs one, each needs its code held to the same standard as the getting-started example, and
`check-packaging` is where the existence check already lives. It is adjacent to this task and not
this task, and hiding it inside "getting started" would make a one-criterion document into a
six-package documentation sweep. **A follow-up task should own it**; this plan names it so it is not
discovered after Phase 7 is called complete.

## Increments, and the argument for this order

1. **The example, executed — the whole loop, not the first half of it.** `PRD.md` §6 asks for
   *"the full record→pin→photo→review loop"*, so the example mounts `MapCanvas`, records with
   `useTrackRecorder`, pins an event through `EventComposer` **with a photo attached**, and renders
   the finalized track, that event and that photo through `TripReview`. Built and run as a consumer
   (above), not as a workspace member.

   *Observable, each step on its own evidence*, because the composite — "a review appeared" — is
   satisfied by a loop that recorded nothing, pinned nothing and attached nothing, which is the trap
   `app-loop.e2e.ts` was written against and was caught by once:

   - the map **drew** — a named colour the example's own style paints, counted on the canvas. Not
     "a canvas exists": a canvas proves a component mounted, and T7.1 established that a map can
     mount, parse a style, emit `sourcedata` and never build a tile. This is the oracle the
     no-sources mutation below fails against, **and it needs real map data, which the quick start
     may not supply** — see below;
   - the recorder kept more than one fix — read from what the review reports, not from the canvas;
   - the event reached storage, with its `blobKey`;
   - and the review **renders the photo**, resolved from that `blobKey` through the store the
     example handed it — which is the whole chain in one observation and the only one of these that
     needs the review to exist.

   **Where the map data comes from is decided here, not in the increment**, because the colour
   oracle is load-bearing and the two obvious answers are both forbidden. The example may not read
   `apps/demo`'s archives or `e2e/fixtures`' — a consumer cannot see either, and the whole
   packed-consumer boundary exists to stop exactly that. And it may not bake in a public community
   or government tile host: `CLAUDE.md`'s guardrails are *"no bundled map tiles"* and *"no telemetry
   / network egress the consumer did not configure"*, and a copyable snippet pointing at somebody
   else's tile server sends every reader's traffic there under a usage policy this repository has
   not agreed to.

   So the boundary is: **map data is explicit consumer-supplied configuration in the example, with
   its attribution beside it**, and the browser lane **injects a synthetic self-hosted source into
   that same configuration point** — the same code, given a source the lane cut for itself, which is
   how `/lab` and `app-shell` already work. **No repository-only URL may appear in the copyable
   blocks**, and the reader is told, in the prose, that this is the one thing they must bring. The
   check that this stays honest is a mutation: **removing the configured source must kill the colour
   oracle** — if the map still paints without it, the example is drawing from something the reader
   was never given.

   First because a document about code that does not exist cannot be checked, and because writing
   the prose first is how the prose becomes the thing being satisfied.
2. **The check that the quick-start section cannot drift from it.** A gate in `verify` comparing the
   quick-start section's fenced blocks against the example's source. *Observable:* editing either one
   alone fails the build. Second because there is nothing to check until the example exists.
3. **The prose, and the corrections it makes true.** The quick-start section in `specs/api.md`
   around the checked blocks, the root README reduced to a link plus its generated status block, and
   the import limitation made visible. *Observable:* every code block **in the quick-start section**
   is checked by increment 2 — `api.md`'s existing declaration blocks are the contract and are not
   mirrors of any example file, so the gate must not claim them — and the README asserts no status
   outside its generated block. Last because the prose is the part that must be written against
   what exists, not the part that decides it.

If the survey during an increment finds a reason to reorder, it says why rather than reordering
silently.

## Bars

- **Every code block in the quick start is checked against a compiled source, or it is not in the
  quick start.** A block that cannot be checked — a shell command, a `package.json`
  fragment — is either brought under a check of its own or is not presented as something to copy.
  There is no third category of "illustrative" code: illustrative code is code that is allowed to be
  wrong.
- **The example is exercised, not merely compiled.** `tsc` proves the types line up; it does not
  prove a map mounts or an event is stored. The browser lane runs the example itself, on its own
  route, so "a working map+event loop" is a thing observed rather than a thing typechecked.
- **The example is minimal, and what it omits it omits deliberately.** The criterion is *an
  afternoon*, and the demo is the full app. Anything the example leaves out — offline, authoring,
  channels, the analyzer, persistence UI — is a pointer to where that is already proved, not an
  omission the reader has to notice.
- **The quick start shows a *use*; it does not restate the declarations it sits beside.** Being a
  section of `api.md` removes the two-contracts problem rather than managing it — but it introduces
  its own: a section that re-declares signatures a few hundred lines from where they are declared is
  the same drift in one file. It shows the calls, and the surrounding sections stay the contract.
- **Nothing under `packages/` or `apps/demo/` changes.** T7.1c changed no package code and two of
  its three increments changed no application code either; the same `git diff` is the expectation.
  If the example cannot be written from published entry points, that is a finding to report — it
  would mean the engine is not embeddable as `api.md` claims — and not a reason to reach past them.
- **The root README carries no status claim that a gate cannot check.** It is being corrected
  precisely because it drifted, and replacing one set of unchecked assertions with another would be
  the same defect with a newer date — but *"every claim is supported by a Done record"* is not a
  bar, because **no gate can decide whether arbitrary prose is supported**. So the bar is bounded:
  status lives in **one generated block**, projected mechanically from `tasks.md`'s Done records and
  compared byte-for-byte by the same drift gate the example uses. Free prose around it makes no
  claim about what is built and links `tasks.md` instead. A status sentence outside the block is a
  defect whatever it says, because nothing can hold it.

## What will be got wrong

**"The snippet is right because I copied it from the source."** Copying is the drift. The bar is
that the document and the source are the *same bytes*, checked mechanically, on every run — not that
they matched on the day someone pasted.

**Writing the prose first and then making code that fits it.** The document would then be describing
an example built to satisfy the document, and "a consumer reaches a working loop" would be true only
of the path the author happened to walk. The example exists and runs first.

**A "getting started" that gets the whole engine started.** Offline regions, the service worker,
authoring, channels — each has a Done record and browser evidence, and each would add an hour to an
afternoon. The criterion names the record → pin → photo → review loop and the four surfaces that
carry it — `<MapCanvas>`, the recorder, the event composer, and the review that shows the result;
everything else in the demo is outside it.

**Correcting the README from memory.** The status section is wrong today because it was written once
and never re-read. Every replacement claim is checked against `tasks.md`'s Done records or a gate,
or it is not made — mistake 7c, in the document most likely to be skimmed.

**Treating "an afternoon" as unfalsifiable and therefore unbounded.** It cannot be measured here,
and that is not a licence to ignore it: it is what makes the minimality bar a bar rather than a
preference.

## Required mutations

Each must turn a named assertion red:

- a signature in the document's snippet changed while the example is left alone → the drift gate
  fails, in both directions (edit the example instead → the same gate fails);
- the example's `MapCanvas` given no sources → the named-colour count on the canvas is zero, where
  a typecheck passes and a canvas is still present;
- ~~the example's recorder never started → the review reports no kept fixes~~ — **malformed;
  found and replaced in increment 1.** An example that never starts the recorder cannot reach a
  review at all: the mutant is killed by the scenario's wait for `data-status="recording"`, several
  steps before any review exists, so it says nothing about whether *"more than one fix"* is
  observable. What it actually checks is that the flow cannot proceed without a recording, which
  was never in doubt. Replaced by the mutation that reaches the oracle: **the recording is given no
  fix beyond the browser's initial position → the review reports a distance of exactly `0.00 km`
  and the stored track holds exactly one point**, both red. Recorded here because the first attempt
  at *that* replacement was invalid too — cutting the scenario's fix list to a single entry still
  leaves two positions, since `test.use({ geolocation })` supplies one before the loop runs, and it
  survived. A mutant that never mutated is indistinguishable from a blind oracle, and the
  distinction is the whole value of the list;
- the photo dropped between the composer and storage → the review renders no image, distinguishably
  from an event that was never written at all;
- an event written by the example but never stored → the scenario's storage read fails;
- a code block added **to the quick-start section** that no source backs → the gate fails rather
  than accepting an unchecked block. A block added elsewhere in `api.md` is untouched by it: those
  are declarations, not mirrors, and a gate that claimed them would be asserting the contract
  restates an example rather than the other way round;
- the configured map source removed from the example → the named-colour oracle goes to zero. If it
  does not, the map is drawing from something the reader was never given;
- a Done record added to or removed from `tasks.md` without the README's generated status block
  being reprojected → the drift gate fails, in both directions, exactly as it does for the example's
  snippets. This is the bounded form of "the README cannot go stale": it holds the projection, and
  the projection is the only place status is asserted.
