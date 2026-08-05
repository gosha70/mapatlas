<!-- SPDX-License-Identifier: Apache-2.0 -->

# MAP-ATLAS — build manifest

> This file is the **Claude Code** entry point. It is a thin adapter over the
> harness-neutral source of truth in [`specs/`](specs/). Any other build harness
> (e.g. a pi.dev-based one) should read `specs/` directly — the specs are written to be
> harness-agnostic so the *same* brief can drive different builders and be compared.

## What you are building

MAP-ATLAS: an open-source, **domain-agnostic** engine for interactive field mapping —
record a GPS track, drop an event where it happened, attach a comment and photos, and
optionally run a **pluggable** AI analyzer over those photos. The engine has **no domain
knowledge** (no fish, plants, mushrooms, products, users, or database). Read
[`specs/PRD.md`](specs/PRD.md) first.

## Read in this order

1. [`specs/PRD.md`](specs/PRD.md) — what and for whom; scope and non-goals.
2. [`specs/architecture.md`](specs/architecture.md) — packages, module boundaries, data model, seams.
3. [`specs/api.md`](specs/api.md) — the public API contract to build against.
4. [`specs/roadmap.md`](specs/roadmap.md) — phase order.
5. [`specs/tasks.md`](specs/tasks.md) — pick the next unblocked task; each has acceptance criteria.
6. [`specs/decisions.md`](specs/decisions.md) — the ADR log; append to it when you decide something consequential.

## How to work (autonomous-friendly)

- Work **task by task** from `specs/tasks.md`, respecting the phase order in `specs/roadmap.md`.
- Build **against the interfaces** in `specs/api.md`. If you must change a public interface,
  update `specs/api.md` in the same change and record an ADR in `specs/decisions.md`.
- After each task: run the gates (below), and stop only when they pass.
- Prefer small, reviewable commits; **DCO sign-off** every commit (`git commit -s`), and put
  `// SPDX-License-Identifier: Apache-2.0` at the top of every source file.
- Do **not** ask for input you can derive from the specs. Escalate only on a genuine
  contradiction in the specs or a decision the specs explicitly defer to the owner.

## The one architectural rule (non-negotiable)

Dependencies point one way: **consumers depend on MAP-ATLAS; MAP-ATLAS depends on nothing
consumer-specific.** No fish/plant/mushroom/product/auth/DB concept may enter any package
here. Domain and privacy belong to the consuming app. Everything variable is behind an
interface: `MediaAnalyzer` (AI), `StorageAdapter` (persistence), `TrackRecorder` (geolocation),
`TileSource` (basemap). This is the property that makes the engine reusable — protect it.

## Intended stack (see architecture.md for rationale)

- TypeScript (strict), monorepo workspaces.
- `@mapatlas/core` (framework-agnostic) · `@mapatlas/leaflet` (renderer) ·
  `@mapatlas/react` (bindings) · `@mapatlas/storage-idb` (default persistence) ·
  `apps/demo` (a generic field-logger demo, no real domain).
- Offline: PMTiles regions; default IndexedDB storage.
- Tests: a fast unit runner (e.g. Vitest); seams tested with fakes, never live hardware.

## Gates (must pass before a task is "done")

Once the toolchain exists, these are authoritative:

```bash
npm install
npm run build         # all workspaces compile
npm run typecheck     # tsc --noEmit, strict
npm run lint
npm run test          # unit tests, seams mocked
```

Until the toolchain exists, the first tasks in `specs/tasks.md` are to create it — do those
first, then keep the gates green from then on.

## Guardrails

- No secrets, no bundled map tiles, no bundled ML models in the repo.
- No telemetry / network egress the consumer did not configure (see [`SECURITY.md`](SECURITY.md)).
- Accessibility: map controls keyboard-reachable, visible focus, respect `prefers-reduced-motion`.
- Document downstream data-license obligations (OSM/OpenSeaMap ODbL, NOAA public domain).
