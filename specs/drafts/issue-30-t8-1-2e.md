<!-- SPDX-License-Identifier: Apache-2.0 -->

# Draft — issue #30 comment, T8.1 increment 2e

> **Not posted.** Held for the owner's approval; posting is a separate instruction. Delete this
> file once it has been posted — `specs/plans/t8-1-fixture-flake.md` is the durable record, and
> two copies of the same account are two things to keep in step.

---

## T8.1 increment 2e — the comparison was computed, and lost

One dispatch, approved against the verified `origin/main` tip, no inputs.
**Run [36077914754](https://github.com/gosha70/mapatlas/actions/runs/36077914754)**, job
`107893180196`, head **`e2cd2222eb25a06bb23dcbbd021efc8b4ca495cc`**, 00:31:16Z → 02:00:32Z
(89m16s, under the 180-minute ceiling). Runner: linux/x64, node **v24.21.0**, vitest 4.1.11,
`availableParallelism 4`.

### The design 2e ran

Default Node against `--no-opt` — TurboFan disabled, Maglev and Sparkplug left running — at
**150 runs per arm**, alternating, every run certified against the arm the loop scheduled.
The budget was fixed before dispatch (option B of the plan's 2026-09-21 amendment) so that a
**null control would itself be a finding**: at N = 150 the one-sided 95% upper bound on a null
control's rate is 1.977%.

**2e is a follow-on, not 2d at a larger budget.** The measured suite is **91 files** where 2c's
and 2d's was 95 — T8.2 added one test file, T8.3 removed five, and nothing pinned the count. The
suite is the workload whose flakiness is being measured, so 2e is read on its own terms; the
95-file evidence, including the `M = 61` candidate, stays scoped to that earlier suite.

### What is known

The job's conclusion was **success**, and the runner exits 0 only when a comparison exists, which
requires passing both gates. So, with certainty:

- **150 of 150 runs completed in each arm**, with **zero unrelated failures** and **zero
  instrument faults**.
- **The default control reproduced.** A null control exits non-zero; this did not.
- **A two-sided Fisher exact test was computed** at α = 0.05.
- **Run 1/300 (default 1/150) was an exact-signature hit**, 17.4 s — from the surviving head of
  the log.
- Certified on this job's own Node before the loop: worker arguments exactly as expected and
  differing by exactly `--no-opt`; **91 files collected in each arm, 93 unmarked**; tiers default
  `1010001`, `--no-opt` `110001`, `--no-turbofan` `110001`.

### What is lost, and why

**Both arms' hit counts, both rates and intervals, the p-value, and the outcome — DIFFERS or
UNDISTINGUISHED.** The exit code does not separate those two.

The runner printed the report with `console.log` and nowhere else, at the end of 300 runs'
output. GitHub capped the step log at **114,903 bytes**, cutting it off mid-word after run 1.
Checked through three channels — `gh run view --log`, the jobs API, and the raw log archive — all
identical. The run uploaded no artifacts. Check-run annotations preserved one exact-signature
annotation and no counts, no arm, no run index, no p-value.

**The budget caused it.** At 60 per arm the output fit under the cap; at 150 it did not. The
amendment that raised the budget did not consider that the result's only copy sat at the end of a
stream whose length scales with the budget, and none of its eleven falsifiers tested whether the
report survives to be read — every one tested what it says.

### What follows

**No statement about `--no-opt` is permitted from 2e.** Not "undistinguished", not "differs", not
a direction. The comparison happened; its result is unavailable.

**This is "comparison result lost", not "inconclusive".** 2d was inconclusive — it ran and its
control did not reproduce. 2e's control *did* reproduce. Recording them the same way would
misstate both.

**No rerun.** The one-dispatch rule stands, and re-running because a record disappointed is the
selection rule this issue already ruled out, one step removed. `M` stays frozen. No fix, no
lattice-candidate work. T8.1 is parked again.

### Durability repair, under review

Instrument hardening only — no measurement, gate, threshold or conclusion changes, and **no alpha
is spent**. It is not a fourth experiment, and it is **not dispatched**:

- the transcript is written **as the loop runs**, so a probe process that crashes or exits
  non-zero leaves everything it reached for the `always()` steps to preserve;
- the report is written to a file and appended to the job summary **before `process.exit`**;
- a step between the probe and the upload requires **both** files by name: the upload's
  `if-no-files-found: error` rejects an *empty* directory but accepts one holding only the
  transcript, which is the half-written case worth catching;
- both are uploaded by a step **after** those, with **`if: always()`** throughout — a null control
  and a contaminated arm exit non-zero, and those transcripts are worth most, so a failed
  completeness check still archives what survived;
- the probe's own exit status is untouched.

**A timeout leaves neither a verdict nor a transcript.** It kills the job, no `always()` step
runs, and the runner is ephemeral. Writing incrementally protects against the probe *process*
failing, after which those steps do run.

### Corroboration, recorded separately

**Not part of 2e, and not evidence about `M` or `--no-opt`.** About 75 minutes before this
dispatch, on the same commit `e2cd222`, an ordinary `ci.yml` run
([36071861141](https://github.com/gosha70/mapatlas/actions/runs/36071861141)) failed its Test step
with a message **byte-identical** to the recorded signature:

```
fixture build failed at stage "tiles": the crops do not tile their union:
0 sample(s) covered by none and 3955 by more than one, over 46x113
```

Crops `[0] 46x113` and `[1] 35x113` placed at the same origin — `cropFor`'s second crop, where
this was already localised.

**It is a reproduction on the 93-file ordinary suite, not the probe's workload.** That run was
unmarked — no `MAPATLAS_PROBE_RUNTIME_MODE` — so no probe exclusion applied and it collected
**93** files; the probe's arms collect **91**, the same suite less the two a jitless worker cannot
run. Related, and a different workload.

So: the failure still reproduces on this tree's ordinary suite under default Node. One
observation, from a different job under a different harness, not predeclared.
