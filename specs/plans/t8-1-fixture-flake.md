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

**Status: proposed. No implementation is authorised by this section.**

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
- **The arms differ in one thing: the spawned environment.** Both run the identical command the
  existing probe runs, `npm run test:coverage`, with identical argv; the `--jitless` arm adds the
  flag through `NODE_OPTIONS` in the child's environment and nothing else. Delivering it by
  substituting a different runner command would make the arms differ in more than runtime mode, so
  the runner asserts both the argv (identical) and the environment (differing only in that flag).
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

**Exactly when 2c transfers it.** `M = 51` is the count at which a *reverted-fix* validation is
expected to see at least one exact-signature failure. The default arm runs 60, not 51, so
reproducing somewhere in 60 is not the same evidence. The rule:

- **at least one exact-signature hit within the default arm's first 51 runs** → `M = 51` transfers,
  and the reverted half of a later validation may be run at 51;
- **hits only in default runs 52–60** → 2c has reproduced and its own comparison stands, but `M`
  does **not** transfer: a 51-run reverted validation was not shown able to falsify anything, and
  the budget has to be re-derived from this arm's measured rate under review;
- **no hits at all** → the control did not reproduce, the experiment is inconclusive, and `M` stays
  frozen.

This is checkable only if the runner records **each hit's index within its own arm**, so it does
that, and the split is read off those indices rather than off the totals.

The lattice-placement candidate stays parked. It is symptom immunity rather than a cause fix, and
merging it would stop the placement report being emitted at all, which is what every result above
was read from.

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

- **both labelled arms actually run default Node** — the `--jitless` arm spawned without the flag in
  its environment → an assertion on the **environment each arm is spawned with** fails. Two arms
  that silently ran the same mode would produce a null the design would read as "no difference";
- **the flag delivered by changing the command rather than the environment** — an arm spawning
  something other than `npm run test:coverage` → an assertion that both arms spawn the identical
  argv fails. Changing the command would make the arms differ in more than runtime mode;
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
