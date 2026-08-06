<!-- SPDX-License-Identifier: Apache-2.0 -->

# MAP-ATLAS build experiment — results

Per-phase A/B of **Claude Code** (`build/claude-code`) vs **pi.dev**
(`build/pi-dev`), scored against [`rubric.md`](rubric.md). Objective rows are
verified by running the gates from a clean checkout, not by trusting the
harness's own summary.

Legend: **✓ = 2 · △ = 1 · ✗ = 0** (per dimension, out of 16).

---

## Phase 0 — Toolchain & skeleton (T0.1–T0.6)

> **Model (both harnesses): `claude-opus-4-8`** — locked for parity. pi selected it at login; Claude Code forced via `--model claude-opus-4-8`. Run mode — pi: `disciplined` (watched, sandbox-gate fallback on host); Claude: `dontAsk` + trusted workspace.

| # | Dimension | pi.dev | Claude Code |
|---|---|:---:|:---:|
| 1 | Gates green | ✓ | ✓ |
| 2 | Task completeness | ✓ | ✓ |
| 3 | Spec fidelity | ✓ | ✓ |
| 4 | Scope discipline | ✓ | ✓ |
| 5 | Enforcement quality | △ | △ |
| 6 | Conventions | ✓ | ✓ |
| 7 | Code quality | ✓ | ✓ |
| 8 | Operability | △ | ✓ |
| | **Total / 16** | **14** | **15** |

### pi.dev — Phase 0 (commit `0915161`, verified 2026-08-05)

Independently verified from a clean `npm install`: **build · typecheck · lint ·
test · scan:isolation · scan:spdx all pass.** 5 package folders
(core/leaflet/react/storage-idb/demo) with SPDX-headed stubs and correct
dependency direction; strict `tsconfig.base.json` (noUncheckedIndexedAccess,
exactOptionalPropertyTypes); flat ESLint + typescript-eslint (`no-explicit-any:
error`); Vitest; `scripts/scan-isolation.mjs` + `scripts/scan-spdx.mjs`; CI
workflow. Single DCO-signed commit.

- **[5] △ Enforcement quality** — the isolation scan catches the common form
  (`import x from "react"`, dynamic `import("react")`) and I confirmed it fails
  on a planted violation, **but misses a bare side-effect import**
  (`import "react";` with no `from`). Minor real gap.
- **[8] △ Operability** — the `unattended` (autonomous) profile correctly
  fail-closed on the unsandboxed host (sandbox gate); the run used `disciplined`
  (watched) as the host-safe fallback. Otherwise built Phase 0 without
  hand-holding. Cost: metered per-token (see pi `/usage`).

### Claude Code — Phase 0 (commit `2b5dea3`, verified 2026-08-05)

Independently verified from a clean `npm install`: **build · typecheck · lint ·
test · scan:isolation · scan:spdx · format:check all pass.** 5 package folders
wired with **TS project references** matching the architecture dependency graph;
strict `tsconfig.base.json` (composite, noUncheckedIndexedAccess,
exactOptionalPropertyTypes); ESLint 9 flat + typescript-eslint + Prettier
(eslint-config-prettier); Vitest with a **sample test per package** (12 tests);
`scripts/check-isolation.mjs` + `check-spdx.mjs`; CI workflow. 32-file DCO-signed
commit.

Edges over pi in Phase 0:
- **Unit-tested the isolation scanner** (`check-isolation.test.mjs`, pure
  `scanContent()` against planted violations) — pi only proved the CLI. Real
  rigor edge (doesn't change the capped code-quality score, but noted).
- **Cleaner operability [8] ✓** — ran autonomously under `dontAsk` + trusted
  workspace with no intervention (Claude Code has no host-sandbox gate).
- **Judgment calls surfaced, not hidden**: flagged 5 transitive dev-dep audit
  findings and deliberately did NOT `audit fix --force` (out of Phase-0 scope);
  added specs to `.prettierignore` rather than reformatting the source-of-truth.

- **[5] △ Enforcement quality** — same gap as pi: the isolation scan catches
  `import x from "react"`, dynamic `import()`, domain tokens, and missing SPDX
  (all confirmed to fail on planted violations), **but misses a bare
  side-effect import** (`import "react";`). Both harnesses share this gap.

### Phase 0 verdict

**Claude Code 15 / pi.dev 14 — both excellent, near-tie.** Both delivered a
correct, gates-green toolchain from the same brief with clean scope discipline,
SPDX + DCO conventions, and a working isolation invariant. They **tie on 6 of 8
dimensions** and **share the identical isolation-scan gap** (bare side-effect
import not caught).

The one-point gap is **operability [8]**: Claude ran hands-off on the host under
`dontAsk`, while pi's `unattended` (autonomous) profile correctly fail-closed on
the unsandboxed host and needed a fallback to `disciplined`. Note this reflects
the **CCT pi-adapter's sandbox gate + this host**, not a pi.dev capability
weakness — it is arguably a safety *point* for pi, scored here as an operability
*cost* because it required an intervention Claude did not.

Beyond the score, Claude showed **more test rigor** (unit-tested the scanner;
per-package sample tests) and clearer judgment communication (audit findings,
prettierignore). pi's build was equally correct and slightly leaner. Both are a
strong Phase 0; carry both to Phase 1.

_Verification method: each build's gates + scan negative-tests were run by the
reviewer from a clean `npm install`, not taken from the harness's own summary._

---

## Phase 1 — `@mapatlas/core` (T1.1–T1.7)

> **Model: `claude-opus-4-8` (both).** Run mode — pi: `disciplined` (watched), committed within the session; Claude: `dontAsk` + trusted, **paused asking approval to commit** (verified/scored from its staged tree). Both cores verified from a clean `npm install`.

| # | Dimension | pi.dev | Claude Code |
|---|---|:---:|:---:|
| 1 | Gates green | ✓ | ✓ |
| 2 | Task completeness | ✓ | ✓ |
| 3 | Spec fidelity | ✓ | △ |
| 4 | Scope discipline | ✓ | ✓ |
| 5 | Enforcement / test rigor | △ | ✓ |
| 6 | Conventions | ✓ | ✓ |
| 7 | Code quality | ✓ | ✓ |
| 8 | Operability | ✓ | △ |
| | **Total / 16** | **15** | **14** |

### pi.dev — Phase 1 (commit `55616ea`, verified)

All gates green from a clean install (build/typecheck/lint/test + isolation +
spdx); 38 core tests; full T1.1–T1.7 (types, sampling, Douglas–Peucker simplify,
haversine finalizeTrack, EventLog, the five seam interfaces + `noopAnalyzer`,
GeoJSON round-trip). One ADR (`ADR-0008`, GeoJSON portability). Committed DCO-signed.

- **[3] ✓ Spec fidelity — stricter on the one architectural rule.** core stays
  **DOM-free**: base `lib: ES2022`, core inherits it, `Blob` typed via Node —
  truest to "core is unit-testable in Node, imports nothing DOM."
- **[5] △ Test rigor.** 38 tests present, but no coverage provider configured, so
  the "**100% unit-tested**" exit criterion can't be *proven* (Claude's can).
- **[8] ✓ Operability.** Built and committed within its watched session.

### Claude Code — Phase 1 (staged on `2b5dea3`; commit pending user approval)

All gates green from a clean install; **44 core tests, 100% lines / 96% branches**
(provable exit criterion); full T1.1–T1.7. **Two ADRs**, and it extended
`specs/api.md` with a "Core utilities" section documenting the new public helpers
(`sample`/`simplify`/`finalizeTrack`/`EventLog`/`newId`/haversine) — additive,
signature-preserving. Exemplary contract discipline + measurable coverage.

- **[3] △ Spec fidelity — loosened the core isolation rule.** core tsconfig
  overrides to **`lib: ["ES2022","DOM"]`** (for `Blob`), documented in `ADR-0008`.
  Behaviorally DOM-free (scan green), but DOM *types* (`document`, `window`, …)
  are now in scope in core — a documented tradeoff, but weaker than pi on the
  project's non-negotiable rule.
- **[5] ✓ Test rigor.** 100% line coverage measurable and met.
- **[8] △ Operability.** Correctly paused for git-commit approval per its posture
  (symmetric to pi's Phase-0 sandbox-gate △ — a safety intervention, not a defect),
  but not hands-off through commit.

### Phase 1 verdict

**pi.dev 15 / Claude Code 14 — the near-mirror of Phase 0.** Both cores are
correct, fully gated, and faithful to `api.md`. The two split on a genuine
engineering tradeoff: **pi kept core strictly DOM-free** (stronger on the one
architectural rule) but couldn't *prove* full coverage; **Claude proved 100%
coverage and documented its extended public surface in `api.md`** but opened core
to DOM types. Each surfaced one safety/permission intervention (pi none this
phase; Claude the commit approval).

**Cumulative after 2 phases: Claude 29 · pi 29 — dead even.** Phase 0 went to
Claude (operability + test rigor); Phase 1 went to pi (stricter isolation +
autonomous commit). They are trading strengths, not one dominating.

_Method: gates + coverage + isolation posture verified by the reviewer from a
clean `npm install`; Claude's Phase 1 scored from its staged tree (commit pending
user approval — code is final)._
