# T8.1 — the fixture-build flake

> Bars set 2026-09-12, **before any candidate fix**, against `main` at `5f0c05d` (the merge of
> PR #46). Every survey finding below was read out of the code, the issue or the CI logs at that
> commit and is cited; nothing is repeated forward from a plan or a conversation.

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

2. **Attempt reproduction, first locally under the controlled variables and then in CI.** Two
   bounded attempts, in this order, each with its budget fixed before it starts.

   **2a — local, controlling what can be controlled.** Node **v24.20.0** rather than v24.11.1, and
   the runner's worker count rather than 13 — *measured* from a CI run first, since no log this
   repository has records it, and then imposed locally with `--maxWorkers`. The **whole suite**,
   because every occurrence has been a full-suite run and none has been the file alone. The
   platform difference stands and is stated with the result: this controls two known variables, it
   does not reproduce the environment.

   **2b — CI, if 2a does not reproduce.** Authorized by the reviewer: a **`workflow_dispatch`-only**
   job that runs the full suite on a fixed budget and reports exact-signature counts. It **never
   runs on push or pull request** — a loop that fired automatically would multiply the CI cost of
   every change and would itself become a source of red runs nobody is reading. It is removed, or
   explicitly kept with a reason, when T8.1 closes.

   *Observable, either way:* the exact signature, produced by a named command, with a rate measured
   against the predeclared budget. *If neither attempt reproduces*, the increment's output is the
   bound and the eliminations, recorded on #30, and the task reports rather than proceeds.

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
