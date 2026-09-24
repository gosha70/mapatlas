# T8.3 — the `/lab` retirement audit

> Bars set 2026-09-23, **before any candidate implementation**, against `main` at `c0587a2` (the
> merge of PR #65, which closed T8.2). Every survey finding below was read out of the code at that
> commit and is cited by file and line; the load-bearing ones were re-read by hand after a
> delegated sweep produced them, and nothing is repeated forward from `tasks.md` or `CONTINUE.md`
> without having been checked against the code first.
>
> **Status: proposed; revised 2026-09-23 through three review rounds (every finding confirmed
> against the code before being acted on) and rulings A, B and F1 recorded below. No open
> rulings. No implementation is authorised by this document.**

## The originating goal, restated

`tasks.md` T8.3, in full: each lab-owned browser assertion is either **mapped to an equivalent
root-app oracle** — named, one to one — or **deliberately retired** with the reason recorded;
`/lab` is removed only once no assertion depends on it; the equivalence is shown by the mapping
rather than by the suite staying green, since deleting a scenario also leaves it green; and an
assertion that cannot be expressed against the root app is **a finding about the app's
observability, reported rather than resolved by keeping `/lab` indefinitely**.

So the deliverable is a **mapping**, assertion by assertion, and the removal follows from it. The
mapping is the artifact; green is not.

## What is settled — cite, do not re-open

1. **The root app supersedes `/lab` as the product demonstration** (`tasks.md` T7.1, T7.1b;
   `CONTINUE.md` "`/lab` is still an evidence fixture"). What made retirement thinkable is done.
2. **`/lab` is T4.6's fixture and the subject of five merged browser scenarios, and T6.1's offline
   evidence runs through it** (`apps/demo/src/main.ts:99-101`; `tasks.md` T4.6 and T6.1 Done
   records). The five are `lab`, `lab-a11y`, `render-differential`, `offline-region` and
   `performance-baseline` — inferred from which files navigate to `/lab` as their subject; no
   record names them, so the inference is stated as one.
3. **Two checks of the draft-vertex accessibility contract are kept on purpose** (`tasks.md`
   T4.7): the harness proves the engine in isolation, `/lab` proves *the shipped composition* did
   not break it. Retiring `/lab` must not quietly collapse that to one.
4. **The harness (`e2e/harness`) is automation-only** and hosts the renderer's own proofs
   (`map-controller.e2e.ts`, 27 tests). It is a legitimate home for a *renderer* property that
   has no business in a product route.
5. **T8.1's probe workflow and instrument are kept** (owner's ruling, 2026-09-22). Nothing here
   touches `scripts/fixture/`, the archives `fixture:build` cuts, or the probe.

## Survey — what the repository has, at `c0587a2`

**The route.** `/lab` is a path branch in the demo entry point, `main.ts:43`; no router, no hash.
It publishes no window global (verified: none in `apps/demo/src/lab/*.ts` or `main.ts`); its whole
observability surface is `#status`'s dataset and `#map`. It replaces `navigator.geolocation` with
a replay of the fixture and drives the **real recorder** through it (`lab.ts:325-352`), renders
the recorder's output, uses a blank style with no basemap, and is assembled from package entry
points only. It takes eight query-string knobs the root app does not have — `terrain`, `contours`,
`hillshade=off`, `marks=off`, `draw=on`, `segments=both|one|two|bridge`, `focus=track|pause`,
`offline=off|download|use|delete` (`lab.ts:141-193`, `offline-region.ts:34-43`).

**The root app**, for comparison, reads `?terrain=`, `?contours=` and `?basemap=`
(`apps/demo/src/app/sources.ts:45-47`), has a real authoring map with a three-point draft
(`e2e/fixtures/demo-flow.ts:98-109`, `#authoring-map`, `#authoring-status[data-points]`), exposes
`#shell-status`, `#offline-status[data-stored]`, `#app-map`, registers a service worker that
**refuses `/lab`** (`main.ts:110-115`, `scripts/generate-service-worker.mjs:195`), and **renders a
live link to `/lab`** in its shell (`apps/demo/src/app/app.tsx:182`, styled by
`index.html:152`).

**Eight scenario files load `/lab`.** Five as their subject (10 tests, one of which —
`render-differential.e2e.ts:104` — is pure and never navigates); three to assert something
*negative about `/lab`*: that the root shell never reaches it (`app-shell.e2e.ts:257`), that the
worker leaves it to the network (`app-shell-offline.e2e.ts:201`), and that the persistence control
never touches it (`persistence.e2e.ts:189`). No shared helper opens `/lab`; each file has its own.

**The string `/lab` occurs in 34 tracked files under `apps`, `e2e` and `scripts`**
(`git grep -l '/lab' c0587a2 -- apps e2e scripts | wc -l`). They are: **8** in
`apps/demo/src/lab/` itself (the four modules and four of the five unit suites; see "The lab's
unit suites" below); the **8** scenario files above; and **18** others — the route in `main.ts`;
the live link `app.tsx:182`; the worker refusal `generate-service-worker.mjs:195`; the shared
fixture helper `e2e/fixtures/rendered.ts:101` (`mapOf`, "the element `/lab` draws into", whose
remaining users after removal are none); and **prose only** in the other fourteen — doc comments
in `apps/demo/index.html`, `tsconfig.json`, `vite.config.ts`, `src/attribution.ts`,
`src/app/sources.ts`, `src/app/sources.test.ts`, `e2e/app-loop.e2e.ts:31`,
`e2e/app-shell.e2e.ts:42`, `e2e/rendered-oracle.e2e.ts:9`, `e2e/fixtures/build-lab-archives.mjs`,
`e2e/fixtures/serve-lab-archives.mjs`, and four in `scripts/fixture/*`. The fence below says
which of these are in scope; the bar counts executable references, not prose.

**The lab's unit suites.** `apps/demo/src/lab/` holds five Vitest suites, **42 tests and one
todo**. Who imports its modules (grep over `apps/demo/src`, `e2e`, `scripts`): `lab.ts` and
`offline-region.ts` are imported only by the route entry point being removed
(`main.ts:34-35`); `fixture-track.ts`, `simulated-geolocation.ts`, `replay-through-recorder`
and `lab-sources` have no consumer outside the directory:

| Suite | Tests | What it holds |
|---|---|---|
| `fixture-track.test.ts` | 16 + 1 todo | the generator: determinism (`:12`, `:20`, todo `:27`), engine geometry validation (`:42`, `:48`), the 5,000-point ask (`:58`), the two-segment pause (`:68`, `:73`, `:83`), archive-region containment (`:112`, `:121`, `:132`), mark placement (`:152`, `:160`, `:170`), pace and timing (`:179`, `:195`) |
| `simulated-geolocation.test.ts` | 13 | the `navigator.geolocation` replay: ordering, exhaustion, the pause, epoch anchoring, watch lifecycle |
| `replay-through-recorder.test.ts` | 6 | the replay driven through the real recorder: every fix kept, two segments, start time, geometry unchanged, the pause a gap in space |
| `offline-region.test.ts` | 6 | the `?offline=` knob's parser and its no-store mode |
| `lab-sources.test.ts` | 1 | the lab's own copy of the archive attribution |

Deleting the directory deletes all 42 behind a green `verify`; the removal section names each
suite's disposition so none disappears unrecorded. The same deletion shrinks the unit suite the
parked T8.1 probe measured (95 files at 2c/2d) by five files; the instrument is untouched and
its records describe the suite as it was, so nothing is edited, and the Done record notes it.

## The mapping — every lab-owned assertion, and its disposition

**Two dispositions exist, and every row has exactly one.** A row is one assertion; a lab test that
asserts several things is split into as many rows.

- **MAP** — the assertion is held against the root app, one to one, by a named oracle. Two
  sub-cases, marked in the table: *existing* — the root-app oracle is already in the suite; or
  *new* — it is written against the root app's **existing** surface in increment 1, and **the new
  test is shown to fail on the same mutation the original fails on** before the original goes.
  "Existing surface" is the fence: no new query-string parameter, no new DOM contract in
  `apps/demo/src/app/`. **One exception, found in increment 1 and recorded here rather than
  deferred (amended 2026-09-23):** where the original turns out to be unfalsifiable as written
  — its named mutation leaves it green — the pairing cannot be shown, and the replacement is
  instead falsified on its own, with the original's blindness recorded as a finding about the
  lab suite. Row 3 is that case.
- **RETIRE** — the assertion is not carried forward against the root app. The reason is recorded
  here and in the Done record. Where the reason is "the root app cannot express it", that is
  recorded as an **observability finding**, as the task requires — not resolved by keeping `/lab`.

| # | Lab assertion (file:line) | Disposition | Oracle or reason |
|---|---|---|---|
| 1 | `lab.e2e.ts:221` — the map settles, and what settled is the archives on screen | **MAP** (existing) | `app-shell.e2e.ts:208` "the map reads both archives past their headers, and paints what it read": a range read past byte 0 per archive, plus a non-background fraction with a negative control. Stronger than the original. |
| 2 | `lab.e2e.ts:221` — per-source attribution: removing either archive changes the screen (4-way differential: both / terrain-only / contours-only / bare) | **MAP** (new) | The root app reads `?terrain=` and `?contours=` (`sources.ts:45-47`) and has a settle-and-capture path (`app-shell.e2e.ts:208`), so the same four loads and the same three inequalities are written against `/` without a new knob. |
| 3 | `lab.e2e.ts:267` — the MapLibre worker asset is served with 200, not fallen back on | **MAP** (new; original unfalsifiable) | `maplibre-gl-worker` appears in no other scenario. The root app loads the same worker (`main.ts:25-38` sets the URL for both branches). **Measured in increment 1: the original stays green under its own falsifier.** Its oracle matches any response whose URL contains `maplibre-gl-worker` and asks for 200 — Vite's `?worker&url` export module satisfies that on its own, and the dev server answers 200 for a `?worker_file` path that does not exist. The replacement in `app-shell.e2e.ts` observes the `Worker` the page created, its script's own response, and `registerWorkerSource` inside it; under the same mutation the worker terminates and the test is red. Falsified on its own; the original's blindness goes in the Done record. |
| 4 | `lab.e2e.ts:278` — both archives are read, each by range request | **MAP** (existing) | `app-shell.e2e.ts:208` and `app-offline.e2e.ts:214` "every declared archive contributes…" classify reads per archive into full / header / beyond-header. |
| 5 | `lab.e2e.ts:292` — no HTTP request leaves the fixture's own servers; the guard is falsified by a prefix-sharing decoy origin | **MAP** (new) | No root-app scenario asserts zero egress; `app-offline.e2e.ts:85-92` routes only the archive URLs. This is `SECURITY.md`'s and `CLAUDE.md`'s guardrail and matters *more* against the shipped app. Written in `app-shell.e2e.ts`, decoy included. |
| 6 | `lab.e2e.ts:292` — no WebSocket leaves the fixture's own servers; the guard is falsified by a decoy socket | **MAP** (new) | `routeWebSocket` exists in no root-app scenario. Same test as row 5, second guard, second decoy. |
| 7 | `render-differential.e2e.ts:133` — the shipped `/lab` composition draws a two-segment track as the union of its segments, with no ink across the pause (bridged control) | **RETIRE — observability finding** (approved 2026-09-23, with F1's narrowed wording) | The four recordings the oracle compares *can* be produced through the root app's own surface — `#record-pause`/`#record-resume` (`loop.tsx:287,297`) and Playwright geolocation (`demo-flow.ts:53`) — so "the app cannot be asked for a paused track" is **not** the limitation. The limitation is the camera: the oracle needs four captures of a *finished* track at one fixed, selection-independent framing near z17 (`lab.ts:108-125`, `:384-395`), and no root-app map offers a declared close camera — see F1. The **renderer** property is preserved on the harness; that preservation is not this row's disposition. |
| 8 | `render-differential.e2e.ts:195` — the shipped `/lab` composition's hillshade layer puts pixels on the map with its DEM source held fixed | **RETIRE — observability finding** | Requires `hillshade=off`, a knob that drops one layer while keeping source and terrain. Same shape as row 7: finding F2; renderer property preserved on the harness. |
| 9 | `offline-region.e2e.ts:246` — a downloaded region renders with the archive host cut, and a deleted one does not | **MAP** (existing) | `app-offline.e2e.ts:129` "a downloaded region draws with the archive host cut, and a deleted one does not": three archives instead of two, real clicks instead of a URL step, a named-colour oracle instead of image inequality. The record names the oracle, not the title. |
| 10 | `offline-region.e2e.ts:246` — `#status[data-regionSources]` names both source ids | **RETIRE** | The region manifest's contents are `@mapatlas/offline-pmtiles`'s unit tests' to hold. No root counterpart, and none wanted: a DOM copy of a manifest is not an observability need. |
| 11 | `offline-region.e2e.ts:246` — `#status[data-served]` lists the URLs served from local bytes | **RETIRE** | "Served from local bytes" is what the archive-host cut *proves*; row 9's oracle observes the same fact from outside. Root publishes `data-stored`, which is the consumer-facing half. |
| 12 | `performance-baseline.e2e.ts:163` — with the full stack over a 5,400-point recording on `/lab`'s blank style, more than 60 frame samples arrive (`:238`), more than 20% of pixels move (`:239`), and a heap figure is read before and after (`:301`); the numbers are recorded | **RETIRE** (ruled B, 2026-09-23) | It sets **no regression threshold** — the three assertions are liveness guards on the measurement, not bounds on it — and nothing consumes the numbers it records (issue #30's warning about runs nobody reads). Moving it would swap its workload for the root app's basemap-plus-draft workload, which is a **new** baseline, not this one moved. The last baseline taken on the fixture is dated in the Done record. |
| 13 | `lab-a11y.e2e.ts:41` — the shipped composition keeps draft vertices reachable, named and visibly focused (one tab stop; a name per vertex; focus through the real tab order; a computed ring) | **MAP** (new) | Settled item 3: the shipped composition is now the root app. Its real draft (`demo-flow.ts:98-109`) renders the same `.mapatlas-draft-vertex` DOM, so the same four assertions are written against `#authoring-map`, with the same two falsifiers. |
| 14 | `app-shell.e2e.ts:257` — the root shell never reaches the fixture route | **RETIRE** | A claim about `/lab`'s separateness. With no `/lab`, there is no fixture route to reach. |
| 15 | `app-shell-offline.e2e.ts:201` — the worker leaves `/lab` to the network (`:230-233`) | **RETIRE** | Goes with the route and with the worker's refusal (`generate-service-worker.mjs:195`). `:212` says it: without the abort, `/lab` "would simply load" — after removal it 404s and the assertion changes meaning silently, so it is retired explicitly rather than left to drift. |
| 16 | `persistence.e2e.ts:189` — the fixture route is untouched by the persistence control | **RETIRE** | Same as 14. The obligation it discharged (`tasks.md:1116-1117`, T6.2: "`apps/demo/src/lab/` untouched") was about not changing the fixture while it was evidence; once the fixture is gone by decision it is met by construction. |

**Retained support, not lab-owned — listed so the removal can name what stays:**

- `render-differential.e2e.ts:104` "track ink is recognised by its hue" — pure; pins
  `trackMask` (`e2e/fixtures/pixels.ts`) on known colours; never navigates. **Stays in place,
  unchanged.** It is the predicate the harness proofs will use, so it is support for them.
- `app-shell-offline.e2e.ts:201`'s other half — the worker answers `/` from the precache
  (`:206-210`). Not a lab assertion; **stays**, and the test's title and comment lose their
  `/lab` half when row 15 is retired.

### Observability findings (the task's named output)

- **F1 — the root app has no declared, close, selection-independent camera on a map that draws
  a completed track.** (Revised 2026-09-23; the first draft's premise — that a paused recording
  cannot be produced — was false and is withdrawn. The review map *does* have a fixed,
  selection-independent camera, the controller's default world view; what it lacks is a declared
  one close enough to the pause for a bridge to leave ink.) Verified, at `c0587a2`:
  1. *Producing the four tracks is possible.* Pause and resume are buttons (`loop.tsx:287`,
     `:297`); the recorder opens a new segment on resume (`recorder.test.ts:325` "a pause is a
     gap"); Playwright sets each fix (`demo-flow.ts:53`). Both / one / two / bridged are four
     recordings, each a scripted sequence of fixes and button presses.
  2. *The live map draws no track.* While recording, `#app-map`'s `MapCanvas` receives
     `livePoint` and no `track` (`loop.tsx:343-351`); `renderTrack` is never called with the
     recording. It does have a fixed camera — `DEMO_CAMERA`, z12 (`sources.ts:83-88`) — but z12
     is the whole-track zoom at which the lab **measured** a bridge across the 94.6 m pause
     leaving zero ink of its own (`lab.ts:111-115`); the oracle needs ~z17 (`PAUSE_FOCUS_ZOOM`).
  3. *The review map draws the track with no camera at all.* After `stop()`, the track is
     rendered by `TripReview` in `#app-review` (`loop.tsx:364-372`), whose props carry no
     camera (`trip-review.ts:28-38`) and whose `mapProps` passes none to `MapCanvas`
     (`:150-159`); `MapCanvas` fits nothing, and `renderTrack` moves nothing
     (`controller.ts:864-876`). The review map therefore mounts at the controller's default —
     the world view `loop.tsx:339-342` describes (read from the code, not observed in a browser;
     if a review in fact shows the track framed, something this survey did not find frames it,
     and F1 narrows further) — and `MapController` publishes no map handle (`rendered.ts:8`)
     through which a test could frame it.
  So the missing **control** is a declared, close (~z17), selection-independent camera near the
  pause on a map that draws a completed track. A fit-to-track on the review map would be a product improvement but would
  not supply it: fitting each of the four tracks gives each capture its own camera, which is the
  one thing the differential forbids (`lab.ts:384-387`). Driving the camera by wheel or keyboard
  gestures from the world view was considered and not pursued: it would make the framing a
  property of a gesture sequence rather than a declared camera, and any drift would be
  indistinguishable from geometry. Reported; not resolved by keeping `/lab`.
- **F2 — layer composition is not observable in the root app.** The root app has no way to drop
  one layer (hillshade) while keeping its source and terrain, so "the hillshade layer contributes
  pixels in the shipped stack" is provable only at the renderer level. Reported (approved
  2026-09-23).

Both are findings about the *shipped composition*, not about the renderer: `MapController`'s own
proofs cover the renderer, and the app's own scenarios cover that the archives are read and
painted (rows 1, 4). What no test can currently say is that the *app's* layer stack, as assembled
by `apps/demo/src/app/`, keeps those two properties. That gap is recorded, with the option
(not taken here) of a future root-app oracle that reads the assembled style — a product decision.
F1 carries a second, product-facing observation for the owner: the review map's camera is the
default world view, which is a display question outside this task and is recorded, not acted on.

### Preserved renderer proofs (ruled A, 2026-09-23)

Rows 7 and 8's **renderer** properties are kept, on the harness, as `map-controller.e2e.ts`
tests: a segmented track draws no ink in the gap (set relation, with a bridged control), and the
hillshade layer changes pixels with its DEM source held fixed. The harness already takes
programmatic tracks. Each harness test is shown red under the original's falsifier while the
original still runs. **This is preservation of a renderer proof, not a mapping**: the lab rows'
disposition is RETIRE.

**The generator moves with its tests.** `apps/demo/src/lab/fixture-track.ts` moves to
`e2e/fixtures/fixture-track.ts`, where the harness's data lives. Its suite does not vanish with
the directory: Vitest excludes `e2e/**` (`vitest.config.ts:91`), and the repository's precedent
for checking a fixture declaration in `e2e/fixtures/` is a Playwright spec that never opens a
browser (`structure-oracle.e2e.ts` over `track-shape.ts`; the hue test), so the tests move to
`e2e/fixture-track.e2e.ts` as `test(...)` with the same titles. **Twelve move**: determinism
(`:12`, `:20`), geometry validation (`:42`, `:48`), the two-segment pause (`:68`, `:73`, `:83`),
region containment (`:112`, `:121`, `:132`), pace and timing (`:179`, `:195`) — every property
the harness proofs and the archive framing rely on. **Five are retired**, each with its
consumer: `:58` "at least the 5,000 raw points T4.6 asks for" was the baseline's workload
requirement and goes with row 12 (the generator's point count is not changed, since changing
the geometry would change the moved proof's ink; the *ask* is what retires); `:152`, `:160`,
`:170` test `generateFixtureEvents` (`fixture-track.ts:280`), a separate export from the track
geometry whose only consumer is the lab route (`lab.ts:354`) — **the function and its three
tests retire together**, and `generateFixtureTrack` is untouched; the todo at `:27`
("byte-identical in a browser — pending the offline scenario serialising the browser's own
track") waited on a lab scenario that row 9 retires, and the harness proofs generate the track
in Node and hand it to the browser, so no second runtime ever generates it — **retired, not
carried as a `fixme`** (Playwright has no `todo`; a `fixme` would register a skipped test).
`FIXTURE_REGION` moves with the generator.

## Owner rulings, recorded

- **A (2026-09-23): approved** — preserving the renderer proofs on the harness, and retiring
  row 8 with F2. **Row 7's retirement with F1 approved 2026-09-23** once the actual root-app
  limitation was established: there is no usable selection-independent close camera for the
  four-way differential. F1's headline carries that narrower wording, and so must the Done record.
- **B (2026-09-23): retire the performance baseline** (row 12). Nothing consumes its numbers, it
  sets no regression threshold, and moving it would change the measured workload.

## Scope fence

In: the mapping above, executed row by row; the new root-app oracles (rows 2, 3, 5, 6, 13) and
the harness proofs, each with its falsifiers re-shown; the fixture track relocated **with its
suite** (twelve tests to `e2e/fixture-track.e2e.ts`; four tests and the todo retired, named
above; `generateFixtureEvents` deleted);
`apps/demo/src/lab/` removed, with its other four unit suites **deleted by name**:
`simulated-geolocation.test.ts` (13) and `replay-through-recorder.test.ts` (6) test the replay
mechanism, which goes with the route — the recorder's pause semantics they exercise are held by
`packages/recorder-web/src/recorder.test.ts:325-375` ("opens a new segment on resume, so a
pause is a gap", and four more); `offline-region.test.ts` (6) tests the `?offline=` knob's
parser, which goes with the knob; `lab-sources.test.ts` (1) tests the lab's copy of the
attribution, and the root app's copy has its own (`sources.test.ts:74`); the `/lab` branch of
`main.ts` and its imports; the live link
`app.tsx:181-183` and its style rule `index.html:152`; the worker's `/lab` refusal; the scenario
files `lab`, `lab-a11y`, `offline-region`, `performance-baseline` deleted whole and
`render-differential` reduced to the hue test; the three negative assertions (rows 14–16); the
`mapOf` helper in `rendered.ts` (dead after removal — deleted, or re-documented if a harness
proof adopts it); **the `/lab` prose in every file the fence touches** (`main.ts`,
`app-shell.e2e.ts:42`, `app-shell-offline.e2e.ts`, `rendered.ts:101`); `tasks.md` Done record
with the mapping; `CONTINUE.md`; `README.md` reprojected.

Out: any new product affordance in the root app (no `segments=`, no `hillshade=`, no `draw=`
knob, no new DOM contract); `scripts/fixture/` and the archives (`fixture:build` stays — the root
app's scenarios use them; its four `/lab` comments are stale prose and are **listed in the Done
record as such, not edited**, because that directory is T8.1's instrument and the owner's ruling
keeps it untouched); `e2e/fixtures/build-lab-archives.mjs` and `serve-lab-archives.mjs`, which
serve both routes and are misnamed rather than lab-owned — renaming is cosmetic and not this
task, but their `/lab` prose is corrected since the files are already read by the root scenarios;
the remaining stale comments in `index.html:22,95`, `tsconfig.json:6`, `vite.config.ts:11`,
`attribution.ts`, `sources.ts`, `sources.test.ts`, `app-loop.e2e.ts:31`,
`rendered-oracle.e2e.ts:9` — **corrected in increment 2 as one-line comment edits** where the
sentence becomes false without `/lab`, and left where it is a historical statement ("`/lab`
needed the same rule"); the Done record lists each.

## Increments, and the argument for this order

**Increment 1 — the new oracles, with `/lab` still present.** Write rows 2, 3, 5, 6 and 13
against the root app, and the two harness proofs, **while the originals still run**. For each:
the original's named falsifier is applied and both the original and the new test go red — with
row 3 as the recorded exception, where the original stayed green under its own falsifier and the
new test was shown red alone. This is the only moment both can be compared, and it is what
"shown by the mapping rather than by the suite staying green" means in practice. Nothing is deleted and nothing moves: the harness proofs
import the generator from `apps/demo/src/lab/fixture-track.ts` for this one increment, so the
lab and the harness are demonstrably drawing the same track when both go red.

**Increment 2 — the removal.** Delete the four lab scenario files and the two lab tests in
`render-differential.e2e.ts`; the three negative assertions (rows 14–16, reasons in the commit);
`apps/demo/src/lab/` — the generator and its twelve tests moving to `e2e/` in this same commit
(the harness proofs' import rewritten to `./fixtures/fixture-track.js`), the four retired tests, the todo and `generateFixtureEvents`
and the other four suites deleted by name; the `main.ts` branch and imports; the live link and
its style rule; the worker refusal; `mapOf`. The in-scope prose is corrected.

**Increment 3 — close-out.** `tasks.md` Done record carrying the mapping table, F1/F2, the
retained-support list and the stale-prose list; `CONTINUE.md`'s "`/lab` is still an evidence
fixture" paragraph and its Phase 8 bullet; `README.md` reprojected.

## Bars

- `npm run verify` and `npm run test:browser` exit 0 at the end of every increment.
- After increment 1, for every MAP (new) row and both harness proofs: the original and the new
  test are **both red** under the original's falsifier, recorded in the handoff by test title —
  **except row 3**, whose original is unfalsifiable as written (measured; see the row); there the
  new test alone is red, and the handoff says so by title.
- After increment 2: **no executable reference to `/lab` remains** — `grep -rn "/lab" apps/demo/src e2e scripts`
  with comment lines (`//`, `*`, `<!--`) excluded finds nothing; a scenario that navigates to
  `/lab` fails on a 404. Prose is governed by the fence's list, not by the grep.
- After increment 2: the browser suite's test count is stated as numbers. At `c0587a2` the grep
  `^test(` over `e2e/*.e2e.ts` counts 116. Expected after: 116 − 9 deleted lab tests (the 10
  lab-subject tests minus the hue test) − 2 deleted negative tests (rows 14, 16; row 15's test
  is reduced, not deleted) + 4 new root-app tests (row 2; row 3; rows 5 and 6 as one test with
  two guards, as the original is; row 13) + 2 harness tests + 12 moved generator tests =
  **123 discovered, 0 skipped** (no `fixme`, no `skip`), confirmed against the runner's own
  count in the handoff. The unit suite: 42 lab tests and one todo leave Vitest, none of them
  re-homed there — the twelve that survive are counted in the browser lane above.
- The root app's own scenarios (`app-*.e2e.ts`, `quick-start.e2e.ts`) are byte-identical to
  `c0587a2` except where a row above adds an assertion to them or the fence corrects prose.
- No new query-string parameter and no new DOM contract in `apps/demo/src/app/`; the live link's
  removal is the only change to `app.tsx`.

## What will be got wrong

- **Deleting first and mapping afterwards.** The suite stays green either way; the mapping is
  only checkable while both tests exist. Increment 1 is before increment 2 for this reason alone.
- **Mapping to a title, not to an oracle.** Row 9's titles are near-identical; the *oracles*
  differ (image inequality vs named colour). The record names the oracle.
- **Letting the a11y check collapse to one.** Row 13 is the shipped-composition check; moving it
  is not the same as noting that the harness already has one.
- **Calling the harness proofs a mapping.** They are not; rows 7 and 8 are retired with a
  finding. A Done record that says "moved to the harness" would hide F1 and F2, which are the
  task's named output.
- **Growing the root app to carry a fixture's knobs.** The fence forbids it; ruling A exists so
  the temptation has a named answer.
- **Leaving the live link.** `app.tsx:182` would 404 for every visitor after increment 2; it is
  in scope by name so it cannot be missed.
- **Calling the baseline "finiteness only".** It asserts three liveness guards; what it lacks is
  a threshold. The Done record says the narrower, true thing.
- **Stating a limitation the app does not have.** F1's first draft said the app cannot be asked
  for a paused recording; it can. A finding is only worth reporting if it names the observation
  that is actually missing, so each finding cites the surface it checked and where it stops.
- **Letting `verify` swallow the unit suites.** Deleting `apps/demo/src/lab/` takes 42 tests
  with it and the gate stays green. Each suite's disposition is written down before the delete.

## Required mutations

Each must turn a named assertion red, in the new test, and in the original while it exists —
except row 3, where the original was measured green under its mutation and only the new test is
required red:

- **row 2:** the terrain archive URL dropped from the root app's query → "both differs from
  contours-only" fails;
- **row 3:** the worker URL pointed at a non-existent asset → in the new test, the worker
  terminates and "the worker that runs is not MapLibre's" fails; **the original stays green under
  this mutation** (its 200 is satisfied by Vite's export module and by the dev server's answer for
  a missing worker path), which is the finding recorded in row 3;
- **row 5:** the HTTP decoy origin not landing in the egress list → the guard's falsification
  fails; one real request let through → zero-egress fails;
- **row 6:** the WebSocket decoy not landing in the egress list → its falsification fails;
- **row 13:** every draft vertex taken out of the tab order; the focus ring removed → each fails,
  against `#authoring-map`;
- **harness proof (row 7's property):** a bridged track passed as the two-segment one →
  `both ∩ corridor === 0` fails;
- **harness proof (row 8's property):** the hillshade layer left in the "off" stack → the
  changed-fraction assertion fails;
- **the removal itself:** a scenario that still navigates to `/lab` after increment 2 → fails on
  a 404, which is the assertion that the retired route is retired.
