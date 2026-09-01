# T5.1 — React hooks

> Bars set 2026-09-01, **before any code**, against `main` at `8f04cc8`.

## The survey says build, not audit

`packages/react/src/index.ts` is a placeholder — one exported `PACKAGE_NAME` constant and a
ten-line test. None of `useTrackRecorder`, `useEventLog` or `useOfflineRegions` exists. The
scaffolding is real: the package is in the workspace, depends on `core` and `maplibre`, declares
`react >= 18` as a **peer**, and React 19.2.8 is a root devDependency.

The audit-first habit that T4.7 justified returned the opposite answer here, which is the point
of running it: it can say "already done" or "nothing to salvage", and only one of those is a
surprise.

## Testing: Vitest with fakes, and no Testing Library yet

T5.1's acceptance criterion is *"tested with fakes"*. These hooks bind React state and effects to
**interfaces**, not to browser APIs — the browser lane stays reserved for behaviour only a real
browser has, which is T5.2's `<MapCanvas>` and the MapLibre surface beneath it.

`happy-dom` is already installed at the root, so half the stack exists. The rest is a small
harness over `react-dom/client` plus React's `act()` — enough for mount, update, unmount and
StrictMode double-invocation. **Testing Library is not taken pre-emptively.** If the harness
starts growing into a miniature framework — queries, user-event simulation, async utilities — that
is the signal to switch, and taking the dependency before that point buys nothing these tests use.

New devDependencies: `react-dom` pinned to the exact React version already present.

## Bar 0 — two contract questions, settled before the first hook

Both are specification-level. Discovering them mid-implementation would mean choosing by accident.

### 0a. `useTrackRecorder` cannot build a recorder from its declared dependencies

`api.md` publishes `recorder?: TrackRecorder` — optional, with `store`, `sampling` and `sensors`
alongside it, which only makes sense if the hook constructs a default recorder when none is
injected. But `architecture.md` line 44 lists `@mapatlas/react`'s dependencies as
`core`, `maplibre`, `react`, and **no recorder factory exists in `core`** — the only one is
`createWebTrackRecorder` in `@mapatlas/recorder-web`.

So the two specs disagree, and the disagreement is load-bearing rather than cosmetic.

**Resolution: preserve the published `api.md` signature; add `@mapatlas/recorder-web` to
`@mapatlas/react`'s dependencies and update the architecture table.** It creates no cycle
(`react → recorder-web → core`), keeps the ergonomic default, and leaves `recorder:` injection as
the route for a native or out-of-tree recorder. Changing the hook to *require* a recorder would
change a published contract, which by `api.md`'s own rules needs spec and ADR treatment anyway.

*A cost to record rather than discover later.* `@mapatlas/recorder-web` is web-specific — it
reaches for `navigator.geolocation`. A React Native consumer importing `@mapatlas/react` would
pull it into the module graph even while injecting its own recorder. That is an argument the
other way, and it is written down here so the choice is visible: if React Native support becomes
real, the fix is a lazy import or a separate entry point, not a rediscovery of this paragraph.

Needs an ADR, since it moves a package boundary the architecture states explicitly.

### 0b. What `recovered` lets a consumer *do*

`recovered?: Track` is published as *"an interrupted track found at mount"*, and
`recoverInterruptedTrack(store)` produces it. The mechanism for acting on it already exists —
`TrackRecorderOptions.resumeFrom`, which carries the id, points, laps and original `startedAt`
over so the resumed recording overwrites the same record, always opening a new segment because
the crash interval is a gap nothing observed.

But the published hook exposes **no operation that reaches `resumeFrom`**. `pause()`/`resume()`
in the signature are controls for the *current* recording, not for recovery. So three readings
exist and the API does not choose between them:

| | reading | cost |
| --- | --- | --- |
| a | `start()` silently passes `recovered` as `resumeFrom` | invents policy; makes "discard" unreachable, and `core` says the consumer offers **resume-or-discard** |
| b | `recovered` is informational only | the field is nearly useless: a consumer can see the track and cannot act on it through the hook |
| c | add `resumeRecovered()` / `discardRecovered()` | changes a published signature — spec + ADR |

**Resolved: (c)**, in **ADR-0026**. `resumeRecovered()` and `discardRecovered()` join the
published signature, `start()` never consumes `recovered`, and — a consequence of the seam rather
than a convenience — recovery belongs **only to the hook-owned recorder**. With `opts.recorder`
supplied, `recovered` stays `undefined` and no scan runs, because `resumeFrom` is not on
`TrackRecorder` and the alternative would have `resumeRecovered()` build a web recorder behind an
injected native one's back.

*The related autosave gap, also resolved.* The hook's options do **not** grow an `autosaveMs`,
matching the existing omission of `sensorMerge`. Verified in the implementation rather than
assumed: `createWebTrackRecorder` resolves `options.autosaveMs ?? DEFAULT_AUTOSAVE_MS` (10 000)
and sets `autosaveEnabled = options.store !== undefined && autosaveMs > 0`, so
`useTrackRecorder({ store })` already produces recoverable recordings. Anything beyond that —
a custom interval, `autosaveMs: 0`, a custom sensor merge, a native recorder — is what `recorder:`
injection is for. Stating it now is what stops the options drifting into a duplicate of
`TrackRecorderOptions`.

## Shape: one task, four reviewable increments

Not four backlog tasks — T5.1 stays whole, and lands as:

1. `useTrackRecorder`
2. `useEventLog`
3. `useOfflineRegions`
4. public surface, docs, task status

`useOfflineRegions` is **not** deferred to T6.1. `OfflineRegionStore` is complete enough to fake —
`download`, `list`, `delete`, `estimateSize` — and T6.1 is the default PMTiles *implementation* of
that seam, not a prerequisite for a binding around it.

## Implementation bars

**Shared React lifecycle**, applying to all three:

- Every async initial load is **stale-safe** across prop replacement and unmount: a slower earlier
  request must never overwrite a newer one, and nothing sets state after unmount.
- Subscriptions unsubscribe **exactly once**.
- **StrictMode cannot duplicate a durable action.** React double-invokes effects in development,
  and a hook that persisted or downloaded twice would corrupt real data.

**`useTrackRecorder`**

- An injected `recorder` means **no default recorder is constructed** — asserted, not assumed.
- Point and error subscriptions drive `livePoint`, `channels` and `error`.
- Every command delegates **exactly once**; `markLap(label)` carries the label through.
- `stop()` resolves with the recorder's exact finalized track and publishes it as `track`.
- **Recovery scans only when the hook owns the recorder and has a `store`**, and a stale scan
  cannot overwrite state after `store` changes or the hook unmounts.
- `resumeRecovered()` constructs the recorder with exactly that candidate as `resumeFrom`,
  **subscribes before starting it**, and clears `recovered` only after a successful start. A
  constructor, validation or start failure preserves the candidate for a retry.
- `discardRecovered()` deletes exactly `recovered.id`; a failed deletion preserves it.
- Neither operation may end up calling ordinary `resume()`.
- With an injected recorder: **zero** default-recorder constructions and **zero** recovery scans,
  asserted as counts rather than inferred from `recovered` being undefined.
- **`channels` has to be defined, not inherited by accident**: either the latest emitted point's
  channels exactly, or last-known values retained across points that omit some. The second is what
  a live readout usually wants and the first is what the field name literally says. Decide, state
  it in the JSDoc, and test the case that distinguishes them — a point carrying only one of two
  channels.

**`useEventLog`** — over `createEventLog(store)`, which core provides precisely so this hook does
not reimplement id assignment and ordering:

- Initial `list(trackId)`; add, update and delete delegate through the log.
- State after a mutation comes from the **authoritative log**, not from optimistic array surgery.
- A rejected action leaves the previous state intact.
- Changing `trackId` cannot be overwritten by an older list resolving late.

**`useOfflineRegions`**

- Initial `list()`; `download` and `remove` delegate, then refresh from the store.
- **No ordering assumed** beyond what the store returns.
- A rejected mutation fabricates no local success.
- Stale-result protection on store replacement.

**Non-vacuity.** Seam-boundary mutations must turn tests red: failing to unsubscribe, omitting the
refresh after a mutation, letting an old async list overwrite a newer one, dropping `markLap`'s
label. Two more that the recovery contract earns specifically:

- dropping `resumeFrom` from the reconstructed recorder — the recovery test must fail because the
  historical id, points and `startedAt` are not carried forward, not merely because a call count
  changed;
- clearing the candidate *before* a successful resume or delete — the failure-path tests must
  catch it.

Unit-lane mutations only; no browser mutations are needed for any of this.

**Public API.** The barrel must match `api.md` §9 exactly; the implementation conforms to the
published signatures rather than inventing a parallel API. Packaging must keep proving React is a
**peer** and not bundled.
