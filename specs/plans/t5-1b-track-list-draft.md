# T5.1b — track list and draft hooks

> Bars set 2026-09-02, **before implementation**, against `main` at `76ed53b`.

## Survey result: bind completed policy, repair one leaked core parameter

This is primarily a React binding task. The two policies already exist below React:

- `StorageAdapter.listTrackSummaries()` returns the projection a trip list needs, without
  hydrating point arrays, ordered by `startedAt` and then id (ADR-0014). Both the memory and
  IndexedDB adapters, plus the shared storage conformance suite, already enforce that contract.
- `createTrackDraft(from?)` already owns point editing, breaks, timing, bounded undo/redo,
  validation, authored finalization, seeded metadata and lap repair (ADR-0014, ADR-0018 and the
  later draft decisions). React must expose that object and its lifecycle, not reimplement it.

No new package or dependency is needed. The existing `happy-dom` hook harness is sufficient.

The survey did find one public-core defect that lands first and separately. `api.md` publishes
`TrackDraft.toTrack(meta?)`; `packages/core/src/draft.ts` additionally exposes
`policy?: Partial<FinalizePolicy>`. All twelve repository call sites use zero or one argument.
The second parameter is therefore a leaked surface, not an exercised capability.

## Bar 0 — repair `TrackDraft.toTrack` before binding it

Remove the second `policy` parameter from the public interface and implementation, and finalize
with the documented default policy. Add an exact parameter-tuple check transcribed from
`api.md`, not a one-way assignment: an extra optional parameter is assignable to a narrower
function and is exactly how this leak stayed green.

**Falsification:** restoring `policy?` must fail at the exact `Parameters<TrackDraft["toTrack"]>`
comparison. No runtime output is expected to change because no caller supplies it.

This is a defect repair against existing core API, not part of either React feature commit.

## Settled lifecycle rules

### A draft context is selected by `from.id`

`from.id` identifies the draft. Changing to a different id replaces the draft; a new `Track`
object with the same id does **not**. Rebuilding on object identity would discard unsaved edits
when a parent rendered an equivalent fresh object. A consumer that deliberately wants to reload
the same id remounts the hook.

The transitions are all meaningful:

- `undefined -> track id`: replace the blank draft with that track;
- `track A -> track B`: replace it;
- `track id -> undefined`: begin a new blank draft;
- same id, different object: preserve the current edits and history.

### One draft session has one persisted identity

A seeded draft always retains `from.id`. A new draft adopts the id produced by its first
successful `toTrack()` and passes that id back to every later `toTrack()`.

Adoption happens **before** awaiting `saveTrack()`. If persistence rejects after partially
landing, retrying under a newly minted id would duplicate the trip rather than overwrite the
uncertain first write. The adopted id is therefore reused after a rejected save and after later
edits. `from.id` wins over any adopted id because an existing trip must not fork on first save.

### `useTrackList.loading` describes list work only

`loading` means the newest `listTrackSummaries()` request in the current store context is still
pending. It is true for the initial list, explicit `refresh()`, and the authoritative re-list
after a successful delete. It is not a second error or mutation-status channel.

An explicit `refresh()` or `remove()` rejection reaches its caller. An initial-list rejection has
no published error field to occupy: it preserves the tracks already shown and ends loading.

## Increment 1 — `useTrackList`

Published shape, exactly as `api.md` §9 declares:

```ts
useTrackList(store: StorageAdapter): {
  tracks: TrackSummary[];
  loading: boolean;
  refresh(): Promise<void>;
  remove(id: Id): Promise<void>;
}
```

Executable bars:

- The initial load calls `listTrackSummaries()` and **never** `getTrack()`. The fake makes a
  `getTrack()` call fail so “summary-backed” crosses a seam rather than being inferred from the
  returned type.
- The adapter's order is preserved verbatim. React does not re-sort a contractually ordered
  result or recreate `compareTrackSummaries` above the seam.
- Initial `loading` is true and becomes false only when the newest request in the current store
  settles. An older request cannot clear it while a newer one remains pending.
- Context and request sequence are separate guards, as in the repaired T5.1 hooks: changing the
  store invalidates the old context, while two lists in one store are ordered by issue sequence.
- A slow initial list cannot overwrite a completed refresh. A replaced store cannot publish or
  receive a pointless post-mutation re-list.
- `remove(id)` calls `deleteTrack(id)` exactly, performs no optimistic filter, and then re-lists
  from the store. A rejected delete preserves the visible list and issues no re-list.
- Explicit refresh failure rejects and ends loading without blanking the previous list. Initial
  failure is caught by the effect, also ends loading, and preserves prior state.
- StrictMode may issue two initial reads; it must not duplicate a durable operation.

Required mutations to kill:

- hydrate each summary with `getTrack()`;
- sort by id or reverse the store order;
- drop the context check;
- drop the per-request sequence check;
- let an older request set `loading = false`;
- optimistically filter before `deleteTrack()`;
- omit the re-list after delete;
- re-list after a rejected delete;
- sample the context only after an in-flight mutation resolves.

## Increment 2 — `useTrackDraft`

Published shape, exactly as `api.md` §9 declares. The React methods taking `LatLng` deliberately
create untimed draft vertices; timing remains the explicit `setTimeAt`/`interpolateTimes` step.

Executable bars:

- A blank draft starts with no points, no history and no untimed indices. A seeded draft exposes
  the core draft's copied points and history state without mutating the source `Track`.
- Every successful core edit updates `points`, `canUndo`, `canRedo` and `untimedIndices` from the
  authoritative draft. React performs no parallel point-array or history surgery.
- `append`, `insertAt`, `moveAt`, `removeAt`, `setTimeAt`, `interpolateTimes`, `breakAt`, `undo`
  and `redo` delegate with their exact arguments. A rejected core edit leaves the prior React
  snapshot untouched because the draft emits no change.
- Changing `from.id` installs a new draft. Re-rendering with a fresh object carrying the same id
  preserves unsaved points and undo history. A callback captured from the old context cannot
  update the replacement after its subscription is removed.
- `save()` first calls `toTrack()`; untimed points therefore reject with
  `TrackDraftIncompleteError` and nothing reaches storage.
- Without a store, `save()` resolves with the exact authored track. With a store, it awaits
  `saveTrack(track)` and resolves with that same track; it never calls list or another adapter
  operation.
- A seeded draft saves under `from.id`. A blank draft adopts the first `toTrack()` id before
  persistence and reuses it after a rejected write and after later edit-and-save cycles.
- A rejected `saveTrack()` rejects to the caller without clearing edits, history or the adopted
  identity.
- The public hook is exercised directly. If an internal factory seam is needed to order a test,
  it takes the T5.1 form: a separate non-barrel internal entry point, with the public wrapper's
  forwarding falsified independently.

Required mutations to kill:

- rebuild on `from` object identity instead of id;
- ignore a changed id;
- keep the old draft subscription after replacement;
- compute `canUndo`, `canRedo` or untimed indices locally and let one drift from core;
- pass a timed or otherwise enriched point through `append(LatLng)`;
- persist before `toTrack()` validates;
- omit `saveTrack()` when a store exists;
- return before `saveTrack()` settles;
- adopt the id only after persistence succeeds;
- mint again on retry or a later save;
- let an adopted id override `from.id`.

## Increment 3 — exact public surface and completion

Extend `packages/react/src/index.test.ts` rather than weakening it:

- transcribe both new signatures from `api.md`;
- compare exact parameter tuples, return assignability in both directions, and top-level key sets;
- add `useTrackList` and `useTrackDraft` to the exact runtime barrel set;
- remove them from the deliberately-absent T5.1b list rather than leaving a stale exception;
- keep internal factories, environments and the hook harness off the barrel;
- run one behavioural test through every public wrapper if detailed tests use an internal entry
  point, so exact declarations cannot coexist with a broken delegation.

Only after those checks and the package gates pass does `specs/tasks.md` mark T5.1b done. The
completion note must distinguish what React built from policy it merely bound in core.

## Verification and commit boundaries

Every increment stops for review before commit. The minimum gates are:

```text
npm run verify
npm run check:packaging
```

Author verification is labelled as such. Seam guards are mutation-tested individually; a red
suite caused only by a stronger neighbouring test is not evidence that the named test works.

Expected history:

1. `fix(core): match documented TrackDraft signature`
2. `feat(react): add summary-backed track list hook`
3. `feat(react): add persistent track draft hook`
4. public-surface/task-status closeout, split from feature code when it is independently useful

