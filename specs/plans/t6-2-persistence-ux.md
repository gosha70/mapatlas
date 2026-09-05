# T6.2 — Persistence UX

> Bars set 2026-09-05, **before implementation**, against `main` at `3367df0`. Revised after
> review: four platform claims in the first draft were wrong or incomplete, and one of them —
> the order of installing and downloading — would have produced guidance that loses the user's
> data. Sources are cited inline because these are exactly the facts that get restated from
> memory and drift.

## Scope, and it is small

`tasks.md` T6.2 is one sentence: *"`navigator.storage.persist()` + install prompt guidance in the
demo."* That is the whole task.

**Demo-only. No published API change.** Everything this task touches is `navigator.*`, callable
by any consumer. The engine ships no UI, so there is nothing for it to wrap, and wrapping a
browser API it does not otherwise need would be the first time it did so.

### Ruled out, with the ruling recorded so it is not re-proposed

| Excluded | Why |
| --- | --- |
| **Eviction-aware re-download** | Out of T6.2. No `verify()`, no `isComplete()`, no invented task. `architecture.md` §4 claims the capability and nothing implements it — that is a **spec defect to correct** (increment 0), not a promise T6.2 inherits. A future capability needs its own accepted requirement. |
| **Quota display** | Out. `MapAssetStore.estimateBytes()` is complete and tested in both implementations. Neither T6.2 nor T7.1 requires UI for it. |
| **Download resume** | Out and unscheduled. **Complete rollback is preserved.** It is a reviewed guarantee with a test and a mutation behind it; resume is a contract reversal, not a refinement. |
| **`beforeinstallprompt`, manifest, icons, service worker** | Out. `beforeinstallprompt` is non-standard, Chromium-only and unavailable on iOS ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/BeforeInstallPromptEvent)). App-shell installation and offline packaging are **T7.1's**, and ADR-0035 already narrowed Phase 6 to *map data* offline. |

## Increment 0 — reconcile the eviction language

**Its own commit, landing before any persistence code.** Same branch and PR; a separate SHA,
because it corrects the engine's record rather than building the demo-only feature.

**The defect.** Automatic eviction removes an origin's data **together** — IndexedDB, Cache API,
all of it ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)).
The browser therefore cannot normally evict a region's archive while leaving its manifest, and
cannot evict map assets "first" under pressure. Two separate IndexedDB *databases* do not change
this. ADR-0016 says so itself and then contradicts it one sentence earlier.

`MissingArchiveError` **keeps its type and its throw condition** — the same class, thrown from
the same place on the same state. Its *message* does change, and that is runtime behaviour a
consumer can read, which is why the bar below is not "prose-only". It remains reachable through
partial deletion, corruption, a consumer holding a key and calling `delete()`, and externally
manipulated storage. What must stop is **attributing it to browser eviction**.

### What changes, by site

| Site | Wrong because |
| --- | --- |
| `specs/decisions.md:199` (ADR-0016) | *"Map assets can be evicted first under pressure, which is the correct priority"* — directly contradicted by its own next sentence, *"Browsers still evict per origin"*. The **authoritative** contradiction, and the root the others inherit. |
| `specs/architecture.md:136` | *"supports eviction-aware re-download"* — an unimplemented capability, exposed by no interface. Remove it, or mark it explicitly unbuilt with no owning task. This is the claim that would otherwise become T6.2's scope by inheritance. |
| `specs/api.md:840` | `MissingArchiveError` *"evicted (ADR-0016) or deleted"*. |
| `specs/decisions.md:1062` (ADR-0035) | *"assets are evictable (ADR-0016), so a manifest can outlive its bytes"*. |
| `packages/offline-pmtiles/src/archive-source.ts:13` | *"a browser reclaiming quota can take an archive while its manifest survives"*. |
| `packages/offline-pmtiles/src/archive-source.ts:25` | The **thrown message**: *"the bytes were evicted or deleted after download"*. |
| `packages/offline-pmtiles/src/archive-source.test.ts:127` | The test comment asserting the same reachability story. |

### Inventoried and deliberately kept

The rest of the `evict*` hits describe **consumer-driven** eviction or correctly state the
per-origin rule, and changing them would replace an accurate statement with a vaguer one:

- `specs/architecture.md:45`, `:111`, `specs/api.md:769`, `packages/core/src/storage.ts:50` —
  "lifecycle isolation, not quota isolation, since browsers evict per origin". Correct as written.
- `packages/storage-idb/src/schema.ts:12` — "a device under storage pressure can still take
  both… what lets a consumer evict the replaceable half **deliberately**". Correct, and the
  clearest statement of the distinction in the repo.
- `packages/storage-idb/src/map-asset-store.ts:16`, `packages/storage-idb/src/index.ts:8`,
  `specs/architecture.md:108`, `packages/core/src/storage.ts:47`, `specs/api.md:767` — "the right
  thing to evict first" / "replaceable, and evictable", each about consumer priority and each
  qualified nearby. Reviewed, kept.
- `specs/decisions.md:42` (ADR-0004) — "per-region size accounting/eviction" means the store's
  own `delete`. Correct.

**No new ADR.** Correcting ADR-0016 and ADR-0035 in place is sufficient; nothing is being decided.

### The bar for increment 0

**Not "prose-only" — the thrown message is observable.** `MissingArchiveError.message` is runtime
behaviour a consumer can read and a test can assert. The honest statement of the constraint is:

> **No control-flow, storage, or interface-shape change.** No branch, no key, no store call, no
> exported name, no type. One diagnostic string changes, and the comments around it.

And because a string that nothing asserts drifts back:

- **A test pins the message**, asserting it names deletion and the remedy and does **not** attribute
  the state to browser eviction.
- **Required mutation:** restore the old wording → that test goes red. Without it, the correction
  is a comment that the next session reverts in good faith.
- The existing missing-archive test must still go red under **the same mutation as before**. If a
  comment-and-string edit changed what a behavioural test proves, something other than comments
  changed.

## The platform facts this is built on — verified, not remembered

Four of these contradict the first draft. They are written out because a plan that gets them
wrong produces a demo that lies to its user about their data.

1. **`persist()` is a request; its *result* is honest.** Returns a boolean, may be denied
   ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/persist)).
2. **A granted origin is excluded from automatic eviction.** WebKit's words: origins "in
   persistent mode" are "excluded from eviction"
   ([WebKit](https://webkit.org/blog/14403/updates-to-storage-policy/)); MDN says persistent
   origins are skipped by the LRU pass. **The demo must not say granted data may still be
   pressure-evicted.** The true residual risks are that the *user* can still clear it, and that
   later writes can still fail on quota.
3. **Three grant models, and two never prompt.** Firefox shows a permission popup; Chrome and
   Edge auto-grant or **silently deny** on engagement heuristics; Safari/WebKit auto-decides on
   heuristics too. A denial is a normal answer, not an error.
4. **Ask on a gesture, never on load** — request at the moment critical data is saved, wrapped in
   a user action, precisely because Firefox will prompt.
5. **iOS quota — the first draft was wrong.** Safari *already* has the browser-app quota (~60% of
   disk) and a Home Screen web app gets *"the same origin quota and overall quota as when it is
   opened in a browser app"*. The ~15% figure is non-browser apps embedding a WebView
   ([WebKit](https://webkit.org/blog/14403/updates-to-storage-policy/)). **Installing is not a
   quota upgrade.**
6. **Installing changes the storage *context*, and this is the fact that shapes the guidance.**
   A Home Screen web app's data *"is kept isolated from Safari"*
   ([WebKit](https://webkit.org/tracking-prevention/)), and since iOS/iPadOS 17.2 installation
   copies **cookies only** — *"No other kind of local storage is copied over"*
   ([WebKit](https://webkit.org/blog/14787/webkit-features-in-safari-17-2/)). So a region
   downloaded in Safari **does not follow the app onto the Home Screen**. The installed app opens
   on an empty store and downloads again.
7. **What installing on iOS does buy:** the first-party domain of a Home Screen web app is
   *"exempt from ITP's 7-day cap on all script-writable storage"*
   ([WebKit](https://webkit.org/tracking-prevention/)), and WebKit grants persistence "based on
   heuristics like whether the website is opened as a Home Screen Web App" — so installing
   removes the inactivity clock and makes a grant more likely. That, not quota, is why
   `architecture.md` §5 couples install with `persist()`.
8. **Installation is manual on iOS and needs no manifest.** Share → Add to Home Screen. As of
   Safari 26 *"every website added to the Home Screen opens as a web app"* and *"there are now
   zero requirements for 'installability' in Safari"*
   ([WebKit](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/)).
9. **`127.0.0.1` is a secure context**, so plain HTTP does not prevent local testing
   ([Secure Contexts](https://w3c.github.io/webappsec-secure-contexts/)). No claim to the
   contrary may appear in the demo, the guidance, or the harness.

## Increment 1 — the persistence control in the demo

### Where it goes, and what it must not touch

The demo's root route currently renders one line pointing at `/lab`. **The control replaces only
that non-`/lab` pointer.** The `/lab` route, `mountLab`, and everything the T6.1 fixture and its
scenarios depend on are **untouched** — `lab.e2e.ts`, `render-differential.e2e.ts`,
`performance-baseline.e2e.ts` and `offline-region.e2e.ts` all drive `/lab`, and a change there
would put T6.1's merged evidence at risk for a feature that has nothing to do with it.

### Required behaviour

- **`persisted()` before `persist()`.** Render the current status before any request is possible.
  A control offering to request persistence the origin already has asks the user to fix a
  non-problem.
- **`persist()` only from an explicit user action** — a click on a **native `<button>`**, never on
  load, never in bootstrap. Native because it must be keyboard-reachable and focusable by default
  and must carry real activation semantics; a `<div>` with a click handler is neither, and the
  repo's accessibility guardrail already requires the first two.
- **Repeated activation is guarded.** One in-flight request at a time: the button is disabled
  while a request is outstanding and a second click cannot start a second one. Firefox prompts,
  so a control that fires twice prompts twice.
- **`persist()`'s boolean is the answer** for granted and denied. It is not re-read afterwards,
  and an earlier draft of this plan was wrong to require that: the two methods cannot disagree.
  WHATWG defines both against the same state — `persisted()` is *"true if shelf's bucket
  map["default"]'s mode is 'persistent'"*, and `persist()` resolves on that same mode after
  attempting to set it ([Storage Standard](https://storage.spec.whatwg.org/#dom-storagemanager-persist),
  [MDN](https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/persist)). A test built on
  a stub where they differ would be testing a non-conforming browser, not this code.
- **Five outcomes, each rendered accurately and distinguishably:** already persistent · granted ·
  denied · unsupported (`navigator.storage` or its methods absent) · error (the promise rejected).
  **Denied is the common case** in Chrome for a site with no engagement history, so it must read
  as a normal answer.
- **Say what persistence covers.** The **whole origin in the current storage context** — tracks,
  events, media *and* map assets together. ADR-0016's split is lifecycle and blast radius, not
  quota; a control implying it protects "your downloaded regions" alone would misdescribe both
  the API and the ADR. "Whole origin" means *this* context: it does not mean data migrates
  between Safari and an installed app (fact 6).
- **Say what a grant does and does not buy.** Excluded from automatic eviction; still clearable by
  the user; later writes can still fail on quota.

### The seam

The control takes a **narrow internal dependency** for its storage calls — the two methods it
uses, `persisted()` and `persist()` — defaulting to `navigator.storage`. Internal to the demo,
**not** a published engine interface.

This is what makes the branches deterministic. Any one run reaches one outcome, and the profile
the browser lane runs on supports the API and does not reject — so `unsupported` and `error` are
never exercised naturally *here*. They are real states that real browsers produce; the point is
that nothing in this repo's lanes produces them on demand, so without a seam they would be
unexercised code rendering whatever it happens to render. Stubbing `navigator.storage` globally
would work too, and is worse: it mutates a global the rest of the page shares.

**The seam's "absent" value is `null`, not `undefined`.** A default parameter is applied when a
caller passes `undefined` explicitly, so injecting `undefined` injects nothing — it falls
through to the ambient `navigator` and the test then passes or fails on whatever the environment
happens to support, which is not a test of this code at all. The unsupported test proves the
difference by putting a *working* API on `navigator` and still asserting `unsupported`.

## Increment 2 — installation guidance

**Static guidance. No code that detects, triggers, or advertises installability.**

- **Browser-neutral.** Describe the manual path — the browser's share or menu affordance, then
  "add to Home Screen" / "install" — without freezing an exhaustive browser-and-version list. As
  of Safari 26 there are no installability requirements at all, and an enumerated list dates
  immediately.
- **Order matters, and it is the headline.** On iOS: **install first, open the installed app,
  then download regions and request persistence there.** The installed app has its own isolated
  store and installation copies cookies only, so a region downloaded in Safari beforehand is not
  carried over (fact 6). Guidance that says "download a region, then add to Home Screen" tells the
  user to throw the download away.
- **State the actual benefit:** exemption from the 7-day script-writable-storage cap, and a better
  chance of a persistence grant. **Not** a quota increase.
- No `beforeinstallprompt`. No manifest, icons or service worker — T7.1's.

## What will be got wrong

**A test that asserts persistence works.** It cannot exist. Whether a browser grants persistence
is a heuristic decision by three different engines, one of which asks a human. A test that calls
`persist()` and asserts `true` is asserting Chromium's engagement heuristics about a Playwright
page — it passes or fails for reasons unrelated to this code, and when it passes it reads as
evidence that persistence works.

This is T6.2's version of *"zero network requests is not evidence"*: the obvious test looks like
proof of the thing and is proof of the harness.

### What is falsifiable, and is therefore what gets asserted

**Unit, through the seam** — the branches, deterministically:

- **No persistence request before the gesture.** Mount, settle, assert zero calls.
- **Exactly one after it.** Not "at least one".
- **A second click while one is in flight starts nothing.**
- **All five outcomes render distinguishably**, each driven by the seam.
- **The rendered text does not overstate a grant** — no "safe forever", nothing scoped to regions
  when the API is origin-wide.

**Browser, on the real page** — the wiring, which the unit lane cannot see:

- The control is **reachable on the demo's root route** and is a real button: focusable and
  operable by keyboard.
- **The gesture is a real user gesture**, not a synthetic dispatch — the unit lane can invoke a
  handler that a real click could never reach.
- **The native call is counted, by wrapping and forwarding it.** In the isolated Playwright page,
  replace `navigator.storage.persist` with a counting wrapper that **calls the original and
  returns its result** — the browser still decides, nothing is faked. Then: **zero calls before
  the gesture, exactly one after.** Merely recording whatever the UI displayed would pass just as
  well against a hard-coded outcome that never touched `navigator.storage` at all, which is the
  hole this closes.
- **The UI reaches one of the allowed results** — granted or denied — and **which** boolean
  Chromium returns is not asserted. That is the heuristic this plan refuses to test.
- **`/lab` is unchanged**: the existing scenarios stay green, which is the assertion that this
  increment did not touch T6.1's evidence.

## Required mutations

- the request fires on load instead of on the gesture → the before-gesture assertion fails;
- one activation fires the request twice → the exactly-one assertion fails;
- the in-flight guard is removed → the second-click assertion fails;
- `persisted()` is not checked first, so an already-persistent origin is offered the request →
  the already-persistent branch fails;
- the control renders a fixed outcome without calling `navigator.storage` at all → the browser
  lane's call count is zero after the gesture, where recording the displayed text alone would
  have passed;
- denied and unsupported render the same text → the outcome assertions fail;
- an error is rendered as a denial → same;
- the button becomes a `<div>` with a click handler → the keyboard-operability assertion fails;
- increment 0's message is restored to its eviction wording → the message test fails;
- increment 0's edits change more than comments and one string → the missing-archive test must
  still go red under the same mutation it did before.

## Scope fence

The demo's root-route persistence control, its five outcomes, and static installation guidance.
**Eviction detection, re-download, quota UI, resume, and anything PWA-shaped are out**, per the
ruling above. No file under `packages/` changes except increment 0's corrections, and no file
under `apps/demo/src/lab/` changes at all.
