<!-- SPDX-License-Identifier: Apache-2.0 -->

# MAP-ATLAS build experiment — results

Per-phase A/B of **Claude Code** (`build/claude-code`) vs **pi.dev**
(`build/pi-dev`), scored against [`rubric.md`](rubric.md). Objective rows are
verified by running the gates from a clean checkout, not by trusting the
harness's own summary.

Legend: **✓ = 2 · △ = 1 · ✗ = 0** (per dimension, out of 16).

---

## Phase 0 — Toolchain & skeleton (T0.1–T0.6)

| # | Dimension | pi.dev | Claude Code |
|---|---|:---:|:---:|
| 1 | Gates green | ✓ | — |
| 2 | Task completeness | ✓ | — |
| 3 | Spec fidelity | ✓ | — |
| 4 | Scope discipline | ✓ | — |
| 5 | Enforcement quality | △ | — |
| 6 | Conventions | ✓ | — |
| 7 | Code quality | ✓ | — |
| 8 | Operability | △ | — |
| | **Total / 16** | **14** | **—** |

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

### Claude Code — Phase 0

_Pending — run next, then verify + score._

### Phase 0 verdict

_Pending Claude Code side._
