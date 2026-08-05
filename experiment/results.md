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
