# T8.1 — the fixture-build flake

> Bars set 2026-09-12, **before any candidate fix**, against `main` at `5f0c05d` (the merge of
> PR #46). Every survey finding below was read out of the code, the issue or the CI logs at that
> commit and is cited; nothing is repeated forward from a plan or a conversation.
>
> **Amended 2026-09-12 (after increment 1), in increment 2's sequencing only.** The plan had 2a
> measure the runner's worker count "from a CI run" and placed the `workflow_dispatch` workflow in
> 2b, which cannot both be true: nothing in this repository prints that number, so the only vehicle
> for the measurement *is* that workflow. The workflow therefore lands **first**, and a **minimal
> first dispatch** measures the environment before any loop is run.
>
> **This is a correction to the experiment's execution order and not to its acceptance criterion.**
> Nothing about the bars, the budgets, the α split or the stop-without-fix rule changes. In
> particular the workflow landing early is **not** a statement that local reproduction has been
> tried and failed — 2a has not run — and the CI *loop* is still reached only if 2a comes back
> null.

## What is settled — cite, do not re-open

1. **The acceptance criterion puts reproduction before repair.** `tasks.md` T8.1: *"the cause is
   identified and the failure is made **reproducible on demand** before it is fixed; the fix is
   falsified by a mutation that reproduces the original signature."* And the reason it is written
   that way: *"a change that merely stops the failure being observed does not discharge this — an
   intermittent test that has gone quiet is indistinguishable from one that was fixed."*
2. **Issue #30 is the record, and it is not to be re-derived.** Four occurrences, byte-identical
   signature — `9c05be6` (PR #28), `fcd5194` (PR #31), `d8410f0` (PR #42), `65548da` (`main`) —
   each green on a re-run with no code change. It already holds the arithmetic and three
   eliminations. `CONTINUE.md`'s standing convention says to add to it rather than investigate
   afresh; this plan is bound by that too.
3. **Already eliminated, per #30 and its comments.** `readCrops` double-pushing (an async
   generator cannot be iterated twice); the `cropFor` epsilon landing on a knife edge (both
   boundaries are exact lattice integers — `7.0 × 3600 = 25200.0` divides exactly, so
   `Math.ceil(v / SPACING - 1e-6)` is 25200 whether the input is nudged up or down by an ULP);
   and test-order dependence inside the file (fifteen `--sequence.shuffle` runs).
4. **What the numbers pin down**, also recorded: the crops are 46×113 (`N45E006`) and 35×113
   (`N45E007`) and should sit side by side. `3955 = 35 × 113` is exactly the second crop's whole
   area, with **zero gaps** over a union that is exactly the first crop's extent — so the second
   crop is landing **entirely inside** the first. Not an edge row, not a fencepost.

## Survey — what the repository has, at `5f0c05d`

- **Three environmental differences separate this machine from the only environment the failure
  has been seen in. Two can be controlled locally; one cannot.**
  - **Runtime.** All four failing attempts ran **Node v24.20.0** — read from the failing jobs
    themselves (`101623544088`, `101836912841`, `102914705412`, `103394159278`), not from a later
    green run. This machine is **v24.11.1**. Issue #30 records the gap as a fact and never follows
    it.
  - **Parallelism.** Vitest 4.1.11 gives a non-watch run `Math.max(availableParallelism() - 1, 1)`
    workers (`resolveMaxWorkers`, `node_modules/vitest/dist/chunks/cli-api.CnMVyzaz.js:3832`). This
    machine reports `availableParallelism() === 14`, so **13 workers**. **The runner's
    `availableParallelism()` is not recorded in any log this repository has** — the job log states
    the image (`ubuntu-24.04`), the runner version and the Azure region, and never the core count.
    So the CI worker count is *unknown*, not four-minus-one, and increment 2 measures it before
    matching it.
  - **Platform.** Every failure was on **`ubuntu-24.04`, x64**; this machine is macOS on arm64.
    That one cannot be controlled locally at all.

  So a local attempt controls the runtime and the worker count and **does not reproduce the
  environment** — it removes two known variables and leaves the platform standing. That is worth
  doing because it is cheap and because nothing has removed even one of them yet, but it is not the
  same claim as "run it where it fails", and a null result from it bounds less than a null result
  from CI would.
- **Nothing in the fixture pipeline holds module-level mutable state.** `scripts/fixture/*.mjs`
  declares no top-level `let`, no `Map`/`Set`/array cache. `runBuild`'s `crops` is a `const` array
  created per call (`build.mjs:220`) and `readCrops` is its only writer (`build.mjs:704`).
- **The build harness fakes every write, so parallel test files cannot collide on disk.**
  `build.test.mjs`'s `deps` supply `writeArchive`, `finaliseArchive`, `discardArchive` and
  `io.readFileSync` as fakes, and `PATHS` names relative paths that nothing resolves. **This
  eliminates a hypothesis that has not been recorded yet**: that two test files running
  concurrently in one working directory were colliding on `out.pmtiles`. They are not; no test in
  that file touches the filesystem at all.
- **`vitest.config.ts` sets no pool, isolation, worker or sequence options** — everything is at its
  default, so the scheduling that differs between the two machines is entirely vitest's own.
- **The failure describes its symptom and not its cause.** `SurfaceError` reports gaps, overlaps
  and the union's dimensions (`surface.mjs:106`) and says nothing about *which* crops were placed
  *where*. Four occurrences have therefore produced four copies of the same sentence, and the
  arithmetic above had to be reconstructed by hand each time. Every crop's `west`, `north`,
  `width`, `height` and computed `col`/`row` is in scope at the throw.
- **The suspect may be the harness rather than the pipeline.** `cropFor` in `build.test.mjs:73`
  computes cell windows itself, from `productionEnvelope` and `clipBoundsToTile`. A defect there
  is a flaky *test*; a defect in `stitchSurface` or `readCrops` is a flaky *builder* that ships.
  Nothing observed so far distinguishes them, and the two have different fixes and different
  severities.

## The bar this task turns on

**A rare failure that is only ever observed is not evidence anybody can act on.** The honest
response to each of the four occurrences has been "re-run and see", which #30 itself names as the
habit that lets a real failure through. Ending that is the deliverable; a green suite is not.

So *"reproducible on demand"* is given a meaning here, before anything is attempted, because it is
the word the acceptance criterion turns on and it is the word most easily satisfied by wishful
reading:

> **A command in this repository that produces the exact signature — `0 sample(s) covered by none
> and 3955 by more than one, over 46x113` — at a rate measured against a budget fixed before the
> attempt begins.**

**The budget and the stopping rule are declared here, now, because a probabilistic bar chosen after
seeing the result is not a bar.** "High enough" and "enough runs" are selectable afterwards in
whichever direction the author already believes; zero failures then becomes "fixed" by picking a
convenient count. So the numbers are fixed in advance and the false-negative probability is named:

- **A total α = 0.05 for declaring the fix good, and it is *split* rather than spent twice.**
  Accepting a fix wrongly can happen two ways — the lower bound on the rate is itself wrong, or the
  rate is real and `M` runs miss it by luck — so charging each stage 5% would put the combined
  ceiling at `0.05 + 0.95 × 0.05 = 9.75%`, not 5%, while the plan said 5%. Each stage therefore
  gets **α = 0.025**: a one-sided **97.5%** lower bound, and `M` derived at 0.025. The combined
  ceiling is `0.025 + 0.975 × 0.025 = 4.94% ≤ 5%`, which is the number this plan is entitled to
  claim. The arithmetic is written out so a reader can check it rather than take it.
- **Discovery budget, 2a (local):** **200 full-suite runs**, or 90 minutes of wall clock, whichever
  comes first. **Discovery budget, 2b (CI):** **100 full-suite runs** in one dispatch.
- **If zero exact-signature failures occur in `n` runs, the attempt has not reproduced**, and the
  result is reported as a bound rather than as an absence: the one-sided **95%** upper bound on the
  per-run rate is `p_max = 1 − 0.05^(1/n)`, which for n = 200 is **1.49%** and for n = 100 is
  **2.95%**. This bound sits **outside** the acceptance chain — it is what is reported when the
  task *stops without a fix* — so it spends none of the α above and is stated at 95% on its own
  terms. Stating it is a finding; "we ran it a lot and it was fine" is not. **No fix follows from a
  null result.**
- **If `f ≥ 1` failures occur in `n` runs**, the per-run rate is `p̂ = f/n`, and the validation
  count is derived from the **lower** bound of a one-sided **97.5%** Clopper–Pearson interval on
  it, `p_lo`, so that a lucky estimate cannot shrink the work:

  > **`M = ceil( ln(0.025) / ln(1 − p_lo) )`** — the number of runs after which, if the true rate
  > were still `p_lo`, seeing zero failures would have probability ≤ 2.5%.

  For scale, since the numbers decide how long this takes: `p_lo` of 4% gives **M = 91**, 2% gives
  **183**, 1% gives **368**. `p_lo` is computed, not eyeballed, and `f`, `n`, `p̂`, `p_lo` and `M`
  are all written into the Done record and onto #30 before the fix is attempted.
- **Validation, both directions, at that `M`:** with the fix **reverted**, at least one
  exact-signature failure within `M` runs — proving the reproduction still reproduces. With the fix
  **applied**, zero failures in `M` runs. Either half alone is worthless: the first without the
  second is a reproduction and no fix, and the second without the first is `M` green runs of
  something that may never have been able to fail. The 4.94% ceiling covers the *applied* half;
  the reverted half is a check on the instrument and is reported as observed rather than as a
  probability.

Three further consequences, each a bar of its own.

- **A rate, not an occurrence.** "It failed once when I ran it in a loop" does not distinguish a
  reproduction from the same luck CI has had four times.
- **The exact signature, not a related failure.** A different overlap, a gap, or a different union
  is a *second* defect and is reported as one. Chasing a nearby failure and declaring victory is
  how a flake survives its own fix.
- **If it cannot be reproduced, that is the finding.** The task reports the bound and precisely what
  was controlled for, adds it to #30, and **stops short of a fix**. A change made without a
  reproduction cannot be falsified, and shipping one would convert an intermittent failure into an
  intermittent failure nobody is looking for any more.

## Scope fence

**In:** making the failure self-describing; controlling the environment it has only ever been seen
in and attempting an on-demand reproduction; and, **only with a reproduction in hand**, the fix and
its falsification.

**Out, on the record:** `test.retry` or any retry, in vitest or in CI · skipping, `todo`-ing or
quarantining the test · widening the assertion, loosening `LATTICE_EPSILON_SAMPLES`, or tolerating
a small overlap · changing `SEAM_REGION`, the fixture bounds or the zoom range to move off whatever
boundary is implicated · any change to `packages/` · rewriting `stitchSurface` for clarity while
looking at it. **Each of those makes the symptom go away and none of them can be falsified**, which
is exactly what the acceptance criterion was written to forbid.

## Increments, and the argument for this order

1. **Make the failure say what happened.** `SurfaceError` reports, for every crop, its `west`,
   `north`, `width`, `height` and its computed `col`/`row`, and names the pairs that overlap.

   **The existing signature line is preserved byte for byte and the diagnostics are appended**,
   never rewritten around: `0 sample(s) covered by none and 3955 by more than one, over 46x113` is
   how four occurrences were matched to each other and to issue #30, and a message that improved it
   would orphan that history and the searches built on it.

   *Observable:* **three crops with exactly one overlapping pair** — the report must name every
   crop's placement, name that pair, and **not attribute the uninvolved crop to it**. Two crops
   would not do: with only one possible pair, a reporter that labelled *every* pair as overlapping
   would pass, which is a test that cannot tell attribution from enumeration.

   **First because it is the only increment that is certain to be worth doing.** It is
   deterministic, it is finished in one sitting, and it pays whether or not reproduction succeeds:
   if it does, this is how the reproduction is read; if it does not, the *fifth* occurrence in CI
   arrives already diagnosed instead of producing a fifth copy of the same sentence. It is also the
   only increment that can be falsified without first solving the problem.

2. **Attempt reproduction — measure the environment, then match it locally, then only if that is
   null, loop in CI.** Three steps, in this order. **2a and 2b are the reproduction attempts and
   each carries a discovery budget, fixed before it starts**; **2.0 runs no loop and has no
   budget**, because a measurement is not an attempt to reproduce anything and giving it a run
   count would blur the very distinction this amendment exists to draw.

   **2.0 — the measurement dispatch.** The `workflow_dispatch`-only workflow lands here, **because
   it is the only vehicle this repository has for reading the runner's environment** and for no
   other reason. Its first invocation is **minimal**: it runs no loop and reports

   - **`os.availableParallelism()`, raw**, as the runner reports it — the number itself, not a
     conclusion drawn from it;
   - the **Node version**, the **Vitest version**, `process.platform` and `process.arch`.

   **The Vitest worker count is labelled `computed`, not observed**, unless the workflow actually
   sees worker identities: `resolveMaxWorkers` returns `Math.max(availableParallelism() - 1, 1)`
   for a non-watch run (`cli-api.CnMVyzaz.js:3833`), and applying that formula is a derivation from
   a version of Vitest that could change under us. A derived number presented as a measured one is
   the kind of claim this plan exists to refuse. If a later step needs it observed, it observes it.

   **2a — local, controlling what can be controlled.** Node **v24.20.0** rather than v24.11.1, and
   `--maxWorkers` set to the count 2.0 reported, explicitly rather than by default. The **whole
   suite**, because every occurrence has been a full-suite run and none has been the file alone.
   Budget as declared above. The platform difference stands and is stated with the result: this
   controls two known variables, it does not reproduce the environment.

   **2b — the CI loop, invoked only if 2a is null.** The *same* workflow, run again for the
   predeclared **100-run** budget. That number was fixed before any of this was attempted and is
   **not chosen after seeing 2a's result** — a budget picked once the outcome is known is the
   selectable bar this plan spent its longest section refusing.

   Throughout, the workflow is **`workflow_dispatch`-only** and **never runs on push or pull
   request**: a loop that fired automatically would multiply the CI cost of every change and become
   a source of red runs nobody reads. At T8.1's close-out it is **removed, or explicitly kept with
   a reason recorded** — not left behind because nobody remembered it.

   *Observable for 2.0:* the runner's environment, reported as facts — raw
   `os.availableParallelism()`, the Node version, the Vitest version, `process.platform` and
   `process.arch` — with the Vitest worker count printed **beside them and labelled `computed`**.
   It produces no signature and no rate, and claiming one for it would be inventing an attempt
   that did not happen.

   *Observable for 2a and 2b:* the exact signature, produced by a named command, with a rate
   measured against that step's predeclared budget. *If neither reproduces*, the increment's output
   is the bound and the eliminations, recorded on #30, and the task reports rather than proceeds.

3. **The fix, falsified by the reproduction.** Only with a rate in hand. *Observable:* the
   reproduction command fails with the fix reverted and passes with it applied, over a run count
   derived from the measured rate. Whether the defect is in `stitchSurface`, in `readCrops` or in
   the test's own `cropFor` is left open here on purpose: the survey cannot distinguish them, and
   naming the culprit in advance is how the wrong thing gets fixed.

## Bars

- **No change is made to the test's subject without a reproduction that fails before it and passes
  after it.** This is the acceptance criterion restated, and it is the bar the other bars serve.
- **The rate is written down, in the Done record and on #30.** "Reproducible" without a number is
  the same claim as "it seems fine now".
- **The diagnostic is not the fix, and is not reported as one.** Increment 1 makes the next
  occurrence legible. If the task ends there, it ends there explicitly and T8.1 stays open.
- **Nothing under `packages/` changes.** This is fixture and test tooling; if a fix required engine
  code that would be a finding about ownership and is reported, not absorbed.
- **Every elimination reaches #30.** The issue is the record; a session that learns something and
  leaves it only in a commit message has repeated the mistake the convention was written for.

## What will be got wrong

**"It passed twenty times, so it is fixed."** A failure seen four times in perhaps a hundred CI
runs is not measured by a hundred passes. Without a rate there is no number of green runs that
means anything, which is precisely why the rate is increment 2's output and not a footnote.

**Fixing `stitchSurface` because that is where the throw is.** The throw is where the *check* is.
The crops arrive from `cropFor`, which is test code, through `readCrops`, which is production code,
and the survey cannot yet say which of the three produced a misplaced crop.

**Treating a green re-run as evidence of anything.** It has now happened four times and taught
nothing on each occasion.

**Reaching for `test.retry` when reproduction proves hard.** It would turn a visible intermittent
failure into an invisible one and would satisfy every gate. It is fenced out above for that reason,
and if the conclusion is genuinely "this cannot be reproduced", the honest output is a report, not a
retry.

**Letting the environment survey become a rewrite.** Node v24.20.0 and the *measured* runner worker
count are two controlled variables — and the count is measured because no log here records it, not
assumed from a core count nobody has read. Neither is an invitation to change what CI runs or what
`vitest.config.ts` sets.

## Amendment, 2026-09-17 — increment 2c: a controlled runtime-mode experiment

**Status: Design revised 2026-09-19; implementation under review; dispatch requires separate
approval.** The amendment was drafted 2026-09-17. What the owner ruled on 2026-09-19 is the
*design*, in two parts, and neither is an approval of the implementation: the worker transport
(the marker, turned into the workers' `execArgv`), and **the symmetric exclusions as a revised
experimental scope, with their limitation recorded** — `N = 60` stays fixed, and that approval
**does not validate transferring the old `M` bound** (see "Exactly when 2c makes it eligible").
**2c has since run** — see "Result, 2026-09-20 — increment 2c" below, which also carries the
owner's ruling on `M`.

PR #57 restored the baseline — the seven diagnostic paths back to `025cdbe` byte for byte,
leaving increment 1's placement report and nothing above it. That restoration is what makes 2c
measurable: a control arm on a build whose measured rate was 0/100 would measure nothing. The
implementation is `scripts/flake-experiment.mjs` (the experiment: schedule, tallies, statistics,
gates, reporting) driven by `scripts/run-flake-probe.mjs` (the sole executable), over the shared
seam in `scripts/flake-probe.mjs` (`SIGNATURE`, `classifyRun`, `interpretSpawn`) that both the 2b
probe and this comparison have always had in common. **Dispatch is a separate ruling and is not
authorised by this section.**

### Why the plan changes here

Increment 2's loop reproduced the failure and increments 1, 2b and the diagnostics that followed
narrowed it to one call: the first crop's stored `west` changes while `cropFor` constructs the
second crop. Each of these is excluded by observation — the generator resuming and dispatching the
call; the fake reader's two `calls.readTile`/`calls.readBounds` pushes; the diagnostic's own
`handedBack.push`; the async return, promise resolution and microtask resumption; and the build's
own `collected.push` in `readCrops`.

**The construction observation inside `cropFor` is not excluded.** The reproducing trace bracketed
the whole call — correct before entry, wrong after return — and that `observeCrop` sits inside the
bracket. The finer probe that would have separated it returned zero hits, so it settled nothing. It
remains one of the candidate operations inside `cropFor`, alongside the envelope and clip, the index
arithmetic, the typed-array allocation, the sample loop and the object literal.

Then the method ran out. Probe `35178802590` at `c20b417`, with ten diagnostic stages inside that
window, returned **0 hits in 100 complete runs** — one-sided 95% upper bound 2.951% — against ten hits at
the previous head. The two ran as **separate GitHub Actions jobs**: their *recorded* environment
fields matched (`availableParallelism 4`, node v24.20.0, vitest 4.1.11, linux/x64) and their mean
run times were 18.74 s and 18.8 s, but the physical runner and its load were uncontrolled in both. Whether the observations suppressed
the failure or the rate drifted again cannot be separated by that result or by repeating it, and
each added stage does real work inside the very interval it measures. **Positional narrowing at the
JavaScript level is therefore closed**: a finer cut occupies more of what it is cutting.

What T8.1's acceptance criterion asks for is the **cause**, and no further position supplies one.
This amendment replaces "cut the interval again" with "vary one property of the runtime and measure
whether the failure depends on it".

### 2c — the experiment

**One distinction, and only one: default Node against `--jitless`.** No semi-space sizing, no GC
flags, no worker-count change, no coverage change. A run that varied two things at once could not
attribute a difference to either, and this plan has already paid once for a comparison nobody
predeclared.

- **Instrumentation is removed first.** Every hot-path stage observation added after increment 1's
  placement report comes out — the `cropFor` interior, the seam interior, the `readCrops` passes,
  the floor-check and spacing-check points. What remains is the placement report itself, which is
  deterministic and sits at the throw rather than in the window. **The four original occurrences
  predate it**: they were matched to each other by the preserved signature line, and the placement
  report was added afterwards to make later occurrences legible. **The removal is a precondition, not a step of the experiment**: measuring a
  runtime distinction on a build whose measured rate is 0/100 would measure nothing.
- **The arms differ in one thing: the runtime the test workers run in.** Both spawn the identical
  command the existing probe runs, `npm run test:coverage`, with identical argv. The difference
  travels as an environment marker, `MAPATLAS_PROBE_RUNTIME_MODE`, which `vitest.config.ts` turns
  into the workers' `execArgv`. Delivering it by substituting a different runner command would make
  the arms differ in more than runtime mode.

  **Two earlier transports were tried and both failed while passing every assertion over the
  constructed environment**, which is why the check below is a real subprocess and not a shape
  test. `NODE_OPTIONS=--jitless` is permitted by Node but disables WebAssembly process-wide, and
  Vite's parent then throws `ReferenceError: WebAssembly is not defined` before a single test runs
  — every variant run an unrelated failure, every experiment contaminated. Vitest 4.1.11 silently
  discards `poolOptions.forks.execArgv`, so the worker ran default Node and the two arms were the
  same mode: a null the design would have read as "no difference". Only `test.execArgv` reaches the
  worker, and it leaves the parent unflagged, which is what the parent needs.

  **The marker is set in both arms**, differing only in value. It also governs one exclusion, of
  two files a worker without WebAssembly cannot run — for different reasons, each measured by
  running the file under a jitless worker. `scripts/generate-service-worker.test.mjs` fails **as a
  whole module, at import**: the script it tests imports Vite, which throws `ReferenceError:
  WebAssembly is not defined`, and none of its tests is collected.
  `scripts/serve-archives.test.mjs` imports no Vite; five of its tests call `fetch()`, and Node's
  `fetch` fails with the same `ReferenceError` as its cause. They are excluded from **both** arms,
  because excluding them from one would add "which tests ran" as a second difference.

  **What that does to the design rate, stated rather than assumed away.** `025cdbe`, where the 13%
  was measured, selected **95** test files. This tree selects 97 — it adds
  `flake-experiment.test.mjs` and `runtime-mode.fixture.test.mjs` — and while probing excludes the
  two above: **95 again, with two members exchanged**, not "two files smaller". An earlier version
  of this paragraph said the control arm reproducing "is what would show it did not matter". It
  would not. A control hit establishes that the failure **reproduces on this revised suite**; it
  says nothing about whether the *rate* is unchanged. The 80.876% design power is **conditional on
  a 13% control rate**, which this suite is not known to have. If the true rate here is lower, the
  likely cost is a null control and a spent dispatch, which the gate reports as inconclusive — not
  a false conclusion. The owner approved this as a revised experimental scope on 2026-09-19 with
  that limitation recorded, `N = 60` unchanged.

- **Proven by a real subprocess before every `verify`.** `check:runtime-mode` spawns both arms
  through the real config and reads what the worker got: that each completes Vitest, that the
  default worker carries no flag and has WebAssembly, and that the jitless worker carries the flag
  and has none. It spawns **what the runner spawns**: both come through `scripts/spawn-arm.mjs`,
  the one spawn path, with the environment `spawnPlan` builds for that arm, and only the command
  differs (the fixture alone rather than the whole suite).

- **Every measured run is certified against the arm the runner scheduled, not against itself.**
  Inside the worker, `runtime-mode.fixture.test.mjs` can only compare the worker's environment with
  the worker's flags. That catches a marker that arrives without its flag (the `poolOptions` case)
  and **not** a marker that never arrives: no marker and no flag agree, and the run is green in
  default Node under either arm's label — shown in review by a runner whose spawn call delivered
  no environment, which passed every gate with both arms running the 97-file unmarked suite. The
  measured command's output carries nothing from inside a worker, so the facts travel as a file:
  the runner names a fresh certificate path per run (`MAPATLAS_PROBE_CERTIFICATE`), the fixture
  writes `{marker, jitless, wasm}` there, and the runner judges them against the arm **it**
  scheduled (`certificateProblems`). **A missing or mismatched certificate is an instrument
  failure**, which contaminates its arm by the existing gate — so an environment that was never
  delivered is red by absence rather than a silent comparison between an arm and itself.
- **Equal fixed budgets of `N = 60` per arm, one dispatch, one job, one tree.** 60 runs default and
  60 runs `--jitless`, the number fixed in source with no dispatch input, alternating arm by arm so
  that drift over the job's duration falls on both arms rather than on one. One job, so that neither
  arm can land on a different machine from the other; the machine itself is still uncontrolled, as
  it is for every run in this record.
- **Counted separately**, with the exact-signature matcher and the intact-budget conditions
  unchanged from the existing probe. **An unrelated failure or an instrument fault in *either* arm
  makes the whole experiment inconclusive**: no Fisher comparison is computed and no statement about
  runtime mode is permitted. Not "inconclusive in that arm" — that wording would leave room to
  compare a filtered or unequal pair of samples, which is precisely the comparison equal fixed
  budgets exist to prevent.
- **The default arm is the control and it must reproduce.** If the default arm returns zero, the
  experiment is **inconclusive** and says nothing about `--jitless`, however the other arm comes
  out. Stated before the run precisely because the tempting reading of a double null — "the flag
  fixed it" — is exactly the one this design must refuse.

### Predeclared comparison, and the wording it permits

Fixed before the dispatch, so that nothing is chosen after seeing counts:

- **Test:** Fisher's exact test, two-sided, on the 2×2 of hits and misses in the two arms.
- **Threshold:** `α = 0.05` for this one comparison. No other comparison is entitled to it; the
  probe-to-probe rate comparisons already on issue #30 stay labelled exploratory and post-hoc.
- **Budget, fixed here rather than at dispatch:** `N = 60` per arm.

  The design rate is **13%**, the rate measured at `025cdbe` — the last probe carrying only
  increment 1's placement report, which is the shape 2c restores. The later 10%, 2% and 0% figures
  were all measured on builds carrying hot-path stage tracing that 2c removes.

  Against a true rate of zero in the `--jitless` arm, the two-sided Fisher exact test at `α = 0.05`
  rejects when the default arm shows **≥ 6 hits** in 60. Under `Binomial(60, 0.13)` that has
  probability **80.876%**, which is the design power. `N = 59` gives 79.566%, so 60 is the minimum
  equal-arm budget meeting an 80% bar. Recomputing this from any later observed rate is not
  permitted; the number is fixed by this amendment.

  **Convention:** two-sided Fisher exact by the *sum of tables no more probable than the observed
  one* (`p = Σ P(table) over tables with P ≤ P(observed)`), on exact hypergeometric probabilities in
  double precision. The same convention produced 80.876% and 79.566% above, and it is the one the
  runner must implement and assert against a fixture.
- **Reporting, in three tiers, so no field is chosen after seeing the result.**

  **Always, whatever happened:** each arm's **raw counts** — runs completed, exact signatures,
  unrelated failures, instrument failures — and, where an arm was contaminated, which arm and by
  what. Raw counts are observations; they are entitled to be reported in every outcome.

  **Only for an intact arm:** that arm's hit **rate** and its exact two-sided 95% Clopper–Pearson
  interval. **A contaminated arm gets neither**, because it has no valid denominator to compute
  them from: an instrument failure can truncate output, so an apparent non-hit there may be an
  unobserved hit, and an unrelated suite failure means that run did not complete the same Bernoulli
  trial as the runs beside it. A rate over such a set is an inference the data does not support,
  and printing one is not made safe by withholding the Fisher test.

  **Only when both arms are intact *and* the default control reproduced:** the Fisher p-value and
  the **predeclared 80.876% design power**.

  **Otherwise the Fisher test is not computed at all** — not computed and then withheld. A p-value
  *is* a comparison of the two modes, so producing one where the control returned zero, or where an
  arm was contaminated, would be making exactly the comparison those rules forbid and then declining
  to quote it. There is no number to suppress if it was never calculated.

  **No post-hoc "achieved power"** in any outcome — computed from the observed rates, it adds
  nothing to the counts and the p-value it is derived from.
- **If the control reproduces and `p ≤ 0.05`:** the permitted statement is *"the failure rate
  differs between default and `--jitless` on this runner"* — nothing about optimisation being the
  cause, and nothing about which optimisation.
- **If the control reproduces and `p > 0.05`:** the permitted statement is *"this budget did not
  distinguish the two runtime modes"*. Not "the runtime mode makes no difference".
- **If the control does not reproduce:** *"inconclusive; the control did not reproduce"*, and no
  statement about `--jitless` at all.

### What this does not do

It does not identify a mechanism, and a significant result would **not** show this repository's
JavaScript to be free of defects. `--jitless` changes timing, allocation behaviour and execution
throughout the suite, any of which could expose or mask a defect that is ordinary JavaScript. What
such a result licenses is narrower: that the reproduction rate depends on the runtime mode under
this experiment, which makes runtime mode a variable worth narrowing next. Escalating upstream would
need a minimal reproducer and stronger causal evidence than a rate difference.

`M = 51` stays **frozen and unused** throughout. It was derived from the **pre-trace, minimally
instrumented** probe at `025cdbe` — which carried increment 1's placement report and nothing else —
and 2c's default arm is the first comparable control since.

**The revised scope does not carry `M` with it** (owner's ruling, 2026-09-19). `M = 51` was derived
from the 13% rate on `025cdbe`'s suite, and 2c's control arm runs a suite with different
membership; approving the symmetric exclusions did **not** validate transferring the old bound to
it. The rule below is the *precondition* 2c can establish — that a 51-run validation could have
seen the failure at all — and meeting it makes `M` eligible for transfer under a separate ruling,
not transferred.

*(Ruled 2026-09-20, after 2c ran: **not transferred**; see "The owner's ruling on `M`" below. The
rule that follows is kept as written — it is what 2c was run against.)*

**Exactly when 2c makes it eligible.** `M = 51` is the count at which a *reverted-fix* validation
is expected to see at least one exact-signature failure. The default arm runs 60, not 51, so
reproducing somewhere in 60 is not the same evidence. **Nothing below transfers `M` or authorises
a validation at 51**; the most 2c can do is make `M` eligible, and the transfer is the owner's
separate ruling. The rule:

- **at least one exact-signature hit within the default arm's first 51 runs** → `M = 51` becomes
  **eligible** for transfer, and no more than that. The hit shows a 51-run validation *could* have
  seen the failure on this suite; it does **not** show that the old rate bound applies to it, since
  `M` was derived from a 13% rate on a suite with different membership. `M` stays frozen, and no
  reverted validation may be run at 51, until the owner rules;
- **hits only in default runs 52–60** → 2c has reproduced and its own comparison stands, but `M`
  is **not eligible** and does not transfer: a 51-run reverted validation was not shown able to
  falsify anything, and the budget has to be re-derived from this arm's measured rate under
  review;
- **no hits at all** → the control did not reproduce, the experiment is inconclusive, and `M` stays
  frozen.

This is checkable only if the runner records **each hit's index within its own arm**, so it does
that, and the split is read off those indices rather than off the totals.

The lattice-placement candidate stays parked. It is symptom immunity rather than a cause fix, and
merging it would stop the placement report being emitted at all, which is what every result above
was read from.

## Result, 2026-09-20 — increment 2c

One dispatch, approved by the owner against the current `origin/main`, with no inputs. Recorded on
issue #30 the same day. Implemented and merged as **PR #58** (`a5903b2`, merged as `987ac20`).

- **Run [35512357623](https://github.com/gosha70/mapatlas/actions/runs/35512357623)**, job
  `106082356056`, head **`987ac20fc6451961698f6062d90c9f214f64317d`**, 13:02:56Z → 13:49:20Z.
  Runner: linux/x64, node v24.20.0, vitest 4.1.11, `availableParallelism 4`.
- **default: 8 exact signatures in 60**, 0 other failures, 0 instrument failures; hits at control
  runs 13, 15, 34, 48, 49, 54, 55, 60; rate 13.333%, exact 95% CI 5.936%–24.592%.
- **`--jitless`: 0 in 60**, 0 other, 0 instrument; exact 95% CI 0.000%–5.963%.
- **Fisher exact, two-sided: p = 0.00609**, against α = 0.05. Recomputed independently in exact
  rational arithmetic: 0.0060900555….
- **The permitted statement, and the only one:** *the failure rate differs between default and
  `--jitless` on this runner.* Nothing about optimisation being the cause, and nothing about
  which.

**What was checked before the result was believed.** All 120 run lines present, in strict
alternation, none carrying an interruption, a failure beside a hit, or an instrument fault — so
every run's worker certified the arm it was scheduled in. All eight hits are the production form
`BuildError: fixture build failed at stage "tiles": …`, each run `1 failed | 1931 passed | 1 todo`
over 95 files. A second error line appearing exactly eight times in the log is the stderr of a
*passing* test that throws on purpose (`event-composer.test.ts`, *"stays sealed when onSave
throws"*); it is in every run, and the log prints full output only for hits.

**The placement report is identical in all eight, and identical to the one already on #30**:
`[0] 46x113` and `[1] 35x113`, both at origin `(7, 45.52194444444444)`. No new position. Five hits
fell in *"reads each admitted cell once, by its own id, in the order coverage returned them"* and
three in *"attributes each cell's samples to that cell"*.

**13.3% is one sample, not proof of an unchanged rate.** It sits beside a 13% design rate measured
on a suite of different membership, with an interval of 5.9%–24.6%. It shows the failure reproduces
on the revised suite. The agreement of two point estimates is not evidence that the rate did not
move.

### The owner's ruling on `M`, 2026-09-20

**`M = 51` is not transferred.** The eligibility precondition was met — the first control hit fell
at run 13 — and eligibility was all 2c could establish. On the revised suite's **own** control the
one-sided 97.5% lower bound is `p_lo = 5.936%`, and the established formula gives

> `M = ceil( ln(0.025) / ln(1 − 0.05936) ) = ceil(60.28) = `**`61`**.

**If a later validation uses this exact suite, 61 is the defensible candidate. If its suite
changes, the budget is derived from a matched control.** 51 is kept as historical evidence only:
it is what `025cdbe`'s 13/100 implied for `025cdbe`'s suite, and it is not a bar any future
validation is entitled to.

The runner's closing line — *"`M = 51` is ELIGIBLE to transfer … needs the owner's separate
ruling"* — was correct when it was printed and is now answered. It is reworded or removed under
2d's implementation review, not here: this document changes no code.

## Amendment, 2026-09-20 — increment 2d: default Node against `--no-opt`

**Status: implementation authorised by the owner on 2026-09-20 — *"build and falsify the
implementation exactly as planned, but do not dispatch the probe"* — and under review. No dispatch
is authorised.** Prepared at the owner's direction after 2c's result, against `main` at `987ac20`.

**Corrected in review, 2026-09-20, before it was committed — two defects in the experiment's
validity, both the author's.** *The combined error accounting was wrong:* it credited a 2d test at
`α = 0.025` with restoring a 5% ceiling across both experiments, computing `1 − 0.975²` as though
2c had not already tested at 0.05. *And the certificate could certify the wrong runtime:* it
proposed filtering the worker's arguments through a watch-list, which `--max-opt=2` passes while
disabling TurboFan, and which sees "exactly `--no-opt`" in `--no-opt --opt` while TurboFan is back
on. Both are corrected below, and the owner's ruling on the budget is recorded where the choice
used to be.

### Why this cut, and what it can and cannot say

2c separated default Node from a runtime with **no** JIT at all. That is the widest cut available,
and the rate differed across it. The next cut is the narrowest one that still removes a whole,
named component: **`--no-opt`**.

Read from the binary rather than remembered — `node --v8-options`, Node 24:

```
  --turbofan (use the Turbofan optimizing compiler)
        type: bool  default: --turbofan
  --opt (alias for --turbofan)
        type: bool  default: --opt
```

`--maglev` and `--sparkplug` are both listed `default:` enabled. So `--no-opt` **disables
TurboFan and leaves Ignition, Sparkplug and Maglev running.** Confirmed by behaviour and not only
by help text: under `--allow-natives-syntax`, a hot function's `%GetOptimizationStatus` is
`1010001` by default and `110001` under `--no-opt` — and under `--no-turbofan` it is the same
`110001`, bit for bit.

**What a difference would license:** *the failure rate differs between TurboFan-enabled and
TurboFan-disabled execution on this runner.* **Not** "optimisation caused it", and not "TurboFan
has a bug": disabling a tier changes which code runs, how long it takes to get hot, what is
inlined and when garbage is collected, and any of those could expose or mask an ordinary defect
in this repository's JavaScript. It narrows a variable. It does not name a mechanism.

**What no difference would license:** *this budget did not distinguish the two modes* — as in 2c,
and no more. If `--no-opt` still reproduces, the next cut can distinguish Maglev from Sparkplug.
**That cut is deliberately not planned here**; it depends on a result that does not exist.

### Survey — measured at `987ac20`, before anything was proposed

Local Node is v24.11.1; the runner's was v24.20.0. Everything below is a claim about the local
binary until the check re-establishes it on the runner, which is why the check does that.

1. **`--no-opt` reaches the worker through `test.execArgv`**, the route 2c proved. A temporary
   config merging `execArgv: ["--no-opt"]` over the real one gave a worker
   `execArgv` ending `…,"--no-opt"`, against none without it.
2. **The real measured command passes under it, with the same suite.** `vitest run --coverage`
   with the marker set: **95 files, 1,932 tests + 1 todo, exit 0, in both modes**, at about the
   same wall time (5 s and 4 s locally). Unlike `--jitless`, **no test needs excluding on its
   account.** This was run because 2c's first transport was fine and its experiment would still
   have been worthless — five tests failed under the variant, and only running the real command
   found them.
3. **Node refuses `--no-opt` in `NODE_OPTIONS`** — *"--no-opt is not allowed in NODE_OPTIONS"*. 2c
   had to refuse that route itself; here Node does, and the experiment's own refusal stays
   anyway, because it costs nothing and does not depend on a Node version's allow-list.
4. **The flag's effect is observable only with `--allow-natives-syntax`**, which is itself a
   runtime flag and **must never reach a measured arm**. 2c's variant could certify a
   consequence from inside the worker — WebAssembly was gone. 2d's cannot.
5. **`--no-opt` is one of several arguments that decide the same thing, and the last one wins.**
   Measured with the same hot function: `--max-opt=2` gives `110001`, TurboFan off, *without*
   `--no-opt` appearing anywhere; `--no-opt --opt` gives `1010001`, TurboFan **on**; `--opt
   --no-opt` gives `110001`. So neither the presence of `--no-opt` nor the absence of a list of
   known flags says which of these a worker was started as. **Only the whole startup argument
   list distinguishes these tested command-line configurations; it cannot detect later in-process
   flag changes** — see the second stated gap below.
6. **The worker's whole argument list is small, stable, and differs by exactly one element.**
   Read unfiltered from inside a worker, through the real config, twice for default:
   `--experimental-import-meta-resolve`, `--require <vitest>/suppress-warnings.cjs`,
   `--conditions node`, `--conditions development` — seven arguments, all Vitest 4.1.11's own,
   identical across runs, with `NODE_OPTIONS` unset. The `--no-opt` worker's list is those seven
   **followed by `--no-opt`**, and nothing else differs.

### 2d — the experiment

Everything 2c fixed stays fixed unless it is named here.

- **The same 95-file suite, by the same exclusion.** The two excluded files would *run* under
  `--no-opt` — they need WebAssembly, which it does not remove. They stay excluded **for suite
  identity with 2c's control**, which is the only matched control on record and the suite `M = 61`
  was derived on. The reason the exclusion exists has changed; the config comment has to say so.
- **The arms differ in one thing: the workers' `execArgv`.** Identical argv, identical
  `npm run test:coverage`, the marker set in both arms, `--no-opt` delivered through
  `test.execArgv` and nowhere else.
- **One table maps an arm to its flags**, and the experiment is fixed in source to the pair it
  runs — `default` against `no-opt`. The runner still takes no arguments. `jitless` stays in the
  table as the arm 2c ran, so 2c's record remains reproducible from this tree.
- **Alternating, sequential, one job, one tree, fixed equal budgets, no dispatch input** — as 2c.
- **Contamination gate, null-control gate, and "not computed" rather than "computed and
  withheld"** — unchanged, with their existing falsifiers.
- **The per-run certificate records the worker's *full* `execArgv`, verbatim, and the runner holds
  the property directly** — not through a list of flags to look for, which fails open (survey
  item 5). Three requirements, judged by the runner against the arm it scheduled:
  1. **The `default` worker's arguments are exactly the expected list** — the seven Vitest itself
     supplies (survey item 6), its one path taken relative to the project. *Exactly*, so the
     control certifies that it carries **no** argument of its own, tier-changing or otherwise;
     `--max-opt=2` is refused for being unexpected, not for being recognised. This fails
     **closed**: a Vitest upgrade that changes its own arguments turns the check red, to be
     re-read under review, rather than being waved through.
  2. **The two arms' arguments differ by exactly `--no-opt`**: the variant's list is the control's
     with that one element added and nothing else changed, in order. `--no-opt --opt` differs by
     two elements and is refused, whatever a search for `--no-opt` would have said. This is a
     property of the **pair**, so it is asserted on the pair — in `check:runtime-mode` with both
     arms spawned, and in a measured run against the first control run, which the alternation
     guarantees comes first.
  3. **The worker's `NODE_OPTIONS` is unset**, recorded alongside.
- **Any inherited `NODE_OPTIONS` is refused before anything is spawned** — all of it, not a search
  within it for known flags. It reaches the Vite parent *and* every worker in both arms, and no
  value of it is needed to run this experiment. That Node would itself reject `--no-opt` there
  (survey item 3) covers one spelling on one Node version.
- **The flag's *meaning* is certified by a real subprocess, in `check:runtime-mode`, outside every
  measured run.** Plain `node --allow-natives-syntax`, a hot function, `%GetOptimizationStatus`,
  three ways: default, `--no-opt`, `--no-turbofan`. Required: **default reaches a tier that
  `--no-opt` does not**, and `--no-opt` equals `--no-turbofan`. The first half is what stops the
  proof being vacuous — if the function never got hot, all three agree and nothing was shown. It
  runs in `verify` and in `ci.yml`'s required step, so it is re-established on the runner's Node.

  **The gap this leaves, stated:** the meaning is shown in a plain Node process and the delivery
  in a Vitest worker, and nothing shows the meaning *inside* the worker. What bridges them is 2c:
  a flag delivered by `test.execArgv` demonstrably took V8 effect there — WebAssembly vanished. A
  worker is a Node child process given those arguments. Closing the gap outright would mean a
  check-only config branch that puts `--allow-natives-syntax` into a worker; this plan judges
  that more machinery, and one more way for the flag to leak into a measured arm, than the gap is
  worth — and says so for the reviewer to overrule.

  **A second gap, also stated:** arguments are not the only way to set a V8 flag.
  `v8.setFlagsFromString` does it from code and leaves `execArgv` untouched. Nothing in this
  repository calls it (searched at `987ac20`), and the certificate would not see it if something
  did.

### Predeclared comparison

Test, convention, three-tier reporting and permitted wording: **as 2c**, with `--no-opt` for
`--jitless` and the narrower statement above.

**The owner's ruling, 2026-09-20: `N = 60` per arm, `α = 0.05`**, two-sided Fisher exact by the
same convention — which, against a variant arm showing zero, **rejects on ≥ 6 default hits**
(`p = 0.02741` at six, `0.05732` at five). Design power at the 13% design rate and a true variant
rate of zero: **80.876%**, computed by this repository's own `designPower`.

**2d is a separately predeclared *exploratory* diagnostic, and the pair of experiments carries no
5% family-wise guarantee.** 2c's amendment says of its `α = 0.05`: *"No other comparison is
entitled to it"* — and 2c has spent it. 2d tests at 0.05 again, in its own right. Across the two:

| | chance of at least one false rejection across 2c and 2d |
|---|---|
| with no assumption (Bonferroni, the union bound) | **≤ 10%** |
| only if the two tests are independent | 9.75% (`1 − 0.95²`) |

The 10% is what this plan is entitled to claim; the 9.75% needs an assumption nothing here
establishes — same suite, same hypothesis family, a result in one prompting the other. Neither
test is in the fix-acceptance chain, whose 5% total is split elsewhere and is untouched by both.

**Why not a stricter 2d.** Considered and rejected, with the arithmetic kept because the first
draft got it wrong: testing 2d at `α = 0.025` costs power at `N = 60` (67.778%, rejecting at ≥ 7)
or nine more runs per arm to hold 80% (`N = 69`, 80.932%) — and **buys no 5% ceiling either way**,
because 2c's 0.05 is already spent: `1 − 0.95 × 0.975 = 7.375%` under independence, 7.5% without.
No choice made for 2d can recover α that 2c used. A fixed-sequence argument — 2d runs only because
2c rejected, so each may take the full α — **is not claimed**: the sequence was not declared
before 2c's result.

About 40 minutes of runner time: 120 runs at the ~19 s a default run took in 2c, `--no-opt` having
cost nothing measurable locally.

**The design rate stays 13%**, from `025cdbe`. 2c's control came out at 13.3%, and that is not
used: recomputing a budget from a later observed rate is what 2c's amendment forbade, and the
reason has not changed.

**Power against zero is the optimistic case.** `--jitless` removed everything; `--no-opt` removes
one tier. If the true `--no-opt` rate is reduced rather than zero, this budget's power is lower
than the table says, and *"did not distinguish"* is the likelier honest outcome. That is an
argument for reading a null carefully, not for a bigger budget chosen now.

**2d says nothing about `M`.** Its control arm is 60 runs and the candidate is 61, so the 2c-style
eligibility rule cannot even be evaluated inside it. Hit indices are still recorded. Whether 2d's
control may later be pooled with 2c's — same suite, different day and runner — is **not decided
here**.

### Scope fence for 2d

In: the arm table and the `no-opt` arm; the full-argument certificate and the pair assertion; the
refusal of any inherited `NODE_OPTIONS`; the meaning check; the
config's exclusion comment; the runner's `M` line; the workflow's header and job name.

Out: the Maglev/Sparkplug cut; any fix; the lattice candidate; any change to the statistics, the
gates, the reporter, the spawn path or the identity rule for the recorded failure; the
quick-start gap recorded in T8.2's plan.

## Result, 2026-09-21 — increment 2d

One dispatch, approved by the owner against the verified `origin/main` tip, with no inputs.
Implemented as **PR #60** (`7e7a48a`, merged as `8045a84`); recorded on issue #30 the same day.

- **Run [35666074878](https://github.com/gosha70/mapatlas/actions/runs/35666074878)**, job
  `106552010228`, head **`8045a84c899e36e4ea51ccc7a8fab133cd6fe178`**, 23:07:27Z → 23:32:01Z.
  Runner: linux/x64, node v24.20.0, vitest 4.1.11, `availableParallelism 4`; the same image as 2c's
  job (`ubuntu-24.04` 20260828.587, centralus).
- **The instrument certified on this job's own Node, before the loop**: worker arguments exactly
  as expected and differing by exactly `--no-opt`; 95 files collected in each arm; tiers default
  `1010001`, `--no-opt` `110001`, `--no-turbofan` `110001`.
- **default: 0 in 60**, 0 other, 0 instrument; exact 95% CI 0.000%–5.963%. **`--no-opt`: 0 in 60**,
  0 other, 0 instrument. All 120 runs completed, strictly alternating, each certified.
- **No Fisher test was computed.** The null-control gate held: **inconclusive; the control did not
  reproduce.** Nothing is said about `--no-opt`. The one-sided 95% upper bound on this job's control
  rate is 4.87%.

**Descriptive, confounded, and unrelated to `--no-opt` — recorded so nobody rediscovers it.**
Default runs took a median of **11.9 s** here against **18.6 s** in 2c, on the same suite and
image, with `scripts/fixture/` and `packages/` byte-identical between the two trees; timing was
flat within the job. 2c's control against this one, 8/60 against 0/60, is p = 0.00609 by Fisher —
**not predeclared, two jobs on two days under unknown load, and about the default-Node rate, not
the variant.** P(0 in 60 | p = 13%) = 2.4 × 10⁻⁴. The default-Node rate on the runner has now
been measured at 13, 10, 2, 10, 0 per 100 and 8, 0 per 60, on trees whose fixture code did not
change between the last two. It is not stable across jobs.

**Ruled by the owner, 2026-09-21: 2d is not repeated as it stands.** Re-dispatching until the
control reproduces would select experiments by their observed control outcome, and the predeclared
comparison would no longer be one. `M` remains frozen with no statement from 2d; no fix, no
dispatch and no lattice-candidate work is authorised. What follows is an amendment of options.

## Amendment, 2026-09-21 — after 2d: the options, and what each costs

**Status: proposed, plan-only. Nothing here is authorised — not a dispatch, not an implementation,
not a fix.** Written so the owner chooses among costed options rather than among impressions, and
so that the one option that is *not* on the list is named as such.

### The problem the options answer

2c and 2d were the same design on the same suite, six days apart on the same runner image, and
their controls returned 8/60 and 0/60. **The control rate is not a stable property of the runner
that a 60-run budget can rely on.** Every budget in this plan was sized from a 13% design rate
measured once at `025cdbe`; the runner has since produced 10%, 2%, 10%, 0%, 13.3% and 0% on
various trees. With `p = 0.13` the null-control probability at `N = 60` is 2.4 × 10⁻⁴ — it "cannot"
happen — and it happened. The design rate is the assumption that failed, not the instrument: every
gate held, every certificate matched, and the job did exactly what it was built to do.

**Not an option: repeat 2d until the control reproduces.** Ruled out, and the reason recorded: the
experiments that "count" would be selected by their observed control outcome, which makes the
comparison conditional on a favourable draw. Its p-value would no longer mean what the plan says
it means. This applies to any rule of the form "dispatch again if the control was null", however
it is dressed.

### The options

Each is stated with its predeclared rule, its cost, and what it can and cannot conclude. The
figures use the repository's own `designPower` and the exact conventions already in force.

**A. Stop the runtime-mode line here.** 2c's result stands as the one finding: on one day, on one
runner, the rate differed between default and `--jitless`. 2d adds nothing either way. T8.1 stays
open with a position and one runtime-mode finding, and the next narrowing comes from a different
axis — for instance the fixed load the plan has never controlled.
- *Cost:* nothing further spent. *Concludes:* nothing new. *Risk:* the `--jitless` finding rests on
  one job whose control happened to reproduce, which 2d has just shown is not guaranteed.

**B. A larger, predeclared 2d — one dispatch, sized so that a null control is itself informative.**
Fix `N` before dispatch so that, at a control rate the runner has *demonstrated* rather than the
13% it once showed, the probability of a null control is small enough that a null is a finding
about the rate rather than bad luck. At `N = 150` per arm:
- if the true control rate were 5.936% (2c's own lower bound), P(null control) = 0.0001;
- if it were 2%, P(null control) = 0.048. A null control at `N = 150` is then reported as what
  it is: **the one-sided 95% upper bound on that job's control rate is 1.977%** — a bound, stated
  the way the earlier result sections state theirs, and not a probability about the true rate;
- design power against a zero-rate variant, computed by this repository's `designPower`
  (rejection at **≥ 6 hits in 150**, p ≤ 0.05): **> 99.9%** at a 13% control rate, **76.6%** at
  5%, 29.6% at 3%. The first draft of this bullet said "≥ 5 hits" and "87.0%" from memory; both
  were wrong, and are corrected here from the computed values — mistake 7c, in this amendment.
- *Cost:* 300 runs, roughly 60 minutes at 2d's 12 s or 95 at 2c's 19 s; one job, one ceiling to
  raise to 180 minutes. *Concludes:* a difference at a variant rate of zero if the control holds
  near 13%, with 80% power lost somewhere between 5% and 13%; and a null control becomes a bound
  on the day's rate rather than a shrug.
  *Risk:* one more α = 0.05 exploratory test on the 2c/2d family; the union bound across three
  would be 15%. *Does not:* fix the drift, or explain it.

**C. One adaptive job: measure the control first, then compare only under a rule fixed before
the job starts.** The confound 2d exposed is *between* jobs, so a pilot in one job establishes
nothing about the control rate in the next; a two-job design would re-import the problem it is
meant to solve. So: one dispatch, one job, two stages, and the rule between them written here and
in source before anything runs.
- *Stage 1, pilot:* `N₁ = 100` default-Node runs, no variant. Its only product is that job's
  control rate with its interval.
- *Continuation rule, predeclared:* stage 2 runs if and only if the pilot's one-sided 97.5% lower
  bound on the rate exceeds a threshold fixed here — proposed **3%**, the rate below which no
  affordable budget has power; otherwise the job stops, records the pilot as a bound on the day's
  rate, and reports "no comparison was run". Any other rule, or one chosen after seeing the
  pilot, is the selection rule ruled out above, one stage removed.
- *Stage 2, comparison:* `N₂` per arm, fresh runs, alternating as now, with the budget itself
  fixed from the pilot's lower bound by a formula written here — the smallest equal-arm `N₂`
  giving 80% power at that bound against a zero-rate variant, capped at 150. **The threshold and
  the cap have to agree, and at 3% they do not**: by `designPower`, 80% power needs `N₂ = 263` at
  3%, 157 at 5%, 98 at 8%. So either the threshold is 5% and the cap 157, or the threshold is
  3% and stage 2 is declared under-powered below 5% with that stated in its report. Which is a
  choice for the owner, made before dispatch; it is not made here.
  **The pilot's observations are excluded from the Fisher table**: the comparison is between two
  arms of fresh, alternating observations. A pilot hit is evidence about the day's rate, not a
  control observation of the comparison.
- *Cost:* 100 runs plus up to 300, one job; the ceiling rises to 180 minutes. *Concludes:* on a day
  the runner reproduces, a comparison sized to that day's rate; on a day it does not, a bound and
  no comparison, without a variant ever having been looked at. *Risk:* the pilot and the comparison
  are still in the same uncontrolled job and can drift within it; the alternation in stage 2 is
  what spreads that, as now. *Does not:* explain the drift.

**D. Record a pre-treatment CPU-throughput covariate, and let its range scope the result.** The
confound 2d exposed is the default arm running 36% faster than in 2c's job — a *between-job*
difference in the machine, not in the arms. Two things this option is **not**, because the first
draft proposed both: it is not a gate on the two arms' wall times, since arm duration is
downstream of the runtime mode (`--jitless` changed it by 50%, and `--no-opt` may too) and
contaminating on it would discard the effect under test; and it is not pinning
`--max-old-space-size` or `maxWorkers`, which control the process and not the shared host. What it
is, stated at its actual size:
- a **common-mode, pre-treatment covariate**: before each measured run, and identically in both
  arms, a fixed calibration workload in a plain default-Node process — the same hot loop the meaning
  check already runs — timed and written into that run's structured results. It never sees the
  arm's flags, so it cannot carry the treatment; it sees the host, **but only one slice of it**.
- **What the slice is, and is not.** An arithmetic hot loop observes Node start-up, JIT warm-up and
  CPU scheduling. It does **not** observe memory pressure, GC conditions, filesystem contention or
  any other shared-host effect — and the recorded failure is allocation-sensitive, so those are
  exactly the conditions that could move it. A second draft of this option said the covariate
  would show "two jobs ran on comparably loaded hosts" and "make every later job comparable to the
  one before it". **It cannot.** A job that passes a CPU-throughput range may differ from another
  in every dimension the loop does not touch. Whether this covariate tracks the *suite's* duration,
  let alone the failure's rate, is not established by anything on record, and would have to be —
  by correlating it against per-run suite time across jobs — before it could be read as more than
  a covariate.
- a **predeclared rule that does not condition on the treatment**: the calibration times are
  reported always, compared *across the job* and *against the previous job's*, never between arms.
  If a range is fixed under review before a dispatch, a job outside it reports its result as
  **"scoped to a CPU-throughput range that differs from job X's"** — a scoping of the claim, not
  a finding of incomparability, and not a contamination gate.
- *Cost:* a small increment on the runner and reporter plus its falsifiers — chiefly that the
  calibration process refuses every arm flag, and that the rule never reads an arm's own duration.
  *Concludes:* nothing by itself. *Gives:* one recorded, pre-treatment dimension along which jobs
  can be placed, where today there is none; and, if the correlation above is ever established,
  the beginning of a control. *Does not:* control the between-job confound. Nothing on this list
  does; that is the honest state of the record.

**E. Measure the rate locally again, on the current workload.** Increment 2a already ran 200
local full-suite runs at the runner's worker count with no hits — on the minimally instrumented
`025cdbe` baseline, the very shape PR #57 later restored byte for byte, **not** on a traced tree.
So the local null is an existing control, not a gap. What has changed since is the workload: the
suite is now 95 files while probing, with the experiment's own tests added, so a new local series
measures something 2a did not.
- *Cost:* local machine time. *Concludes:* an upper bound on the **local** rate for the current
  workload — 200 null runs bound it at 1.49%, as 2a's did. **It cannot establish that the shared
  runner is a precondition of the failure**; a local null bounds the local rate and says nothing
  about why the runner's differs. A local *hit* would be worth far more than another local null.

### What this amendment recommends, and does not decide

**D, then C — in that order, each under review, none of them now.** D because it costs the least,
carries no treatment, and records a pre-treatment dimension that no job so far has — a covariate
to scope results by, not a control of the host. C because it
replaces an assumed rate with one measured in the same job, before a variant is looked at, under a
rule fixed before dispatch — and because it subsumes B: its stage 2 *is* a B-sized comparison, run
only on a day the pilot says one can be sized. A is the fallback if C's pilot stops the job. E is
orthogonal, cheap, and can run beside any of them.

**Ruled by the owner, 2026-09-22: option A.** The runtime-mode line stops here; T8.1 is parked —
open, unowned, its acceptance criterion not met — with the status record in `tasks.md`. The
instrument (the probe workflow, `check:runtime-mode`, its CI step) is kept for any resumption,
which needs a further ruling. This document is history from here, not a work plan.

**The owner decides.** This amendment authorises nothing.

**Superseded 2026-09-23: the owner ruled option B.** T8.1 resumes on the runtime-mode axis; the
next section is the resumption's predeclaration, and this document is a work plan again.

## Amendment, 2026-09-23 — increment 2e: option B, at a larger budget and a changed suite

**Ruled by the owner, 2026-09-23: option B**, superseding the 2026-09-22 parking. One dispatch,
`N = 150` per arm, sized before dispatch so that **a null control is itself a finding** rather
than the shrug 2d ended in.

**Status: predeclared, implementation under review. No dispatch is authorised by this document**
— it is a separate instruction, as every dispatch in this plan has been.

### 2e is a follow-on, not 2d at a larger budget — the workload changed underneath it

**Corrected 2026-09-24, in review, before any dispatch.** The first draft of this amendment said
"one number changes" and "the same 95-file suite". **Both were false**, and the mistake is the
plan's own 7c: the figure was carried forward from 2d's record instead of being measured. The
real `npm run check:runtime-mode` on this tree reports **91 files in each arm and 93 unmarked**.

Measured, with the provenance, because the drift did not happen all at once:

| tree | unmarked | while probing |
|---|---|---|
| `025cdbe`, where the 13% design rate was measured | — | 95 |
| 2d's head `8045a84` | 97 | 95 |
| T8.2's close `c0587a2` | 98 | 96 |
| now | **93** | **91** |

T8.2 added one test file and T8.3 removed five — the `/lab` unit suites, four deleted and one
moved to the browser lane. **Nothing pinned the count.** The exclusion of two files from both
arms preserves *arm identity*, and `check-runtime-mode` asserts exactly that — the two arms
collect the same set, and an ordinary run still has the two extras. Neither is a claim about the
suite's *size*, so the workload changed twice without a gate noticing. That is a finding about
this instrument, recorded here, not a defect in the check: the check proves what it says.

**So two things change in 2e, not one:**

1. `RUNS_PER_ARM`, 60 → 150 — the budget option B rules;
2. the measured suite, 95 files → **91**, which no one chose for this experiment and which is
   simply the repository as it now stands.

**Why the second matters.** The suite *is* the workload whose flakiness is being measured. The
recorded failure is allocation-sensitive, and four fewer test files is less allocation, less
elapsed time and a different scheduling profile on a shared host. Whether that moves the rate is
**unknown and unmeasured** — it is not a reason to expect a change, and not a reason to expect
none. It is a reason not to claim continuity.

**What follows, and what does not:**

- 2e is an **exploratory follow-on over the 91-file suite**, read on its own terms. It is *not*
  evidence that 2d's or 2c's result does or does not hold, and a difference between 2e's control
  rate and theirs is confounded by the workload as well as by the job.
- **The 95-file evidence stays scoped to the 95-file suite.** 2c's 8/60 against 0/60, its 13%
  design rate, and the validation candidate **`M = 61`** — derived on the exact 95-file suite by
  the owner's ruling of 2026-09-20 — describe a workload that no longer exists in this tree. None
  of them transfers to 2e, and 2e produces no statement about `M`.
- The rest of the cut *is* unaltered, and that is still worth stating: default Node against
  `--no-opt`, strict alternation, full-execArgv certification of every run against the scheduled
  arm, refusal of any inherited `NODE_OPTIONS`, the same three gates in the same order, the same
  `α = 0.05`, the same two-sided Fisher exact convention.

**The honest summary of the runtime-mode line after this correction:** every one of 2c, 2d and 2e
measures a *different* workload on a runner whose rate is already known to be unstable between
jobs. 2e buys a comparison at a budget where a null control says something. It does not buy
comparability with what came before, and the first draft of this amendment claimed it did.

**Two things about *reporting* change, because B's premise is that a null control must be
informative.** Both are in the instrument, not in the design:

1. **A null control now prints its own bound.** 2d's null control reported "inconclusive; the
   control did not reproduce" and nothing else; the one-sided 95% upper bound of 4.87% that its
   result section quotes was computed **by hand after the fact**. B's whole claim is that at
   `N = 150` a null control *is* a finding, so the report must state it without a human
   recomputing it afterwards — otherwise the finding depends on someone remembering to do the
   arithmetic, which is the shape of a result chosen after the fact.
2. **The predeclared power becomes a curve, not a number.** 2c and 2d each printed one figure,
   "80.876% at 13.000% in default". **13% is the assumption that failed** — the rate it was
   measured at has since been contradicted by the runner six times over. Printing a single power
   figure resting on it would be the plan's own mistake restated at a larger `N`, and at
   `N = 150` it would read 99.995%, which is worse: near-certainty derived from the number the
   record has already disproved. So the report states power at each rate of a predeclared range.

**The gates do not change.** A null control still forbids the comparison; contamination still
forbids everything. B makes the null *legible*, not permissible.

### The design at `N = 150`, computed rather than recalled

Every figure below is from this repository's own `designPower`, `fisherExactTwoSided` and
`clopperPearson` at `α = 0.05`, against a true variant rate of zero, and is asserted in
`scripts/flake-experiment.test.mjs` so prose and source cannot drift:

| control rate | rejects at | design power |
|---|---|---|
| 13% (the original design rate) | ≥ 6 in 150 | **99.995%** |
| 5.936% (2c's own lower bound) | ≥ 6 in 150 | 88.581% |
| 5% | ≥ 6 in 150 | **76.556%** |
| 3% | ≥ 6 in 150 | **29.574%** |

The rejection threshold is six hits at every one of them: `p = 0.029698` at six against a null
variant, `0.060420` at five. The predeclared range printed with the result is **13%, 5% and 3%**
— the original design rate, and the two rates that bracket where the runner has actually been.

**What `150` is not.** It is **not** the smallest budget clearing a power bar, and the docstring
must not say it is: `N = 149` gives 76.003% at 5% against 150's 76.556%, so nothing turns on the
last run. 150 is a **fixed budget at a cost ceiling** — 300 runs, roughly 60 minutes at 2d's
11.9 s median or 95 at 2c's 18.6 s — whose properties are then stated rather than optimised for.
2c's budget was genuinely minimal for its bar and its docstring said so; copying that sentence
here would be a false claim about how this number was chosen.

**Why a null control is now a finding.** P(null control at `N = 150`) is 1.03 × 10⁻⁴ if the true
rate is 2c's lower bound of 5.936%, and 4.83 × 10⁻² if it is 2%. So a null at this budget is
reported as the **one-sided 95% upper bound on that job's control rate: 1.977%** — a bound on the
day's rate, stated the way every result section here states one, and **not** a probability about
the true rate, nor a claim that the rate is stable between jobs. That is the whole of what a null
buys, and it is strictly more than 2d's null bought.

### Alpha, stated as this plan is entitled to state it

2e is the **third** separately predeclared exploratory test in the 2c/2d family, each at
`α = 0.05` in its own right.

| | chance of at least one false rejection across 2c, 2d and 2e |
|---|---|
| with no assumption (Bonferroni, the union bound) | **≤ 15%** |
| only if the three tests are independent | 14.26% (`1 − 0.95³`) |

**≤ 15% is what this plan claims**; the 14.26% needs an independence assumption nothing here
establishes — the same hypothesis family, and each result prompting the next. (An earlier draft
also offered "same suite" as a reason; it is withdrawn, since the three ran on three different
workloads. That makes them less alike, not independent.) Neither figure
is a 5% family-wise guarantee, and none of the three is in the fix-acceptance chain, whose 5%
total is split elsewhere and is untouched.

### The dispatch rule, fixed here

- **One dispatch, no inputs**, against a verified `origin/main` tip, as 2c and 2d were.
- **The result stands however it comes out.** No repeat, no second job, no "dispatch again if the
  control was null" in any dress — the selection rule the 2026-09-21 amendment ruled out applies
  to 2e unchanged. A null control at `N = 150` is a reported bound and the end of the increment,
  not a reason to run it again.
- The job ceiling rises from 150 to **180 minutes**, which is the only workflow change.
- **The dispatch runs against the exact reviewed tree** (ruled 2026-09-24). `origin/main` must be
  the merge of the content approved here; if `main` advances first, **the workload returns for
  review** before any dispatch. This is the pin, and it is deliberately not a numeric one: a
  count assertion would fail every time anyone adds a test file, and would still miss a
  **same-count exchange** — which is exactly what happened between `025cdbe`'s suite and 2d's,
  where 95 files became 95 files with two members swapped. A reviewed tree pins membership; a
  number pins only its size.

### Required mutations for 2e

**Eleven mutants were run before this was handed over: ten killed, one ruled not a defect.** The
ten are below, each turning a named assertion red; the eleventh is recorded after them, because a
mutant that survives for a good reason is worth writing down rather than quietly dropping.

- the budget reverted to 60, or the power curve collapsed to the 13% figure alone → the design
  test fails, and so does the report's;
- the null-control bound computed from `clopperPearson`'s two-tailed upper limit (2.429%) instead
  of the one-sided 1.977% → the bound test fails;
- the bound not printed at all, printed for a **contaminated** experiment, or computed from
  `RUNS_PER_ARM` instead of what the arm actually completed → the report tests fail;
- a null control exiting 0 because it now carries a finding → the exit-rule test fails. The rule
  moved out of `run-flake-probe.mjs` into `exitCode` so that it could be reached at all;
- the ceiling set below the budget's own duration at the slowest measured pace, or raised so far
  it stops bounding a hung job, or the **budget** raised without the ceiling → the ceiling test
  fails. It is computed from `RUNS_PER_ARM`, not quoted, so the two cannot drift.

**The eleventh, ruled not a defect having been measured:** a ceiling left at 150 minutes. 300 runs at 2c's
18.6 s is 93 minutes of loop, so 150 would still have fitted — the raise to 180 is headroom over
the slower of the two measured paces, not a correction of an unsafe number. The ceiling test
permits 150 for that reason, and a test contorted to forbid it would have been asserting a
preference rather than a property.

### What 2e cannot do

It does not fix the flake, explain the drift, or control the between-job confound — **nothing on
the 2026-09-21 options list does**, and B was never claimed to. It buys one comparison at a
budget where a null control says something, on one job, on one day. `M` stays frozen and no
statement about it follows from 2e; the lattice candidate stays untouched; no fix is authorised.

## Result, 2026-09-25 — increment 2e: the comparison was computed, and lost

One dispatch, approved by the owner against the verified `origin/main` tip, with no inputs.
Posted to issue #30 on 2026-09-25
([comment](https://github.com/gosha70/mapatlas/issues/30#issuecomment-5825765436)).
**Run [36077914754](https://github.com/gosha70/mapatlas/actions/runs/36077914754)**, job
`107893180196`, head **`e2cd2222eb25a06bb23dcbbd021efc8b4ca495cc`**, 00:31:16Z → 02:00:32Z
(89m16s, under the 180-minute ceiling). Runner: linux/x64, node **v24.21.0**, vitest 4.1.11,
`availableParallelism 4`.

**This is recorded as "comparison result lost", not as "inconclusive".** The two are different
outcomes, and conflating them would misstate what is known in both directions. 2d was
inconclusive: it ran, and its control did not reproduce. 2e ran, its control *did* reproduce, a
Fisher test *was* computed — and the numbers no longer exist.

### What is known, and how

The job's conclusion was **success**, and `exitCode` returns 0 only when `comparison` is defined,
which requires passing both gates. So, with certainty:

- **150 of 150 runs completed in each arm**, with **zero unrelated failures** and **zero
  instrument faults** — which is what `intact` means, in both arms.
- **The default control reproduced.** A null control returns exit 1; this did not.
- **A two-sided Fisher exact test was computed** at α = 0.05.
- From the surviving head of the log: **run 1/300, default 1/150, was an exact-signature hit**
  (17.4 s).
- The instrument certified on this job's own Node before the loop: worker arguments exactly as
  expected and differing by exactly `--no-opt`; **91 files collected in each arm, 93 unmarked** —
  the workload 2e is scoped to; tiers default `1010001`, `--no-opt` `110001`, `--no-turbofan`
  `110001`.

### What is lost, and why

**Both arms' hit counts, both rates and their intervals, the p-value, and the outcome — DIFFERS or
UNDISTINGUISHED.** The exit code does not separate those two, so nothing distinguishes them.

`run-flake-probe.mjs` printed the report with `console.log` and nowhere else, at the end of 300
runs' output. GitHub capped the step log at **114,903 bytes**, cutting it off mid-word after run
1. Confirmed through three channels — `gh run view --log`, the jobs API, and the raw log archive —
all identical; the run uploaded no artifacts, and the owner checked check-run annotations, which
preserved one exact-signature annotation and no counts, no arm, no run index, no p-value.

**The budget caused it.** At 60 per arm the output fit under the cap; at 150 it did not. The
amendment that raised the budget did not consider that the result's only copy sat at the end of a
stream whose length scales with the budget, and none of its eleven falsifiers tested whether the
report survives to be read — every one tested what it says. That is the gap, stated plainly.

### What follows

**No statement about `--no-opt` is permitted from 2e.** Not "undistinguished", not "differs", not
a direction. The comparison happened and its result is unavailable; that is the whole of it.

**No rerun** (owner's ruling, 2026-09-25). The one-dispatch rule stands, and re-running because
the first run's *record* disappointed is the selection the 2026-09-21 amendment ruled out, one
step removed. `M` stays frozen; no fix, no lattice-candidate work.

**Corroboration, recorded separately and not part of 2e.** On the same commit `e2cd222`, about 75
minutes before this dispatch, an ordinary `ci.yml` run
([36071861141](https://github.com/gosha70/mapatlas/actions/runs/36071861141)) failed its Test step
with a message **byte-identical** to the recorded signature — `isRecordedFailure` and
`carriesSignature` both true against `RECORDED_FIRST_LINES[1]`, with the familiar diagnostic of
crops `[0] 46x113` and `[1] 35x113` sharing one origin.

**It is a reproduction on the 93-file ordinary suite, which is not the probe's workload.** That
run was unmarked — no `MAPATLAS_PROBE_RUNTIME_MODE` — so `vitest.config.ts` applied no
probe exclusion and collected **93** files; the probe's arms collect **91**, the same suite less
the two a jitless worker cannot run. Related, and a different workload. An earlier draft of this
section called it the 91-file suite, which was wrong.

So it establishes that the failure still reproduces on this tree's ordinary suite under default
Node. It is one observation, from a different job under a different harness, not predeclared, and
it is **not** evidence about `M`, about `--no-opt`, or about 2e's arms.

**T8.1 remains open, and is parked again after this attempted increment.**

## Amendment, 2026-09-25 — the durability repair (instrument only)

**Ruled by the owner, 2026-09-25.** Hardening, not a fourth experiment: it changes no measurement,
no gate, no threshold and no conclusion, and **spends no alpha**. Implemented and under review;
**no dispatch is authorised by this document.**

- The runner opens `probe-output/transcript.log` **before the first run** and appends to it as the
  loop goes, so a probe **process** that crashes or exits non-zero leaves everything it reached
  for the `if: always()` steps below to check and preserve. Every line the loop emits goes through
  one tee; a `console.log` reintroduced inside it turns a test red.
- It writes `probe-output/report.txt` and appends the report to `$GITHUB_STEP_SUMMARY` **before
  `process.exit`**, because there is no after. The summary is best-effort and reports rather than
  throws; the artifact is the durable copy.
- The workflow uploads `probe-output/` in a step **after** the probe, with **`if: always()`** —
  a null control and a contaminated arm both exit non-zero, and those transcripts are worth most —
  and **`if-no-files-found: error`**, since a silent empty artifact is the failure being repaired.
- **The probe's exit status is untouched**: `continue-on-error` on the probe step turns a test red.
- **A timeout leaves neither a verdict nor a transcript, and that is understood.** It kills the
  job, no `always()` step runs, and the runner is ephemeral — so the incremental file dies with
  it. Writing incrementally protects against the probe **process** failing, after which the
  `always()` steps do run and preserve what the loop reached. An earlier draft of this amendment
  claimed the transcript survived a timeout; it does not.
- **Both files, or the job says so.** `if-no-files-found: error` rejects an *empty* directory and
  accepts one holding only the transcript, so a separate `if: always()` step between the probe and
  the upload requires both by name. The upload stays `if: always()` behind it, so a transcript
  that survived is still archived when that check fails.

**Fourteen falsifiers, all killed.** The complete inventory, so the total is auditable rather than
asserted:

| # | Mutation | What it would cost |
|---|---|---|
| 1 | the report write deleted | increment 2e's loss, reintroduced exactly |
| 2 | the transcript never opened | the loop prints to the console only |
| 3 | the transcript opened after the loop | a process failure preserves nothing |
| 4 | the report written after `process.exit` | i.e. never |
| 5 | the summary append removed | the verdict off the run's own page |
| 6 | a `console.log` back in the loop | that line in the log, absent from the artifact |
| 7 | the transcript buffers instead of appending | its tail lost when the process dies |
| 8 | the upload moved before the probe | an empty directory archived |
| 9 | `if-no-files-found` relaxed to `warn` | an empty artifact passing silently |
| 10 | the completeness check accepts a transcript alone | half the pair uploaded as a whole one |
| 11 | the completeness step removed | the upload left to accept half the pair |
| 12 | the completeness check loses `if: always()` | skipped exactly when output is likeliest incomplete |
| 13 | the **upload** loses `if: always()` | a failed check discarding the transcript that survived |
| 14 | `continue-on-error` on the probe | an answerless job turning green |

**Reconciling with the eleven this section first recorded:** rows 10, 11 and 12 are new with the
completeness check, and row 13 is the former `upload-only-on-success` **reclassified, not added** —
the same edit on the same anchor, renamed because with a check now in front of the upload it
costs the surviving transcript as well as a failing probe's. So: eleven, minus none, one renamed,
plus three. No falsifier was removed or weakened.

Two harness defects were found and fixed while running them — a `stepsOf` reader that silently
dropped `continue-on-error`, which made row 14 **invisible rather than survivable**, and an
evaluation-order bug in the mutation script that truncated the workflow before reading it. Both
are the [[validate-the-mutant]] shape: a mutant that appears to survive may be a broken mutant.

## Required mutations

Each must turn a named assertion red:

- the diagnostic message stripped of one crop's placement → increment 1's test fails, rather than
  passing on a message that happens to mention the others;
- **the pair report widened to name every pair rather than the overlapping one** → the test fails
  on the uninvolved crop being attributed. This is the mutation that distinguishes attribution from
  enumeration, and it is the reason the fixture carries three crops;
- the existing signature line reworded, reordered or re-spaced → an assertion on that exact text
  fails, so the sentence four occurrences were matched by cannot drift while the diagnostics are
  added around it;
- the overlap counting removed while the placement report stays → the existing signature assertion
  fails, so the new report cannot replace the old one by accident;
- **and, once a reproduction exists:** the fix reverted → the reproduction command fails at the
  measured rate; the fix applied → it passes over the derived run count. Without these two, the
  task is not done, whatever the suite says.

**For increment 2c**, each must turn a named assertion red:

- **both labelled arms actually run default Node** — the marker not reaching the worker, by any
  route → `check:runtime-mode` fails, because it spawns both arms and reads the worker's own
  `execArgv` and `typeof WebAssembly` rather than the environment handed to the child. A shape
  assertion is **not** sufficient here and is not accepted as this falsifier: two transports have
  already passed one while the worker ran the wrong runtime;
- **the arm's environment not delivered to the child at all** — the spawn call handing the child
  the inherited environment in place of the plan's → `check:runtime-mode` fails, because it comes
  through the same spawn path as the runner and a child that was told no certificate path writes no
  certificate. In a measured run the same fault leaves every run uncertified, and both arms
  contaminated;
- **the certificate compared against its own marker instead of the scheduled arm** — a
  self-consistent certificate from the other arm accepted → an assertion that
  `certificateProblems` refuses it fails. Agreement between a worker's marker and its flags is what
  a misdelivered run also shows;
- **a signature masking an unrelated failure in the same run** — the tally's kinds made mutually
  exclusive again, so a run carrying the recorded failure *and* another failure counts
  `signature: 1, other: 0` → an assertion that such a run keeps its hit, counts as unrelated as
  well, contaminates its arm and never reaches Fisher fails; and `check:runtime-mode` fails,
  because it makes a real fixture fail several ways at once — among them the recorded failure, an
  unrelated test, an unrelated `describe`-level hook — and requires each to be accounted for. The hook
  is there because Vitest's own JSON reporter records **nothing** for it (measured on 4.1.11),
  which is why the structured results come from `scripts/probe-results-reporter.mjs` instead;
- **a signature masking another error *on the same test*** — an entry cleared because *some* error
  in it carries the signature. Vitest attaches a teardown's error to the test it ran after, so the
  recorded failure and an unrelated `afterEach` error arrive as one entry with two messages, and
  clearing the entry clears both (shown in review: `signature=1, other=0`, Fisher called) → an
  assertion that every error in an entry is judged fails, and `check:runtime-mode` fails, because
  its fixture's fourth failure is exactly this and must be named. `afterAll`, an unhandled
  rejection and a module failing at import, each beside a hit, were probed with real subprocesses
  as well and are recorded as entries of their own;
- **an error that only *carries* the signature exempted from contamination** — the structured
  check made end-anchored again, or loosened to any prefix or any line. **The log and the structured
  results are two representations of one identity, built on the one `SIGNATURE` constant, and they
  can demand different amounts.** A log line arrives behind whatever was printed before it
  (`SurfaceError: `, `BuildError: `), so the *hit* is decided by a line **ending** with the
  signature — unchanged. A structured message arrives bare, so whether an error is **exempt from
  contaminating** its run is decided by its **whole first line**, which must be one of exactly two:
  the signature as `stitchSurface` throws it, or the signature behind the exact label `BuildError`
  gives the tiles stage, `fixture build failed at stage "tiles": ` — the form a real build fails
  with, which is why demanding the bare signature would contaminate every genuine hit. The
  appended diagnostics are not part of the identity. `rebuild failed: <signature>`, another
  stage's label, the label twice, or the signature on a later line all remain **logged hits** and
  all **contaminate** (the first was shown in review as a clean hit reaching Fisher) → assertions
  over the real `SurfaceError`/`BuildError` path fail, which also derive both accepted first lines
  from production so that a rewording there fails rather than drifts; and `check:runtime-mode`
  fails, whose fixture raises the recorded failure through production in both forms and must leave
  exactly those two unnamed;
- **a run's structured results not arriving** — the reporter not configured, or writing nowhere →
  `check:runtime-mode` fails, and in a measured run every run is an instrument failure from run 1
  rather than the gap being discovered at the first hit;
- **the smoke check not run where it is required** — `ci.yml` runs individual scripts and never
  `verify`, so the check is its own step in the `gates` job; ordinary CI exercises only the default
  worker and would otherwise pass with the jitless branch of the config removed;
- **an uncertified run counted as a trial** — a green run with no valid certificate left out of the
  instrument tally → an assertion that it contaminates its arm, with Fisher never called, fails;
- **the flag delivered by changing the command rather than the marker** — an arm spawning something
  other than `npm run test:coverage` → an assertion that both arms spawn the identical argv fails.
  Changing the command would make the arms differ in more than runtime mode;
- **the marker set in only one arm** — the exclusion it governs would then apply to one arm and not
  the other → an assertion that both arms are marked, with different values, fails. **That
  assertion does not hold the property on its own**, and was once claimed to: the exclusion can be
  keyed to the variant's *value*, leaving both arms marked and every unit test green while Vitest
  collects 97 files for one arm and 95 for the other (shown in review). So:
- **the two arms collecting different suites, by any route** — `check:runtime-mode` lists what
  Vitest collects for each arm through the real config and fails unless the two sets are identical;
  and it fails unless an ordinary unmarked run differs from an arm by **exactly** the two excluded
  files, so the exclusion can neither leak into ordinary runs nor quietly grow;
- **alternation replaced by grouped execution** — all 60 default runs then all 60 `--jitless` runs →
  an assertion on the arm sequence fails. Grouping puts any drift over the job's duration entirely
  on one arm, which is the confound alternation exists to spread;
- **a default-arm null allowed to reach the comparison** — given a zero control, the verdict must
  return *inconclusive* **without the Fisher test having been called**. Asserted on the call, not
  on the wording: a runner that computed a p-value and then declined to print it has already made
  the comparison the control rule forbids, and the oracle is a counting or spy assertion that the
  test was never invoked;
- **a contaminated arm accepted** — an unrelated failure or an instrument fault in either arm must
  make the **whole experiment** inconclusive, with no Fisher comparison computed and no runtime-mode
  statement permitted; a verdict that reported "inconclusive in that arm" and compared the rest
  fails this;
- **a contaminated arm still given a rate** — a verdict that correctly withholds the Fisher test but
  publishes a rate or a Clopper–Pearson interval for the contaminated arm fails. Raw counts are
  always reportable; an inferred rate over a set whose denominator is not a completed trial is not,
  and suppressing the comparison does not make the arm's own rate sound;
- **the fixed `N = 60` made dispatch-selectable** — a run-count input reaching the budget → the
  argument guard fails, on the same reasoning as the existing probe's fixed `PLANNED_RUNS`.

**For increment 2d**, each must turn a named assertion red. 2c's falsifiers all stay, re-run
against the new arm where they name one:

- **the `no-opt` arm running default Node** — the arm table ignored for `no-opt`, or the flag put
  anywhere but `test.execArgv` → `check:runtime-mode` fails, because the worker's certificate
  lacks `--no-opt`; and in a measured run every variant run is an instrument failure;
- **`default + --max-opt=2`** — a tier-changing argument no list of known flags names, reaching the
  control worker → the certificate is refused, the control's arguments not being exactly the
  expected list. TurboFan is off in that worker and `--no-opt` appears nowhere, so a search for
  flags passes it; this is the mutant that shows the control is held by what its startup
  arguments *are*, rather than by which of them somebody thought to look for;
- **`no-opt + --opt`** — the variant's `--no-opt` followed by the argument that undoes it → the
  pair assertion fails, the arms differing by two elements and not by exactly `--no-opt`.
  TurboFan is **on** in that worker while `--no-opt` is present, so a search for it passes;
- **the same extra argument in *both* arms** — so that the pair still differs by exactly
  `--no-opt` → refused by the control's exact list. Without it the pair assertion alone would
  accept two arms that are both wrong in the same way;
- **`--allow-natives-syntax` reaching a measured arm** — by the arm table or the environment →
  refused as an unexpected argument, in either arm;
- **the meaning check made vacuous** — the hot loop shortened until default never reaches TurboFan
  → the check fails *because default did not get there*, rather than passing on three equal
  statuses. A proof that cannot fail this way has shown nothing;
- **`--no-opt` not meaning what this plan says** — the check's `--no-opt` process swapped for a
  default one → fails, the two statuses being equal;
- **the suite changing between 2c and 2d** — the exclusion dropped because the variant no longer
  needs it → the existing collected-suite comparison fails, the arms no longer differing from an
  unmarked run by exactly the two files;
- **the probe not certifying `--no-opt` on its own Node** *(found in review of the
  implementation)* — the meaning check run only by `ci.yml`. The probe job's `node-version: 24`
  floats, so a dispatch may resolve a Node the check never ran on, and the per-run certificates
  prove delivery, not meaning: the result would say "TurboFan-enabled against disabled" without
  that having been established on the measured runtime. So the probe job runs
  `npm run check:runtime-mode` **as its own step, before the loop and outside the measured
  command**, and stops with no result if it fails → an assertion on the workflow's **whole ordered
  list of commands** fails if the step is dropped, or moved after the loop;
- **the arm table itself wrong** *(found while falsifying the implementation)* — `no-opt` defined as
  `["--no-opt", "--opt"]` → **the certificate accepts it**, and says so here rather than hiding
  it: what it holds a variant to is "the control's arguments followed by *the table's* flags", so
  a wrong table is a wrong expectation that every worker then meets. It is the **meaning check**
  that fails, because it runs the table's own flags in its plain process and finds the default
  tier. The two are not redundant: the certificate holds the workers to the table, and the
  meaning check holds the table to what the plan says it means;
- **any `NODE_OPTIONS` inherited at all** — `--max-old-space-size=4096` as readily as a V8 flag →
  the runner refuses to start. 2c's refusal looked for `--jitless` inside it and let everything
  else through; that is the shape corrected here.
