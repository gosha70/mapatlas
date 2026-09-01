# T4.7 — interaction and accessibility

> Bars set 2026-09-01, **before any code**, from a survey of `main` at `aa5c779`.

## What this task is

**An audit, not a build.** The survey found T4.7's behaviour already delivered — most of it by
the draw-mode work merged earlier in Phase 4. Shaping this as a feature increment would mean
rebuilding what exists and reporting the rebuild as progress.

So the work is: map every clause of the acceptance criteria to the implementation and the
evidence that discharges it, classify each `discharged` / `partial` / `missing`, and write code
only for what the audit finds genuinely missing.

**One assumption in the backlog is already false, and it is not to be "fixed".** T4.7's summary
says it *"puts `createMapController` on the package barrel"*. That already happened:
`packages/maplibre/src/index.ts` exports it today, because **T4.6 required it** — `/lab` is
assembled from package entry points only, so the vertical fixture could not exist without the
barrel export. The repository evolved in a different order from the one the backlog anticipated.
That is recorded here as a fact about history; the export is not touched to make the sequencing
match a superseded assumption.

## The deferred obligation this task discharges

`specs/tasks.md` says, of the draft-vertex accessibility check:

> The a11y check runs against the browser harness page, not the demo shell. The demo shell is
> T4.6's `/lab` route, and T4.6 waits on the region input, so an exit criterion naming it could
> not be satisfied in this order. T4.6 re-runs the same check against `/lab` when it exists.

`/lab` now exists. **T4.6 is not reopened**: it is correctly closed on its own principal
acceptance work, and this is a cross-task obligation that was deferred by the backlog itself and
is discharged here. The provenance is recorded rather than backdated.

### "The same check" means the same check

Re-running it does **not** license a new accessibility engine. No `@axe-core/playwright`, no new
dependency, no WCAG-conformance claim. Adding one would silently convert T4.7 from *"prove these
named interaction and accessibility contracts"* into *"run an accessibility-standard scan"* —
which brings a rule-set version, an exceptions policy, and findings about things nobody scoped.
If the audit finds a clause that genuinely cannot be tested without an accessibility-tree engine,
that is a finding to record, not a licence to add one here.

### Both checks are kept, because they prove different things

The harness page proves the **engine** behaves, in isolation, against a controller built for the
test. `/lab` proves the **shipped composition** did not break it — a consumer app assembled from
package entry points, with a real source stack around it. Replacing the first with the second
would trade an isolated proof for an integrated one; keeping both is the point.

## Bars

1. **Every AC clause maps to named evidence.** Not "the suite covers it" — a file, a test name,
   and what would have to break for that test to fail.
2. **Existing evidence is preserved, not re-manufactured.** Where a test already carries a
   meaningful negative control or a recorded mutation, the audit cites it. Inventing a second
   mutation to look thorough is noise, and it dilutes the mutations that mean something.
3. **The new `/lab` check must be shown to bite.** At least one mutation — remove keyboard
   reachability, or remove the visible focus ring — must turn it red. A new integration test
   that cannot fail is the thing this project keeps catching, and it would be worse here than
   elsewhere: an accessibility assertion that always passes is a claim nobody will re-examine.
4. **Code only for audit-discovered gaps.** If the engine behaviour is all delivered and only the
   `/lab` evidence is missing, T4.7 is a small increment. That is what it means for earlier work
   to have pulled functionality forward, and it gets reported that way rather than padded.
5. **DEM tile-size fidelity stays out.** It is a named follow-up on raster fidelity and has
   nothing to do with interaction or accessibility.

## The clauses to audit

From `specs/tasks.md`, T4.7's `_AC:_` and headline, split into the claims they actually make:

| # | clause |
| --- | --- |
| 1 | `prefers-reduced-motion` **reaches the camera**, through the seam, asserted in **both** states |
| 2 | the keyboard grab is released by drop, Escape, blur, **and** by a reconcile that removes the focused vertex — the last two asserted |
| 3 | draft vertices are focusable, tab-reachable, and carry an accessible name saying which vertex they are |
| 4 | vertices are operable by arrow keys at 1 px, and 10 px with Shift — the coarse step asserted, so dropping it fails |
| 5 | a tap on an event mark fires `onEventClick` **alone**, asserted in the unit lane and not only in the browser |
| 6 | that suppression is shown to fail without the implementation — a mark click may never reach the map at all, so the contract could hold for the wrong reason |
| 7 | a tap resolves in one order — draft vertex, then event mark, then map position — with both lanes asking the vertex question the same way, at the pointer |
| 8 | controls are keyboard-reachable with visible focus |
| 9 | `createMapController` is on the package barrel and `api.md`'s declaration is true |
| 10 | the accessibility check runs against `/lab`, not only the harness page |

## Audit

Checked against `main` at `aa5c779`. Nothing is marked `discharged` from a test's name — each
entry names what would have to break for the cited test to fail.

| # | verdict | evidence, and what breaks it |
| --- | --- | --- |
| 1 | **discharged** | `controller.test.ts` — *"reads reduced motion at each move and sends both states through the camera seam"*. Asserts `fitBounds` `animate` is `[true, false]` across the two states and that `recenter` produces `easeTo` then `jumpTo`. Wiring the query to a stylesheet instead of the seam, or reading it once at construction, fails it. |
| 2 | **discharged** | Blur: `controller.test.ts` — *"cancels a grab synchronously on blur"*. Reconcile-removal: the neighbouring test drives `renderDraft` with the focused vertex removed and asserts `blurCount === 0`, so **only** the explicit reconciliation cleanup can have released the grab — which is precisely the AC's "asserted, since neither is driven by the key handler under test". Escape and drop are covered in both lanes. |
| 3 | **discharged** | `map-controller.e2e.ts` — *"makes draft vertices one keyboard stop with visible, focus-scoped interaction"*. Exactly one `tabindex="0"` among three vertices, `aria-label` of `Draft vertex N of 3`, and focus reached by pressing real `Tab` from the canvas rather than asserted from attributes. |
| 4 | **discharged** | `controller.test.ts`, the Shift-modifier test. The fake projects 100 units per degree, so the coarse step is asserted **numerically** — `18.17` against the plain step's `18.07` in the neighbouring test. Dropping `KEYBOARD_NUDGE_LARGE_PX` yields `18.08` and fails. *(A first pass of this audit called the clause `partial` on the strength of an `aria-keyshortcuts` assertion; that was reading the weaker of the two assertions in the test.)* |
| 5 | **discharged** | `controller.test.ts` — *"fires an event click alone, with the DOM suppression carrying the contract"*, in the unit lane as the clause demands, alongside the browser test. |
| 6 | **discharged**, and the negative control is already recorded | That same test **builds** MapLibre's DOM relationship — a container listener that turns the click into a map tap — so the assertion can only pass because the wrapper suppression stopped it, not because the click never arrived. Per bar 2 this is cited, not re-mutated. |
| 7 | **discharged** | `controller.test.ts` — *"gives an overlapping draft vertex priority over an event mark"* and *"lets draw mode own an empty-map tap rather than reporting it twice"*, with `queriedPoints.at(-1)` asserting the vertex question was asked **at the pointer**. |
| 8 | **discharged** on the harness page | The e2e above reads `getComputedStyle` for `outlineStyle: "solid"` and `outlineWidth: "3px"` on the focused vertex — a computed ring, not a class name. |
| 9 | **discharged, and it predates this task** | `packages/maplibre/src/index.ts` exports `createMapController`; `apps/demo/src/lab/lab.ts` imports it by bare package name, and `npm run check:packaging` proves the package resolves for a consumer under a nested install. T4.6 needed all of this, which is why it is already true. |
| 10 | **missing** | No accessibility check has ever run against `/lab`. This is the one real gap. |

**Result: nine of ten clauses discharged before this task began.** T4.7 is therefore the small
increment the survey predicted — clause 10 and nothing else. That is what it looks like when
earlier work pulls functionality forward, and it is reported rather than padded.

## Closing clause 10

`/lab` renders a track, not a draft, and never enters draw mode — so there are no vertices on it
to check. The engine capability is already on the barrel and already proven in isolation; what is
missing is the **composition**. So `/lab` gains a `draw=on` view that renders a small draft and
enters draw mode through the same public calls a consumer would use, and the check runs against
it.

The `/lab` check asserts the same contract as the harness one: exactly one tab stop among the
vertices, an accessible name naming each vertex, focus reached through the browser's real tab
order, and a computed focus ring. It does not restate the engine's keyboard *mechanics* — those
are the harness page's job, and duplicating them would mean two tests failing for one cause.

### As built

`apps/demo/src/lab/lab.ts` gains `draw=on`: it renders a three-vertex draft near the recording's
first point, recentres on it, and enters draw mode with the handlers a consumer would write — a
move updates the draft the app owns and re-renders it. **Opt-in**, unlike the other view
parameters, because a route that entered draw mode by default would put a hand-authoring surface
in front of anyone opening `/lab` to look at the fixture. Draw mode is entered *last*, over a map
that already carries the sources, the track and the marks, since that composition is the subject.

`e2e/lab-a11y.e2e.ts` runs the check against it, under the shared console watch.

*Author verification — the new check bites, which bar 3 required.* Two mutations of the engine,
both killed:

| mutation | result |
| --- | --- |
| every vertex taken out of the tab order (`tabIndex = -1` for all, no roving index) | killed — the single-tab-stop assertion fails |
| the focus ring removed (`outline: none` where the focused vertex is styled) | killed — *"the focused vertex has no visible ring in the shipped composition"* |

Gates on this increment: `npm run verify` exit 0, `npm run test:browser` exit 0, 59 passed. The
harness-page check is untouched and still passes beside the new one.
