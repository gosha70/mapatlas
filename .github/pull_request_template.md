<!-- SPDX-License-Identifier: Apache-2.0 -->

## What & why

<!-- What does this change do, and which task/ADR in specs/ does it advance? -->

Relates to: <!-- specs/tasks.md task id, or specs/decisions.md ADR -->

## Checklist

- [ ] Commits are **DCO signed-off** (`git commit -s`)
- [ ] New/changed source files carry `// SPDX-License-Identifier: Apache-2.0`
- [ ] Builds **against** `specs/api.md` (no new public API without updating that file)
- [ ] **No domain leakage** into the core (no fish/plants/product/auth/db concepts)
- [ ] Tests added/updated; geolocation, storage, and analyzer seams use fakes
- [ ] No secrets, bundled tiles, or bundled models added
- [ ] Consequential decisions recorded in `specs/decisions.md`
