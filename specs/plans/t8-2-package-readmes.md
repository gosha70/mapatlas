# T8.2 — per-package READMEs

> Bars set 2026-09-20, **before any candidate implementation**, against `main` at `987ac20` (the
> merge of PR #58). Every survey finding below was read out of the code at that commit, or produced
> by running a command, and says which; nothing is repeated forward from `tasks.md` or
> `CONTINUE.md` without having been checked against the code first.
>
> **Status: done, 2026-09-23** — increments 1 and 2 merged as PRs #63 and #64; the close-out is
> in `tasks.md`'s Done record. This document is history now, not a work plan. The owner approved
> three scope calls on 2026-09-20 — no per-package install commands; snippets compiled and not executed,
> with that limitation stated; the focus-ring block demoted and its missing oracle recorded — and
> held the plan for the two corrections below.
>
> **Amended 2026-09-20, in review, before any implementation.** Three corrections, each marked where
> it lands. The first two are the reviewer's; the third was found while making them.
>
> 1. *The six-package consumer boundary was unspecified* — and as first written, wrong: it put
>    every snippet in a project that installs five packages.
> 2. *Links must survive packing* — a README is read from a tarball, and `specs/api.md` is in none.
> 3. *A required mutation named an assertion that does not exist.* It said a workspace-resolved
>    snippet would fail "the nested-resolution assertion `check:packaging` already makes". `nested`
>    there is npm's install strategy; the example is kept off the workspace **by construction**,
>    and nothing goes red if that construction is undone. Mistake 7c, in this plan's own bars.

## The originating goal, restated

`tasks.md` T8.2, in full: every package ships a README; **every code block in one is checked** the
way `api.md` §0's are — mirrored from a compiled source or generated from this repository, via
`check:docs`; `check-packaging` asserts the README ships for **each** package rather than for one;
and a block that cannot be checked is not presented as something to copy.

Three acceptance criteria, then, and one prohibition. Everything below is mapped to one of them or
is not in this plan.

## What is settled — cite, do not re-open

1. **Nothing is published, and that is a decision, not an omission.** ADR-0042 exits Phase 7 on a
   build-from-source reading of `PRD.md` §6; publishing is post-v1 in `roadmap.md`. A README written
   today is read from the repository or from a tarball built from it — not from a registry listing.
2. **A consumer-facing example is built as a packed consumer, never through the workspace.**
   ADR-0041. No `paths` entry, project reference or vite alias may stand in for the packed package.
3. **Mirrors and projections are the two kinds of checked content** (`check-docs.mjs`). A mirror is
   a fenced block that is a file, byte for byte; a projection is a generated region rendered from a
   repository fact. `--write` reprojects and never touches a mirror.
4. **Generation makes a block impossible to drift; it does not make it correct.** `CONTINUE.md`
   mistake 7d: T7.2's install block matched its projection byte for byte and was wrong twice. A
   command in a document is a claim, and the check is running it.
5. **T8.2 is post-v1 and adds no product.** It documents what the packages already export.

## Survey — what the repository has, at `987ac20`

Five findings. The first two confirm `tasks.md`; the other three **correct** it, and the plan turns
on the corrections.

1. **Confirmed: five of six packages have no README.** `core`, `recorder-web`, `react`,
   `storage-idb`, `offline-pmtiles` — none. `maplibre` has one, 89 lines, four fenced blocks.
   (`ls`, per package.)
2. **Confirmed: `check-packaging.mjs` asserts one README, by existence.** Lines 243–245 test
   `node_modules/@mapatlas/maplibre/README.md` and nothing else.
3. **Corrected: `check:docs`'s rules are *not* all per-document.** `tasks.md` and `CONTINUE.md` both
   say the mechanism exists and is per-document. **Projections are** — `check-docs.mjs` holds a
   `documents` list. **Mirrors are not**: `docs-drift.mjs` exports one `DOCUMENT`
   (`specs/api.md`) and one `SECTION` (`## 0. Quick start`), `blocksInSection` requires a heading,
   and `check-docs.mjs` calls `driftBetween` exactly once. The half of the mechanism T8.2 needs
   most has one customer hard-wired.
4. **Corrected: the packaging gate does not pack six packages.** `consumer-project.mjs`'s
   `PACKAGES` lists five; `packages/offline-pmtiles` is absent, because `PACKAGES` is the
   quick-start example's publish graph and the example does not use it. **And `PACKAGES` also
   renders `api.md` §0's generated install block** — so adding the sixth package there would tell
   every quick-start reader to install something the example never imports.
5. **Found: the one existing README fails its own task's prohibition twice.**
   - Its install block is `npm install @mapatlas/maplibre maplibre-gl@6.6.0`. **Run, it fails:**
     `npm view @mapatlas/maplibre` returns `E404`, as does `@mapatlas/core`. It is presented as
     something to copy and cannot be.
   - Its CSS block sets `--mapatlas-focus-ring-color`. The property is real
     (`draw-mode.ts:90`–`91`, default `#0969da`, as the README says) — and **nothing in the
     repository exercises it**: the only two files naming it are that source file and the README.
     No unit test, no browser scenario. It documents a feature that has no oracle.

6. **Found in review: there is one packed consumer project, it installs five packages, and two
   lanes share it.** `createConsumerProject` packs through `packWorkspacePackages`, which maps over
   `PACKAGES` and takes no list of its own; `check-packaging.mjs:161` and `serve-example.mjs:49`
   both call it, which is what makes the project the gate compiles and the project the browser
   lane runs the same project. An `@mapatlas/offline-pmtiles` import cannot resolve in it, and
   packing that package separately to read its file list would not change that. Adding the sixth
   tarball to it would change the dependency graph of **both** quick-start lanes to serve a
   different document.

And what the compiled sources available for mirroring actually cover: `examples/quick-start`
imports `@mapatlas/core` (types), `@mapatlas/react`, `@mapatlas/storage-idb`, and `maplibre-gl`'s
stylesheet and worker. It imports **nothing** from `@mapatlas/recorder-web` or
`@mapatlas/offline-pmtiles`, and nothing from `@mapatlas/maplibre`'s own surface. Its files are
whole programs of 31–191 lines; the mirror rule is whole-file. **No README-sized compiled source
exists for any package.**

## The bar this task turns on

**"Checked the way `api.md` §0's are" has two halves, and a README can meet one of them.** §0's
blocks are *mirrored from a source that compiles against the packed packages* — and that example
is then *run in a browser*. The first half is a property of the block. The second is a property of
the one example, and repeating it six times would mean six browser scenarios for a documentation
task.

So the bar is: **every fenced block in a package README is the bytes of a file that
`check:packaging` compiles against the packed tarballs, or is a generated region.** Compiled, not
executed. That is weaker than §0, deliberately, and each README says where the executed path is
(`api.md` §0) rather than implying it is one.

**And no package README carries an install command.** This is the plan's most contestable call, so
the argument is here rather than in a bullet:

- The only install command that works today is §0's — pack from a checkout — and it is already
  generated, already checked, and already *executed* by two lanes. Six per-package variants would
  each need their own publish-graph closure and, by settled item 4, would each need **running** to
  be believed. That is six pack-and-install runs to restate one block.
- The registry form, `npm install @mapatlas/x`, fails today. By T8.2's own prohibition it may not
  be presented.
- So each README states in one sentence that the packages are not published, and links to the one
  install path that is checked. What *is* package-specific and checkable — peer dependencies and
  their declared versions — is a **projection** from that package's `package.json`.
- **Those links have to survive packing** *(amendment 2)*. Settled item 1 says these READMEs are
  read from a tarball, and a tarball holds `dist`, `package.json` and the README — not `specs/`.
  `../../specs/api.md` works in the checkout and is a dead link for exactly the consumer this task
  serves. So every link in a package README is either an **absolute repository URL** or resolves
  to a file **inside that package's own tarball**. The existing `maplibre` README already does
  this for `SECURITY.md`, and then names `specs/architecture.md` as bare text; both are brought
  under the rule.
- When publishing happens, the install block becomes checkable against a registry, and the release
  task ADR-0042 already describes is where it belongs.

## Scope fence

In:

- the mirror rule made per-document (finding 3);
- **an all-package inventory, distinct from `PACKAGES`** *(amendment 1)*. `PACKAGES` means "the
  quick-start example's publish graph" and keeps meaning that. The inventory means "every package
  this repository would publish", and it is **asserted against `packages/*`** — a seventh package
  added without a README, or one dropped from the list, fails rather than being silently
  uncovered. One inventory drives three things, so they cannot disagree about what "each package"
  is: the README documents `check:docs` claims, the tarball checks, and the snippet project;
- one small compiled snippet file per README code block, under `examples/readme/<package>/`;
- **a second, isolated packed consumer project for those snippets** *(amendment 1)*: all six
  tarballs packed and installed **together**, `--install-strategy=nested` as the first project is,
  every snippet copied in, compiled by the project's **own** `typescript` under its **own**
  `tsconfig.json` with no `paths`, no project reference and no alias, in a scratch directory
  outside the workspace. It shares the *helpers* with the quick-start project and nothing else.
  **The existing five-package project is not touched**: not its package list, not its
  dependencies, not the graph either of its two lanes resolves;
- six READMEs, each: what the package is, the not-published sentence and link, its peer
  dependencies as a projection where it has any, **one** minimal usage block, a pointer to its
  `api.md` section, licence;
- `check:packaging` asserting a README inside **each** of six packed packages, by name, read from
  the snippet project's installed tree — the same six tarballs, packed once;
- every README link absolute or tarball-local *(amendment 2)*;
- bringing `maplibre`'s README under the same gate, which means resolving finding 5.

Out, and why:

- **Per-package install blocks** — argued above.
- **Executing README snippets** — argued above.
- **An oracle for `--mapatlas-focus-ring-color`.** It is a gap in `@mapatlas/maplibre`'s tests, not
  in its documentation. T8.2's prohibition decides what the README does about it — the block is
  demoted to prose naming the property, not presented as code to copy — and the missing oracle is
  **reported** as a finding for the owner rather than quietly built inside a docs task.
- **API reference in READMEs.** `api.md` is the contract; a README that restates it is a second
  copy that drifts. One usage block and a link.
- **Adding `offline-pmtiles` to `PACKAGES`, or a sixth tarball to the quick-start project** — the
  first would change §0's install block (finding 4), the second the graph both quick-start lanes
  resolve (finding 6).
- **An explicit resolution assertion for the quick-start project.** Amendment 3 found it has none;
  this plan gives the *snippet* project one and **reports** the gap in the older project rather
  than widening a docs task to close it.
- **Publishing, versioning, `LICENSE` files in tarballs, badges.** Release work.

## Increments, and the argument for this order

**Increment 1 — the mechanism, proven on the README that exists.** Make the mirror rule
per-document; stand up the inventory and the six-tarball snippet project; bring
`packages/maplibre/README.md` under both. The project is built for six from the start, holding one
package's snippets — so the boundary is proven before five READMEs depend on it, and increment 2
adds files rather than infrastructure. That README has four blocks, and they
are the four cases: a command that fails (removed, replaced by the sentence and link), a snippet
with a bundler-specific import (mirrored from a new compiled file), an unchecked CSS claim
(demoted), and a plain import (mirrored). One package, end to end, before five more are written
against a gate that might not hold. No new README yet.

**Increment 2 — the five READMEs, and the packaging assertion.** Snippets first, compiled; then
the READMEs that mirror them; then `check:packaging` asserts all six. The six-package assertion is
written to go **red first**, against the tree as it stands, so that it is known to be able to fail.

~~The assertion reads each package's own `npm pack --json` file list rather than an installed
tree.~~ *(Struck by amendment 1.)* It reads the snippet project's installed tree, where all six
tarballs already are: one pack per package, serving the snippets and the README check alike, and
the same kind of fact the existing `maplibre` assertion reads. Finding 4 stays harmless for the
reason that matters — nothing is added to `PACKAGES`.

**Increment 3 — close-out.** `tasks.md` Done record with one bullet per criterion; `CONTINUE.md`;
the root README's one link to `packages/maplibre/README.md` reviewed against what that file now
says.

## Bars

- `npm run verify` and `npm run test:browser` exit 0 at the end of every increment.
- Every fenced block in every `packages/*/README.md` names a file under that package's
  `examples/readme/<package>/`, and is its bytes; or sits inside a generated region.
- Every file under `examples/readme/` appears in its package's README — no compiled snippet that
  documents nothing.
- Every snippet compiles against the **packed** packages, in the six-tarball snippet project, and
  **every `@mapatlas/*` module the compiler loaded came from that project's `node_modules`** —
  asserted from the compiler's own file list, none of it under this repository's `packages/`.
- The quick-start project's package list, dependency list and resolved graph are byte-for-byte
  what they were at `987ac20`; `api.md` §0's generated install block does not change.
- The inventory equals `packages/*`, asserted; six packages, six READMEs, each checked by name.
- Every link in every package README is an absolute URL or a path to a file in that package's
  tarball.
- No README presents a command that fails when run at `987ac20`'s state of the world.

## What will be got wrong

- **Writing the READMEs first.** The prose is the easy part and the tempting one. A README written
  before its snippet compiles is 7c: code repeated forward from an interface.
- **A snippet that compiles through the workspace.** If `examples/readme` resolves `@mapatlas/*`
  by a `paths` entry or hoisting, it proves the snippet works *here*. ADR-0041 exists because this
  already happened once.
- **Reaching for the project that is already there.** It is one function call away and it is the
  wrong project: five packages, and shared with a browser lane whose graph is part of what it
  proves. This plan made that mistake in its first draft.
- **Two lists of six.** An inventory for the docs gate and another for the packaging gate would
  agree on the day they were written. One, asserted against the directory.
- **Generalising the mirror gate into a framework.** It needs a list of documents, each with its
  set of mirrorable files. It does not need a plugin model, a config file, or per-block options.
- **Loosening rule 4 to make READMEs fit.** "Every file of the mirrored set appears" must hold per
  document exactly as it does for §0; the set is smaller, the rule is the same.
- **Treating `check:docs` green as the READMEs being right.** Mistake 1. The gate holds bytes to
  files; whether a snippet is a *useful* first thing to show is a review question, and is named as
  one in each increment's handoff.
- **Fixing finding 5's missing oracle because it is nearby.** It is reported, not absorbed.

## Required mutations

Each must turn a named assertion red:

- a README block edited alone, its snippet untouched → `check:docs` fails, naming the package;
- a snippet edited alone → the same, in the other direction;
- a README block with no file named → fails rule 1, in a README and not only in `api.md`;
- a README block naming a file outside its own package's snippet directory → fails rule 2;
- a snippet file added and shown nowhere → fails rule 4;
- a snippet that uses an export the packed package does not have → `check:packaging` fails to
  compile it;
- ~~a snippet resolved through the workspace rather than the tarball → the nested-resolution
  assertion `check:packaging` already makes for the example fails for the snippets too;~~
  *(Struck by amendment 3: no such assertion exists.)* a `paths` entry added to the snippet
  project's `tsconfig.json`, pointing `@mapatlas/*` at `packages/*/src` → the snippets still
  compile, and the **file-list assertion** fails, naming a module loaded from the repository;
- `offline-pmtiles` dropped from the snippet project's tarballs → its snippet fails to compile.
  This is the mutation that shows the project really is six and not five;
- a package added under `packages/` and not to the inventory, or removed from the inventory alone
  → the inventory assertion fails, in `check:docs` and in `check:packaging`;
- the sixth tarball added to the *quick-start* project instead → the unchanged-graph bar fails;
- a README link written `../../specs/api.md` → the link rule fails, naming the README and the
  link. It resolves in the checkout, which is why it needs a rule rather than a reviewer;
- one package's README deleted → `check:packaging` fails **naming that package**, and the other
  five still pass;
- the per-document list reduced to `api.md` alone → a test that the gate claims six READMEs fails.
  This is the one that guards against the gate passing for the wrong reason: six READMEs and a
  gate that reads one of them is exactly where this task started.

## What can be removed without weakening the criteria

Asked before review, as the conventions require. Already removed: six install projections, snippet
execution, the focus-ring oracle, any API reference. What remains maps one to one: the per-document
mirror rule → criterion 2; the snippet files → criterion 2's "compiled source"; the READMEs →
criterion 1; the six-tarball assertion → criterion 3; the `maplibre` rework → the prohibition.

Added in review, and each traced to a concrete failure rather than to tidiness: the **second
project** → without it one package's snippets cannot compile at all (finding 6); the **inventory**
→ criterion 3 says "each package", and two hand-kept lists of six is how `PACKAGES` came to be
five; the **file-list assertion** → the alternative is the protection the quick-start project has,
which amendment 3 found nothing would notice losing; the **link rule** → a relative link is green
in every gate and dead for the reader. The cost is one more pack-and-install in `check:packaging`,
stated here so it is a known price and not a surprise in CI time.

The peer-dependency projection is the one remaining item that a stricter reading could cut. Two
packages declare a peer at `987ac20` — `@mapatlas/maplibre` (`maplibre-gl` `6.6.0`, exact) and
`@mapatlas/react` (`react` `>=18`, a range) — so it is one generated line in each of two READMEs.
It stays because the alternative is those two constraints typed by hand in prose, one of them an
exact pin the packaging gate enforces — which is how the root README came to say "Phase 0
complete" through seven phases.
