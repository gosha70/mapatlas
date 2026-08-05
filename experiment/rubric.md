<!-- SPDX-License-Identifier: Apache-2.0 -->

# MAP-ATLAS build experiment — scoring rubric

Two harnesses (**Claude Code** and **pi.dev**) build MAP-ATLAS from the *same*
harness-neutral seed (`specs/` + `CLAUDE.md`), one phase at a time. After each
phase we score both against the matrix below and record the result in
[`results.md`](results.md).

## Ground rules (keep the A/B fair)

- **Same brief.** Identical prompt per phase, derived from `specs/tasks.md` +
  `roadmap.md`. Neither harness gets hints the other didn't.
- **Independent verification.** Scores for objective rows come from *actually
  running the gates from a clean checkout*, not the harness's own claim.
- **Same seed, isolated branches.** Claude on `build/claude-code`, pi on
  `build/pi-dev`, both from commit `4069328`. Neither sees the other's tree.
- **Record how each was run** (permission mode, interventions) under Operability
  — the run conditions are part of the result, not hidden.

## Scoring

Each dimension: **✓ = 2** (fully met) · **△ = 1** (partial / minor issue) ·
**✗ = 0** (not met). Phase total out of **16**. Notes carry the evidence.

| # | Dimension | What it measures (score ✓ only if…) |
|---|---|---|
| 1 | **Gates green** | build + typecheck + lint + test + any phase scans all pass **from a clean `npm install`**, verified independently |
| 2 | **Task completeness** | every task in the phase implemented; the phase's exit criteria in `roadmap.md` hold |
| 3 | **Spec fidelity** | matches `PRD.md` / `architecture.md` / `api.md`; the one architectural rule (core depends on nothing consumer/renderer-specific) is honored; no domain leakage |
| 4 | **Scope discipline** | builds what the phase asks — no gold-plating, no unrequested features, no premature abstraction |
| 5 | **Enforcement quality** | guards the phase introduces (isolation/SPDX scans, conformance suites) **actually catch a planted violation**, not just pass on clean input |
| 6 | **Conventions** | SPDX header on every new source file; DCO-signed commits; sensible layout/naming |
| 7 | **Code quality** | idiomatic, right-sized, strict-TS honored; readable; tests meaningful (not tautological) |
| 8 | **Operability** | autonomy achieved: interventions needed, turns/prompts, any stall/escalation; **cost** (tokens / \$ where the harness reports it) |

## Per-phase procedure

1. Give both harnesses the **same phase prompt**.
2. Let each build to its phase exit criteria.
3. From each worktree, on a clean checkout: run the gates + a **negative test**
   of any scan the phase added (plant a violation, confirm it fails, revert).
4. Score both columns; write the matrix + a short narrative + any defects to
   `results.md`.
5. Only then start the next phase.

## Out of scope for scoring

- Wall-clock speed (depends on watch/headless mode + network, not build quality).
- Absolute \$ parity — only pi is billed per token; Claude runs plan-included.
  Compare **tokens/turns** for effort, not dollars.
