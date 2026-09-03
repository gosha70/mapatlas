# T5.3 — `<EventComposer>`

> Bars set 2026-09-02, **before implementation**, against `main` at `6cf4b33`. The survey found a
> genuine build: every seam exists in core (`MediaAnalyzer`/`noopAnalyzer`, `putBlob`/`getBlob`/
> `deleteBlob`, `MediaRef`/`MapEvent`), while the component and the published `FieldSpec` type
> exist nowhere in code.

## Settled calls

1. **Blobs are written on Save, not at capture.** The selected `File` stays in memory; preview
   and analysis use it directly — neither needs a persisted copy. This does **not** eliminate
   the orphan window: a successful write followed by an interrupted handoff still creates one,
   which is what the ownership table below is for.
2. **`mode: "photo"` means capture-first UI, not an automatic camera launch.** The capture
   affordance is the initially active, accessible control, and the picker is invoked through a
   user action. `capture="environment"` **requests a preferred facing mode with fallback
   permitted** (W3C html-media-capture); it is not a rear-camera guarantee. This clarification
   lands in `api.md` and `specs/tasks.md` at checkpoint 0, not only here.
3. **One optional photo in T5.3, with replace and remove.** The `MapEvent.media` contract stays
   an array; only the composer's v1 surface is singular.
4. **`FieldSpec` is exported** — unlike `MapCanvasProps`, it is a *named* published interface in
   §9. Conformance covers its property types, its key set, and the nested
   `options: { value, label }` shape.

## The save handoff — ownership, stated because `onSave` returns `void`

`onSave(input): void` cannot acknowledge persistence, so ownership is positional:

| moment | owner of the blob | on cancel / unmount | notes |
| --- | --- | --- | --- |
| composing (pre-Save) | nobody — the `File` is memory only | nothing persisted, nothing to clean | replace/remove swaps the in-memory file |
| Save tapped → `putBlob` in flight | the composer | when the write settles: if it landed, the composer best-effort `deleteBlob`s it; `onSave` is never called | duplicate Save is ignored while one is in flight — one `putBlob` per photo-bearing attempt, at most one `onSave`; rejection and cancellation call none |
| `putBlob` rejected | **unknown** — a rejection does not establish the storage outcome | save fails; composed state intact; `onSave` unreachable | a remote adapter can persist the bytes and lose the response; the composer holds no key, so nothing can be cleaned up and no orphan-free retry is promised — a retried Save may orphan the first, unlocatable write |
| `onSave(input)` invoked | **the consumer**, from the instant the callback receives the `blobKey` | the composer never deletes it afterwards, unmount included | the consumer reattaches `at`, persists the event, or discards — discarding is the consumer's orphan, documented |
| cleanup `deleteBlob` rejected | — | deletion is **unconfirmed** — the blob may or may not remain | the storage seam has no transactions, and `deleteTrack`'s only-referenced-by GC does not cover it — no atomicity is claimed |

**Rejection is not an outcome — and the fake alone cannot prove the composer knows it.** A
write-then-reject fake demonstrates the orphan is *possible*; it cannot by itself distinguish
composer behaviour, because both storage outcomes present identically to the composer — a
rejection and no key. (An earlier draft of this plan claimed the fake falsified the row; that
claim was stronger than the fake supports.) The observable requirements are therefore named:

- the rejected-Save error wording acknowledges an **unconfirmed** write — mutation: wording that
  asserts nothing was stored fails;
- the draft is retained intact — mutation: clearing it fails;
- `onSave` is unreachable — mutation: calling it after the rejection fails.

The write-then-reject fake still runs, as the environment these observables are asserted in.
The cleanup row is exercised **separately**, with a delete-then-reject fake — a write-then-reject
fake cannot establish anything about deletion.

**Cleanup-failure reporting policy.** While the composer is mounted, a failed cleanup is retained
in component state and shown as an inline notice — UI, not new API. After unmount there is no
reporting channel; the failure is logged as a `console.warn` and acknowledged as unreported,
because inventing a callback for it would be API §9 does not publish.

**A Save snapshots the complete handoff at Save time** — the assembled input, the `store`, and
the `onSave`/`onCancel` recipients — and completes against that snapshot. Replacing the `store`
mid-write neither aborts nor redirects the write, and completion invokes the *snapshotted*
`onSave`: delivering store A's `blobKey` to a replacement callback associated with store B would
hand the consumer a key that resolves nowhere in B. Pinned with a parked write across replacement
of both the store and the callbacks.

**Successful handoff and cancellation are terminal; rejection is not.** After `onSave` has been
invoked, or after `onCancel`, the composer is inert — a consumer that leaves it mounted cannot
produce a second submission; a new composition is a new mount, and at most one of
`onSave`/`onCancel` fires per instance. The write limit is per *attempt*: **one `putBlob` per
photo-bearing Save attempt** (a photo-free Save performs zero), no concurrent duplicate
attempts, and a rejected attempt permits retry unless cancelled — a lifetime cap would forbid
the retry the rejection row governs. Pinned as a sequence: reject → retry succeeds → a
subsequent Save is ignored.

## Analyzer bars (ADR-0005)

- `analyze` runs only on an explicit user action, on the in-memory `File`.
- `runsRemotely: true` gates that action behind a disclosure; mutation: remove the gate → fail.
- **The no-op path is a successful empty-suggestion path, not "indistinguishable from absent".**
  `noopAnalyzer` returns `model: "noop"` and no labels; the UI shows its empty result through
  the same path as any analyzer, with no special-casing of its id.
- Confirmed suggestions land in `MediaRef.analysis` **only** — never auto-populating `tags`,
  `category` or `fields`.
- **The invalidation set is complete, not photo-shaped**: a resolution is discarded when it
  arrives after photo replacement or removal, after cancel, after Save, after unmount, after the
  `analyzer` prop was replaced, or when an older request completes after a newer one — the
  newest request wins, sequence-tokened like the hooks. Each leg falsified. Unconfirmed
  suggestions are dropped by Save.

## Field bars — values, not displayed text

Each `FieldSpec` type round-trips into `MapEvent.fields` as a **value**: numeric `0` survives,
boolean `false` survives, `date` strings pass through without timezone conversion, `select`
stores the option's `value` not its `label`, and a missing `required` value blocks Save with the
composed state intact.

**`FieldSpec.key` is an identity, so duplicates are rejected, not resolved.** `MapEvent.fields`
is keyed by `key`, so two specs sharing one cannot both survive Save — the public input would
admit a configuration the output model cannot represent, the same class of hole as the empty
string above. Last-wins is the wrong default for a field logger: it discards a value the
consumer asked to record, silently, after the user has typed it. A duplicate is therefore
**invalid configuration** and throws at render, surfacing on first paint. Falsified by removing
the check, and by resolving order instead of rejecting — both must fail. Uniqueness is a
*component* semantic, not a platform one, so it is pinned in the unit lane with no browser case.

**`""` is not reserved, so missing-ness is selection identity, not the empty string.**
`FieldSpec.options[].value` is an unrestricted string, and so is `categories[].value`: an option
may legally carry `value: ""` and must round-trip as `""`, satisfying `required` like any other
value. Reading missing-ness as `control.value === ""` would make a real consumer value
indistinguishable from no selection — a *displayed-text* reading of exactly the kind this section
forbids. The discriminator is therefore the composer's own placeholder option **being selected**
(it is the option at index 0), for both `select` fields and `categories`. Falsified by replacing
the identity check with `value === ""`, which must fail. Text and `date` inputs are unaffected:
there `""` is the absence of an entry, and empty optional inputs omit their key, as above.

**An absent `occurredAt` is captured once, when this composition opens.** The tap is when the
event happened, not the Save — a composer left open for five minutes while the user types must
not stamp the moment they finished. Validation failures and retries retain that timestamp; Save
never resamples the clock, and a new moment needs a new mount. This is a *choice* between two
readings of "defaults to now" that checkpoint 0 left open; it is settled here and in `api.md`
before being pinned by a test, because a mutation is only evidence against a contract that
exists.

## Testing lanes

- **Vitest / happy-dom** — state, fields, the handoff table, analyzer tokens, everything counted
  through fakes.
- **Playwright — planned now, not deferred.** happy-dom cannot establish picker activation,
  native form behaviour, or focus. And `setInputFiles` alone cannot either: it supplies the
  input's files directly, so a broken capture button would still pass. The scenario therefore
  **arms the `filechooser` event, activates the visible capture affordance, and supplies the
  fixture through the resulting chooser** — removing the activation wiring must fail before
  persistence is ever exercised. Then both `mode`s' initially-active affordance, and a consumer
  callback that reattaches `at`, persists the event, and reads the stored photo bytes back equal
  to the selected file. No physical-camera claim is made or possible.

## Increments

0. **Plan/ADR checkpoint** — this plan; the ownership table recorded as the decision it is; the
   `capture` wording clarification into `api.md` and `tasks.md`.
1. **Fields, comment, category, occurredAt, save/cancel** — no photo, no analyzer. The value
   bars above, including empty-string option values and capture-once `occurredAt`; exact
   `onSave` shape; cancel means **no `onSave` ever**, and `onCancel` fires exactly once.
2. **Photo + blob handoff** — the ownership table implemented and falsified row by row; the
   real-browser scenario (file selection, both modes, consumer persistence round-trip).
3. **Analyzer flow** — disclosure gate, empty-suggestion path, confirm-to-`analysis`, late-result
   tokens.
4. **Surface + closure** — `EventComposer` and `FieldSpec` exported; exact §9 conformance
   including the nested option shape; out of `NOT_YET_BUILT`; `tasks.md`.

## Required mutations (beyond per-increment falsifications)

- call `onSave` after a rejected `putBlob` → handoff table row fails;
- delete the blob after `onSave` was invoked → ownership boundary fails;
- second `putBlob` from a duplicate Save → exactly-once fails;
- skip the cleanup delete on cancel-during-write → the pending-write row fails;
- read a `putBlob` rejection as "nothing stored" → the uncertainty-wording assertion fails;
- deliver a parked write's key to the replacement callback → the snapshot row fails;
- accept a second Save after handoff → the terminal-state bar fails;
- refuse a retry after a rejected attempt → the reject → retry → ignored sequence fails;
- let an older analyze result overwrite a newer one → the sequence token fails;
- auto-populate `tags` from confirmed labels → the analysis-only bar fails;
- drop the disclosure for a remote analyzer → the gate test fails;
- coerce `0`/`false`/date values → the value bars fail;
- read a select's missing-ness as `value === ""` → the empty-string option bar fails, for
  both a `select` field and a category;
- resample the clock at Save, or on a retry after a blocked Save → the capture-once bar fails;
- read a supplied `occurredAt` with `||` rather than `??` → epoch 0 is a supplied value, and
  the absent-only default bar fails;
- accept duplicate `FieldSpec.key`s, whether by dropping the check or by resolving them
  last-wins → the key-identity bar fails.
