<!-- SPDX-License-Identifier: Apache-2.0 -->

# Contributing to MAP-ATLAS

Thanks for helping build a reusable field-mapping engine. This project is designed to be
built and extended by autonomous coding agents *and* humans, so the contract below is
deliberately explicit.

## The one architectural rule

**Dependencies point one way: consumers depend on MAP-ATLAS; MAP-ATLAS depends on
nothing consumer-specific.** No package here may reference a specific domain (fish,
plants, mushrooms), a specific product, private data, auth, or a database schema.
Domain and privacy live in the *consuming* app. A PR that leaks a domain concept into
the core will be asked to move it behind an interface (`MediaAnalyzer`, `StorageAdapter`).

## Developer Certificate of Origin (DCO)

We use the [DCO](https://developercertificate.org/) instead of a CLA. Every commit must
be signed off, certifying you have the right to submit it under Apache-2.0:

```
git commit -s -m "feat(core): add distance-interval sampler"
```

This appends a `Signed-off-by: Your Name <you@example.com>` trailer. PRs whose commits
are not signed off cannot be merged.

## Source-file header

Every source file starts with:

```ts
// SPDX-License-Identifier: Apache-2.0
```

## Working from the spec

The canonical, harness-neutral source of truth is [`specs/`](specs/). Before building:

1. Read [`specs/PRD.md`](specs/PRD.md) and [`specs/architecture.md`](specs/architecture.md).
2. Build **against** the interfaces in [`specs/api.md`](specs/api.md) — treat them as the contract.
3. Pick a task from [`specs/tasks.md`](specs/tasks.md); each has acceptance criteria.
4. Record any consequential decision as a new entry in [`specs/decisions.md`](specs/decisions.md).

## Conventions

- **TypeScript strict**; no `any` in public APIs.
- **Conventional Commits** (`feat:`, `fix:`, `docs:`, `chore:`, `test:`), scoped by package.
- **Tests** for every unit of logic; the geolocation, storage, and analyzer seams must be
  mockable and are tested with fakes, never live hardware.
- **No secrets, no bundled data, no bundled models** in the repo.
- **Accessibility**: interactive map controls are keyboard-reachable with visible focus.

## Branching & PRs

- Branch from `main`: `feat/…`, `fix/…`, `docs/…`.
- One logical change per PR; keep the public API surface changes isolated and documented.
- Fill in the PR template, including the DCO checkbox.
