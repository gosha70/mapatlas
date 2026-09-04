// SPDX-License-Identifier: Apache-2.0

import { createElement, useEffect, useRef, useState } from "react";
import type { ChangeEvent, FormEvent, ReactElement, ReactNode } from "react";

import { newId } from "@mapatlas/core";
import type {
  JSONValue,
  LatLng,
  MapEvent,
  MediaAnalysis,
  MediaAnalyzer,
  MediaRef,
  StorageAdapter,
} from "@mapatlas/core";

/** Shown when `putBlob` rejects. Deliberately does not claim nothing was stored: a rejection
 *  does not establish the storage outcome, and a remote adapter can persist bytes and lose the
 *  response (ADR-0027). */
const UNCONFIRMED_WRITE =
  "The photo could not be confirmed as saved. It may or may not have been stored. " +
  "Your entry is unchanged — you can try saving again.";

/** The same uncertainty for an attempt whose instance has already finished — no retry to
 *  offer, because cancellation is terminal and a new moment needs a new composition. */
const UNCONFIRMED_WRITE_SETTLED =
  "The photo could not be confirmed as saved before this entry was closed. " +
  "It may or may not have been stored.";

/** Shown when `analyze` rejects. Analysis is optional, so this never blocks a Save. */
const ANALYSIS_FAILED = "The photo could not be analysed. You can save the entry without it.";

/** Shown when the composer's own cleanup delete rejects, while it is still mounted. */
const UNCONFIRMED_CLEANUP =
  "The discarded photo could not be confirmed as removed. It may still be stored.";

/** Everything one photo-bearing Save attempt completes against, captured when it starts. */
interface AttemptSnapshot {
  store: StorageAdapter;
  onSave: (input: Omit<MapEvent, "id" | "position">) => void;
  onCancel: () => void;
}

/** A consumer-defined input rendered by {@link EventComposer} into `MapEvent.fields`.
 *  The engine renders the label and stores the value; it assigns no meaning. (`api.md` §9) */
export interface FieldSpec {
  key: string;
  label: string;
  type: "text" | "number" | "boolean" | "select" | "date";
  options?: { value: string; label: string }[];
  unit?: string;
  required?: boolean;
  placeholder?: string;
}

/**
 * Compose one event at a position: comment, category, consumer-defined fields, one optional
 * photo, optional analysis of it, and save/cancel (`api.md` §9, ADR-0005, ADR-0027).
 * Everything documented here is built; only the barrel export remains.
 *
 * **An uncontrolled form, read at Save.** The draft lives in the DOM until the moment it is
 * handed over: nothing re-renders per keystroke, and a Save blocked by validation preserves the
 * draft structurally — there is no engine-held copy that a re-render could clear. The composer's
 * own state is only what the DOM cannot hold: the validation notice, and whether the instance
 * has settled.
 *
 * **Values, not displayed text.** A `number` field emits the number (`0` survives; a non-finite
 * spelling like `"1e400"` never arrives from a conformant browser — the number state flags it
 * `badInput` and constraint validation stops the submission before Save runs, which is what
 * keeps `fields` inside `JSONValue`; pinned in the real-browser lane, since happy-dom's regex
 * validity misses this contract). A `boolean` emits `checked` — `false` is a value, so boolean
 * keys are always present. A `select` emits the option's `value`, never its label. A `date`
 * emits the input's string exactly as the DOM holds it — no `Date` round-trip: parsing
 * `"2026-09-02"` pins it to UTC midnight, and re-serialising alters the value — `toISOString()`
 * to a UTC datetime string, local-date formatting to the previous day anywhere west of UTC.
 * Empty optional inputs omit their key entirely; `required` checks *missing-ness*, never
 * truthiness, so `0` and `false` satisfy it.
 *
 * **Field keys are unique, and a duplicate is rejected rather than resolved.** `key` is an
 * identity: `MapEvent.fields` is keyed by it, so two specs sharing one cannot both survive
 * Save. Resolving by order would silently discard a value a field logger was asked to record,
 * so a duplicate throws at render — invalid configuration, surfaced on first paint rather than
 * as missing data after the user has already typed it.
 *
 * **`""` is a value, not a gap — for selects and categories.** `options[].value` and
 * `categories[].value` are unrestricted strings, so an option may carry `value: ""` and must
 * round-trip as `""`, `required` included. "No selection" is therefore the *placeholder option
 * being selected* — the one this component renders at index 0 — never `control.value === ""`,
 * which would confuse a real consumer value with a gap. Text and `date` inputs are unaffected:
 * there `""` genuinely is the absence of an entry.
 *
 * **Settled before the callback, not after.** Successful handoff and cancellation are terminal
 * (ADR-0027): the instance seals itself *before* invoking `onSave`/`onCancel`, so a reentrant
 * callback — or one that throws — meets an already-settled composer and cannot produce a second
 * submission. At most one of the two callbacks ever fires. A validation failure is not
 * settlement: the notice renders, the draft stands, and a corrected Save goes through.
 *
 * **A photo-free Save performs zero blob writes** and hands over synchronously; the `store`
 * exists for photo handoff alone.
 *
 * **The photo handoff, and who owns the blob (ADR-0027).** The selected `File` stays in
 * memory — nothing is persisted until Save, so replace and remove have nothing to clean up.
 * A photo-bearing Save performs **exactly one `putBlob` per attempt**: a duplicate Save while
 * one is in flight is refused, and a *rejected* attempt may be retried, performing its own
 * single write. Ownership is positional, because `onSave` returns `void` and so cannot
 * acknowledge persistence:
 *
 * - **while the write is in flight** the blob is the composer's. If the instance finishes
 *   first — cancelled, or unmounted — the completion cleans the blob up and `onSave` is never
 *   called;
 * - **a rejection establishes nothing.** The bytes may or may not have landed; the composer
 *   holds no key, so it can neither clean up nor promise an orphan-free retry. The draft is
 *   retained and the notice says the write is *unconfirmed*, never that nothing was stored;
 * - **from the instant `onSave` receives the `blobKey` the consumer owns it**, and the
 *   composer never deletes it again — unmount included;
 * - **a failed cleanup delete is unconfirmed.** Reported inline while mounted, and only
 *   `console.warn`ed after unmount, where there is no channel to report it through.
 *
 * A Save snapshots its whole handoff — the assembled input, the `store`, and **both**
 * recipients, `onSave` and `onCancel` — and completes against that. Replacing the `store`
 * mid-write neither redirects nor aborts it; the key is never delivered to a callback paired
 * with a different store; and cancelling a write that is still in flight notifies the
 * consumer that started it, not whoever is rendered by then.
 */
export function EventComposer(props: {
  at: LatLng;
  store: StorageAdapter;
  fields?: FieldSpec[];
  categories?: { value: string; label: string }[];
  /** Defaults **once**, when this composer instance opens — the tap is when it happened, not
   *  the Save. Never resampled: a composer left open while the user types, and every retry
   *  after a blocked Save, keep the opening timestamp; a new moment needs a new mount. */
  occurredAt?: number;
  /** Which affordance is initially active — and *only* that. `"photo"` focuses the capture
   *  control; `"comment"` focuses the comment. It does not change capture semantics: the photo
   *  input always requests a rear-facing camera, in both modes, because a comment-first
   *  composition whose user then adds a photo should not be quietly downgraded. That request is
   *  a preference — the picker opens on a user action, and neither a rear camera nor a camera
   *  at all is guaranteed (W3C html-media-capture, ADR-0027). */
  mode?: "comment" | "photo";
  /** Optional photo analysis, run only on an explicit user action (ADR-0005). Must be
   *  **referentially stable**: replacing the value is how the composer learns the analyzer
   *  changed, and it then discards any in-flight resolution and closes a disclosure opened
   *  for the previous one. An inline object recreated every render reads as a continuous
   *  replacement. */
  analyzer?: MediaAnalyzer;
  onSave(input: Omit<MapEvent, "id" | "position">): void;
  onCancel(): void;
}): ReactElement {
  /**
   * Terminal state, as a ref rather than React state: the seal has to hold *synchronously*,
   * before either callback runs, and a state update commits too late to stop a reentrant one.
   * Three values, not a boolean, because a pending write's completion has to tell "cancelled
   * while I was writing" (clean the blob up) from "already handed over" (never touch it).
   */
  const outcome = useRef<"open" | "saved" | "cancelled">("open");
  /** A `putBlob` is in flight. Guards duplicate Saves *per attempt*, not per lifetime. */
  const writing = useRef(false);
  /**
   * The recipients the in-flight attempt was started with (ADR-0027 decision 4).
   *
   * Three recipients, not the whole handoff: the assembled input travels separately, as the
   * completion's own argument, because it is read once at Save and never consulted again.
   *
   * Only `onCancel` strictly needs this ref, and the reason is worth stating exactly. The
   * completion is a closure created during the Save render, so reading `props.store` or
   * `props.onSave` inside it reads *the Save render's* props — a closure never sees a later
   * render's values. That is why a mutation replacing those two with `props.x` survives, which
   * is recorded rather than hidden. `onCancel` is reached differently: a Cancel click is
   * dispatched through whichever render is mounted when the click happens, so after a
   * replacement render it lands in the new callback and tells a consumer that never started
   * this composition that it had been cancelled. The other two ride along so the decision
   * reads as one object, but the load-bearing member is `onCancel`.
   */
  const attempt = useRef<AttemptSnapshot | undefined>(undefined);
  /** False after unmount — a resolution arriving then may not touch React state. */
  const live = useRef(true);
  // The initializer runs on every render and only the first result is kept — the accepted cost
  // of `useRef` initialisation; `Date.now()` is idempotent enough to pay it.
  const openedAt = useRef(Date.now());

  const commentRef = useRef<HTMLTextAreaElement | null>(null);
  const categoryRef = useRef<HTMLSelectElement | null>(null);
  const fieldControls = useRef(new Map<string, HTMLInputElement | HTMLSelectElement>());
  const [missingLabels, setMissingLabels] = useState<readonly string[]>([]);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  /**
   * Analyzer feedback, deliberately not the same state as `notice`. They are different
   * lifecycles: a storage outcome is uncertain until the consumer resolves it, while an
   * analysis failure belongs to one photo and one request. Sharing one slot let an analysis
   * erase an unconfirmed-write warning, and let a new photo inherit the previous photo's
   * error.
   */
  const [analysisNotice, setAnalysisNotice] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [photo, setPhoto] = useState<{ file: File; url: string } | undefined>(undefined);
  /**
   * The arrived analysis and whether the user has kept it. `undefined` is "no analysis has
   * arrived", which is *not* the same as an analysis carrying no labels — the no-op path is a
   * successful empty result and is shown as one, through the same states as any other.
   */
  const [analysis, setAnalysis] = useState<
    { result: MediaAnalysis; confirmed: boolean } | undefined
  >(undefined);
  const [analyzing, setAnalyzing] = useState(false);
  /** The disclosure panel is open. Opening it is the *refusal* to send, not a send. */
  const [disclosing, setDisclosing] = useState(false);
  /**
   * Monotonic request token. Every resolution names the request it belongs to, and every
   * event that invalidates one bumps it, so the accept/discard test is a single comparison
   * rather than a list of conditions that can be extended in one place and forgotten in
   * another. Bumped by: a new request, photo replacement, photo removal, cancel, Save, and
   * replacement of the `analyzer` prop.
   *
   * **Unmount is deliberately not in that list.** The plan requires a resolution arriving
   * after unmount to be discarded, and it is — but by React, whose state updates on an
   * unmounted component are no-ops, not by a token bump here. A bump in the unmount cleanup
   * cannot be falsified: removing it leaves the suite green, because there is nothing left to
   * render the difference. An unfalsifiable line claiming to do this work would be worse than
   * the honest absence of one.
   *
   * **Photo removal's bump is also not independently falsifiable**, for a different reason:
   * every route out of the no-photo state — choosing another photo, Save, cancel — bumps the
   * token itself, so a mutation removing the one in `dropAnalysis`'s removal caller survives.
   * It is kept because it is a state transition, not a guard: without it `analysis` would go
   * on describing a photo that is no longer part of the composition, which is incoherent even
   * while it is invisible.
   */
  const analyzeSeq = useRef(0);
  /**
   * The one outstanding disclosure, as a **synchronous, single-use authorization** naming the
   * exact request it authorises.
   *
   * `disclosing` cannot carry this. It is React state, so its clearing is queued: until the
   * commit, the Accept button is still mounted and still calls its handler, and two
   * activations in one task would start two sends from one disclosure. Nor is admission
   * enough — the composition is legitimately open in between. Consuming a ref before the
   * send is what makes one disclosure authorise one request; naming the request in it is what
   * stops a retained button from spending a disclosure shown for different bytes.
   */
  const authorized = useRef<{ source: MediaAnalyzer; file: File } | undefined>(undefined);
  // The object URL to revoke at unmount. State cannot be read from an unmount cleanup that
  // closes over the first render, so the live value is mirrored here.
  const photoUrl = useRef<string | undefined>(undefined);

  useEffect(() => {
    // Set on *every* effect run, not only at ref initialisation. StrictMode mounts, unmounts
    // and remounts in development, so a flag that is only ever cleared would leave a live
    // composer believing it had been unmounted — and a landed write would then be cleaned up
    // instead of handed over, with `onSave` never called. Pinned by a StrictMode mount test,
    // and originally found by the real-browser lane, whose harness mounts in StrictMode.
    live.current = true;
    return () => {
      live.current = false;
      if (photoUrl.current !== undefined) URL.revokeObjectURL(photoUrl.current);
    };
  }, []);

  // A replaced analyzer invalidates anything the previous one is still computing, and voids
  // an outstanding disclosure — a panel naming one service cannot authorise a send to the
  // next. There is no persistent acceptance to withdraw: consent is per request.
  const analyzer = props.analyzer;
  useEffect(() => {
    analyzeSeq.current += 1;
    setAnalyzing(false);
    authorized.current = undefined;
    setDisclosing(false);
  }, [analyzer]);

  // Placed after the hooks so this render's hook sequence is complete before it can abort.
  const duplicate = firstDuplicateKey(props.fields);
  if (duplicate !== undefined) {
    throw new Error(
      `EventComposer: duplicate FieldSpec key ${JSON.stringify(duplicate)}. Keys identify ` +
        `values in MapEvent.fields and must be unique within one composer.`,
    );
  }

  const save = (submit: FormEvent): void => {
    submit.preventDefault();
    // Two separate refusals: the instance is finished, or *this attempt's* write is still in
    // flight. The second is why a duplicate Save cannot start a second `putBlob`, while a
    // rejected attempt — which clears it — can still be retried.
    if (outcome.current !== "open" || writing.current) return;

    // A Map, materialised through `Object.fromEntries`: assignment into a plain object would
    // route a key like "__proto__" — which `FieldSpec` does not reserve — through the inherited
    // setter and silently discard the value; `fromEntries` creates own properties.
    const fields = new Map<string, JSONValue>();
    const missing: string[] = [];
    for (const spec of props.fields ?? []) {
      const control = fieldControls.current.get(spec.key);
      const value = control === undefined ? undefined : readFieldValue(spec, control);
      if (value === undefined) {
        if (spec.required === true) missing.push(spec.label);
      } else {
        fields.set(spec.key, value);
      }
    }
    if (missing.length > 0) {
      setMissingLabels(missing);
      return;
    }

    const comment = commentRef.current === null ? "" : commentRef.current.value;
    // Selection identity, exactly as for a `select` field above: a category may legally carry
    // `value: ""`. `null` here is the different question of whether a category control exists
    // at all, which it does not when `categories` is absent.
    const categorySelect = categoryRef.current;
    const category =
      categorySelect === null || categorySelect.selectedIndex === 0
        ? undefined
        : categorySelect.value;
    const input: Omit<MapEvent, "id" | "position"> = {
      occurredAt: props.occurredAt ?? openedAt.current,
      media: [],
      tags: [],
      ...(comment === "" ? {} : { comment }),
      ...(category === undefined ? {} : { category }),
      ...(fields.size === 0 ? {} : { fields: Object.fromEntries(fields) }),
    };

    setMissingLabels((previous) => (previous.length === 0 ? previous : []));
    // Whatever the analyzer is still computing is now moot, and an unconfirmed suggestion is
    // not something the user agreed to store, so only a kept one travels. `endAnalysis` also
    // settles the visible state: a token bump alone makes the late continuation return before
    // it clears `analyzing`, stranding a still-mounted composer at "Analysing…".
    const kept = analysis?.confirmed === true ? analysis.result : undefined;
    endAnalysis();

    // A photo-free Save performs zero blob writes and hands over synchronously.
    if (photo === undefined) {
      outcome.current = "saved";
      props.onSave(input);
      return;
    }

    // **The snapshot.** The whole handoff is captured now — the assembled input, the store
    // that will hold the bytes, and both recipients, `onSave` for the key and `onCancel` for
    // an abandonment — and the attempt completes against *these*, never against whatever props
    // a later render supplies. Delivering store A's key to a callback that a replacement render
    // paired with store B would hand the consumer a key resolving nowhere in B (ADR-0027).
    //
    // Precise about which half needs the ref. `store` and `onSave` would survive on the
    // completion's own closure alone — swapping them for `props.x` changes no behaviour, and
    // a mutation doing so survives. `onCancel` is different: a Cancel click runs through the
    // *current* render's handler, so without `attempt` it reaches a replacement recipient.
    // Both are guarded behaviourally — the first against a latest-props read at resolution
    // time, the second against cancelling to current props mid-write.
    const snapshot: AttemptSnapshot = {
      store: props.store,
      onSave: props.onSave,
      onCancel: props.onCancel,
    };
    attempt.current = snapshot;
    writing.current = true;
    setBusy(true);
    setNotice(undefined);
    void completeWithPhoto(input, photo.file, kept, snapshot);
  };

  /** The photo-bearing half of one Save attempt: exactly one `putBlob`, then ownership. */
  const completeWithPhoto = async (
    input: Omit<MapEvent, "id" | "position">,
    file: File,
    kept: MediaAnalysis | undefined,
    snapshot: AttemptSnapshot,
  ): Promise<void> => {
    let key: string;
    try {
      key = await snapshot.store.putBlob(file);
    } catch {
      // **Rejection is not an outcome.** The bytes may or may not have landed; the composer
      // holds no key, so there is nothing it could clean up and no orphan-free retry it could
      // promise. The attempt ends: `outcome` stays "open", so the draft stands and a retry is
      // permitted — and it performs its own single write.
      writing.current = false;
      // The attempt is over: a retry snapshots the then-current recipients rather than these.
      attempt.current = undefined;
      // Unconditional, deliberately. A `live.current` guard here reads as prudent but has no
      // observable effect: React 18 makes a state update on an unmounted component a silent
      // no-op, so removing the guard leaves the suite green — an unverifiable claim, which is
      // worse than the update it was avoiding. The `live` checks that remain are the ones that
      // change behaviour: which reporting channel a failed cleanup uses, and whether a landed
      // write is handed over or cleaned up.
      setBusy(false);
      // Same uncertainty, different advice. Offering "try saving again" to an instance that
      // is already terminal proposes something it can never do — cancellation is permanent,
      // and a retry would need a new composition.
      setNotice(outcome.current === "open" ? UNCONFIRMED_WRITE : UNCONFIRMED_WRITE_SETTLED);
      return;
    }
    writing.current = false;

    // The write landed, but the instance finished while it was in flight — cancelled, or
    // unmounted. Ownership never transferred, so the blob is still the composer's to remove.
    if (outcome.current !== "open" || !live.current) {
      try {
        await snapshot.store.deleteBlob(key);
      } catch {
        // Deletion is unconfirmed either way; only the reporting channel differs.
        if (live.current) setNotice(UNCONFIRMED_CLEANUP);
        else console.warn(`EventComposer: cleanup of blob ${key} is unconfirmed after unmount`);
      }
      // After the try/catch, so both outcomes clear it: the attempt raised `busy`, and the
      // cleanup is the end of that attempt whether the delete landed or not. Leaving it set
      // strands a still-mounted composer at "Saving…" and `aria-busy` forever.
      setBusy(false);
      return;
    }

    // **Ownership transfers here.** Sealed before the callback, as on the photo-free path, and
    // from this instant the composer never deletes this blob — unmount included.
    outcome.current = "saved";
    // Unguarded: the branch above already returned for every not-live case.
    setBusy(false);
    // A confirmed analysis lands in `MediaRef.analysis` and **nowhere else** — never in
    // `tags`, `category` or `fields`, which are the consumer's to fill (ADR-0005).
    const media: MediaRef = {
      id: newId(),
      mime: file.type,
      blobKey: key,
      ...(kept === undefined ? {} : { analysis: kept }),
    };
    snapshot.onSave({ ...input, media: [media] });
  };

  const cancel = (): void => {
    if (outcome.current !== "open") return;
    // Terminal immediately, so a write still in flight resolves into the cleanup branch above
    // rather than into a handoff. `onCancel` does not wait for that write.
    outcome.current = "cancelled";
    endAnalysis();
    // The attempt's own recipient while one is in flight; otherwise the current one.
    const recipient = attempt.current?.onCancel ?? props.onCancel;
    recipient();
  };

  /**
   * End any analysis in progress **and withdraw any authorization to send**.
   *
   * Invalidating the result alone is too late for an egress boundary: consent is spent
   * before an answer exists. An open disclosure was opened for a particular photo about to
   * be sent to a particular analyzer, and an acceptance authorised *that* send — neither
   * survives a change to what would be sent, or the end of the composition.
   */
  const endAnalysis = (): void => {
    analyzeSeq.current += 1;
    setAnalyzing(false);
    // Reachable, not defensive. Every caller — Save, Cancel, and `dropAnalysis` from photo
    // replacement or removal — can run while a disclosure is open, so `authorized` can be
    // defined here in all of them. Removal is the case that is also *spendable*: it leaves
    // the composition open, so admission still permits an accept, and the button is still
    // mounted for the rest of the task in which Remove was activated.
    authorized.current = undefined;
    setDisclosing(false);
  };

  /** The same, plus forgetting the result and the error that described the departing photo. */
  const dropAnalysis = (): void => {
    endAnalysis();
    setAnalysis(undefined);
    setAnalysisNotice(undefined);
  };

  /**
   * Whether this instance may still start work. Cancellation and handoff are terminal
   * (ADR-0027), and a pending photo-bearing Save is on its way to one — an analysis begun in
   * any of those states computes something no longer part of any composition, and for a
   * remote analyzer it also sends a photo the user has finished with.
   */
  const acceptsWork = (): boolean => outcome.current === "open" && !writing.current;

  const choosePhoto = (change: ChangeEvent<HTMLInputElement>): void => {
    const chosen = change.target.files?.[0];
    dropAnalysis();
    if (photoUrl.current !== undefined) URL.revokeObjectURL(photoUrl.current);
    if (chosen === undefined) {
      photoUrl.current = undefined;
      setPhoto(undefined);
      return;
    }
    const url = URL.createObjectURL(chosen);
    photoUrl.current = url;
    setPhoto({ file: chosen, url });
  };

  const removePhoto = (): void => {
    dropAnalysis();
    // Narrowing, not a runtime guard: this control only renders while a photo — and so its
    // URL — exists, so the undefined arm is unreachable and stays uncovered, like the other
    // strict-indexing narrowings (see the coverage note in vitest.config.ts).
    if (photoUrl.current !== undefined) URL.revokeObjectURL(photoUrl.current);
    photoUrl.current = undefined;
    setPhoto(undefined);
    // Nothing is persisted before Save, so removal has nothing to clean up.
  };

  /** One analysis request, tagged with the token that decides whether its answer is wanted. */
  const runAnalysis = (source: MediaAnalyzer, file: File): void => {
    analyzeSeq.current += 1;
    const token = analyzeSeq.current;
    setAnalyzing(true);
    setAnalysis(undefined);
    setAnalysisNotice(undefined);
    // An async IIFE rather than a promise chain, so that a synchronous throw from `analyze`
    // — a conformant implementation may fail before it returns its promise — lands in the
    // same catch as a rejection instead of escaping the click handler with `analyzing` stuck.
    void (async () => {
      try {
        const result = await source.analyze({ blob: file });
        // Every invalidation leg meets one comparison: replaced photo, removed photo, cancel,
        // Save, a replaced analyzer, or simply a newer request — each moved the token, so
        // this answer is no longer the one being waited for.
        if (token !== analyzeSeq.current) return;
        setAnalyzing(false);
        setAnalysis({ result, confirmed: false });
      } catch {
        if (token !== analyzeSeq.current) return;
        setAnalyzing(false);
        setAnalysisNotice(ANALYSIS_FAILED);
      }
    })();
  };

  /**
   * The gate. A remote analyzer sends the photo off this device, so the first activation
   * *opens the disclosure* and sends nothing; only the explicit accept below causes egress.
   * A local analyzer needs no disclosure and runs directly.
   */
  const requestAnalysis = (source: MediaAnalyzer, file: File): void => {
    if (!acceptsWork()) return;
    // **Every** remote request discloses. Consent is spent by the send it authorises: an
    // acceptance that outlived its own request would let the second, third and later
    // activations send the photo with no disclosure at all, which is not a gate on the action
    // but a gate on the first action.
    if (source.runsRemotely) {
      authorized.current = { source, file };
      setDisclosing(true);
      return;
    }
    runAnalysis(source, file);
  };

  const acceptDisclosure = (source: MediaAnalyzer, file: File): void => {
    // Admission is rechecked here, and this check *is* falsifiable — an earlier version of
    // this file argued it was unreachable because every terminal transition closes the panel.
    // That was wrong: closing the panel is a state update, which React has not committed at
    // the moment `onCancel` runs, so a consumer's cancel callback can synchronously activate
    // a button it retained and reach this handler on a settled composer. The DOM being about
    // to disappear is not the same as the handler being unreachable.
    const pending = authorized.current;
    if (pending === undefined) return;
    // **The second stated belief.** These two checks encode different things — "no
    // outstanding disclosure" above, "the composition is not terminal" here — and they
    // coincide only because every terminal transition voids the authorization. Reaching here
    // with a live authorization on a settled composer would mean that coincidence had broken,
    // which is a fact worth announcing rather than a case worth quietly refusing.
    //
    // `acceptsWork()` reads exactly two things — `outcome` and `writing` — and nothing else;
    // adding a third input to that predicate is a change to the enumeration below, not just
    // to the predicate.
    //
    // The enumeration is of the *transitions*, not of `endAnalysis`'s callers — callers ⊆
    // transitions is trivially true and proves nothing. Every assignment that makes
    // `acceptsWork()` false:
    //   - `outcome = "saved"` on the photo-free path — `save` voids before branching;
    //   - `outcome = "saved"` after a write lands — `save` already voided, and no disclosure
    //     can have opened since, because admission refuses while `writing` is true (asserted,
    //     not merely read off the code: "admits no analyzer work after handoff, or while a
    //     Save is pending" checks that no panel opens, not only that no call is made);
    //   - `outcome = "cancelled"` in `cancel` — voids;
    //   - `writing = true` in `save` — voids before setting it.
    // The analyzer's own failure paths are not transitions: the catch touches neither
    // `outcome` nor `writing`. So this throw is uncovered by design, like the mismatch above,
    // and a mutation deleting it likewise survives — an **accepted survivor**, not a gap.
    if (!acceptsWork()) {
      throw new Error(
        "EventComposer: a terminal composition still holds an outstanding photo disclosure. " +
          "Every path that ends a composition must void its authorization to send.",
      );
    }
    // **A stated belief, not a silent branch.** No known route reaches this handler with an
    // authorization for a different request: every route that could — a changed photo, a
    // changed analyzer — closes the panel first, and React delegates events at the root, so a
    // detached button's handler never runs. That is a claim about React's scheduler rather
    // than about this file, so it is asserted loudly instead of defended quietly: if a future
    // path (a drop handler, an async source) ever mounts a second way in, this announces it
    // rather than silently declining and leaving a dead branch nobody can falsify.
    //
    // **Accepted survivor.** A mutation deleting this throw passes the suite, and that is the
    // intended status, not a gap: an invariant nothing can currently violate has no failing
    // test to write. Do not "fix" it by deleting the assertion.
    if (pending.source !== source || pending.file !== file) {
      throw new Error(
        "EventComposer: a photo disclosure was accepted for a request it does not describe. " +
          "The disclosure names the exact photo and analyzer it authorises, and no send may " +
          "reuse another request's consent.",
      );
    }
    authorized.current = undefined;
    setDisclosing(false);
    runAnalysis(source, file);
  };

  const declineDisclosure = (): void => {
    authorized.current = undefined;
    setDisclosing(false);
  };

  const keepSuggestions = (result: MediaAnalysis): void => {
    setAnalysis({ result, confirmed: true });
  };

  const registerField = (key: string, control: HTMLInputElement | HTMLSelectElement | null) => {
    if (control === null) fieldControls.current.delete(key);
    else fieldControls.current.set(key, control);
  };

  const capturing = props.mode === "photo";

  return createElement(
    "form",
    { className: "mapatlas-composer", onSubmit: save, "aria-busy": busy },
    createElement(
      "label",
      { className: "mapatlas-composer-field" },
      createElement("span", null, "Photo"),
      createElement("input", {
        className: "mapatlas-composer-photo",
        type: "file",
        accept: "image/*",
        onChange: choosePhoto,
        // A *preferred* facing mode, not a guarantee (W3C html-media-capture, ADR-0027), and
        // unconditional: `mode` chooses which affordance is initially active, nothing more.
        // Gating this on `mode` would strip the camera preference from a comment-first
        // composition the moment its user decided to add a photo after all.
        capture: "environment",
        autoFocus: capturing,
      }),
    ),
    photo === undefined
      ? null
      : createElement(
          "div",
          { className: "mapatlas-composer-photo-chosen" },
          createElement("img", {
            className: "mapatlas-composer-preview",
            src: photo.url,
            alt: `Selected photo: ${photo.file.name}`,
          }),
          createElement(
            "button",
            {
              type: "button",
              className: "mapatlas-composer-photo-remove",
              onClick: removePhoto,
            },
            "Remove photo",
          ),
          analyzer === undefined
            ? null
            : createElement(
                "div",
                { className: "mapatlas-composer-analysis" },
                createElement(
                  "button",
                  {
                    type: "button",
                    className: "mapatlas-composer-analyze",
                    onClick: () => {
                      requestAnalysis(analyzer, photo.file);
                    },
                  },
                  analyzing ? "Analysing…" : "Analyse photo",
                ),
                disclosing
                  ? createElement(
                      "div",
                      { className: "mapatlas-composer-disclosure", role: "alertdialog" },
                      createElement(
                        "p",
                        null,
                        `Analysing sends this photo to ${analyzer.id}, off this device. ` +
                          "Nothing is sent unless you choose to continue.",
                      ),
                      createElement(
                        "button",
                        {
                          type: "button",
                          className: "mapatlas-composer-disclosure-accept",
                          onClick: () => {
                            acceptDisclosure(analyzer, photo.file);
                          },
                        },
                        "Send the photo and analyse",
                      ),
                      createElement(
                        "button",
                        {
                          type: "button",
                          className: "mapatlas-composer-disclosure-decline",
                          onClick: declineDisclosure,
                        },
                        "Not now",
                      ),
                    )
                  : null,
                analysisNotice === undefined
                  ? null
                  : createElement(
                      "p",
                      { role: "alert", className: "mapatlas-composer-analysis-notice" },
                      analysisNotice,
                    ),
                // One shape for every analyzer. An empty result is a *result* — it renders
                // through this same branch, saying analysis ran and found nothing, and is
                // confirmable like any other. Nothing here reads `analyzer.id`.
                analysis === undefined
                  ? null
                  : createElement(
                      "div",
                      { className: "mapatlas-composer-suggestions" },
                      analysis.result.labels.length === 0
                        ? createElement(
                            "p",
                            { className: "mapatlas-composer-suggestions-empty" },
                            "Analysis found nothing to suggest.",
                          )
                        : createElement(
                            "ul",
                            { className: "mapatlas-composer-suggestion-list" },
                            ...analysis.result.labels.map((label, index) =>
                              createElement(
                                "li",
                                { key: index },
                                `${label.label} (${String(Math.round(label.confidence * 100))}%)`,
                              ),
                            ),
                          ),
                      analysis.confirmed
                        ? createElement(
                            "p",
                            { className: "mapatlas-composer-suggestions-kept" },
                            "Kept with the photo.",
                          )
                        : createElement(
                            "button",
                            {
                              type: "button",
                              className: "mapatlas-composer-confirm",
                              onClick: () => {
                                keepSuggestions(analysis.result);
                              },
                            },
                            "Keep these suggestions",
                          ),
                    ),
              ),
        ),
    createElement(
      "label",
      { className: "mapatlas-composer-field" },
      createElement("span", null, "Comment"),
      createElement("textarea", {
        className: "mapatlas-composer-comment",
        ref: commentRef,
        autoFocus: !capturing,
      }),
    ),
    props.categories === undefined
      ? null
      : createElement(
          "label",
          { className: "mapatlas-composer-field" },
          createElement("span", null, "Category"),
          createElement(
            "select",
            { className: "mapatlas-composer-category", ref: categoryRef },
            createElement("option", { value: "" }, ""),
            // Keyed by position, for the reason the field options are — `categories[].value`
            // is equally unrestricted, so two categories may share a value.
            ...props.categories.map((entry, index) =>
              createElement("option", { key: index, value: entry.value }, entry.label),
            ),
          ),
        ),
    ...(props.fields ?? []).map((spec) => renderField(spec, registerField)),
    missingLabels.length === 0
      ? null
      : createElement(
          "p",
          { role: "alert", className: "mapatlas-composer-invalid" },
          `Required: ${missingLabels.join(", ")}`,
        ),
    notice === undefined
      ? null
      : createElement("p", { role: "alert", className: "mapatlas-composer-notice" }, notice),
    // Deliberately *not* disabled while busy: the duplicate-Save refusal is a real guard, and
    // a disabled button would hide it behind the browser rather than let it be exercised.
    createElement(
      "button",
      { type: "submit", className: "mapatlas-composer-save" },
      busy ? "Saving…" : "Save",
    ),
    createElement(
      "button",
      { type: "button", className: "mapatlas-composer-cancel", onClick: cancel },
      "Cancel",
    ),
  );
}

/**
 * The first key appearing more than once, or `undefined` when every key is unique.
 *
 * A `Set`, for the reason `Object.fromEntries` is used at Save. The natural plain-object
 * version — a seen-map tested for truthiness — reads `"__proto__"` as already-seen, because
 * the lookup answers with `Object.prototype`, and rejects a legal single use of the key.
 * (Only the truthiness reading breaks; an `=== true` test survives it. The mutation that
 * falsifies this comment is the truthy one, and it is the one run.)
 */
function firstDuplicateKey(fields: FieldSpec[] | undefined): string | undefined {
  const seen = new Set<string>();
  for (const spec of fields ?? []) {
    if (seen.has(spec.key)) return spec.key;
    seen.add(spec.key);
  }
  return undefined;
}

/** The value a control currently holds, or `undefined` when it holds none. */
function readFieldValue(
  spec: FieldSpec,
  control: HTMLInputElement | HTMLSelectElement,
): JSONValue | undefined {
  if (spec.type === "boolean") return (control as HTMLInputElement).checked;
  if (spec.type === "select") {
    // Missing-ness is *this component's placeholder being selected*, never the empty string.
    // `FieldSpec` does not reserve "", so a consumer option may legally carry `value: ""` and
    // has to round-trip as "" — reading `control.value === ""` would make that real value
    // indistinguishable from no selection, which is the displayed-text reading the value bars
    // forbid. The placeholder is the option rendered at index 0, so identity discriminates
    // even when a consumer option shares its value.
    const select = control as HTMLSelectElement;
    return select.selectedIndex === 0 ? undefined : select.value;
  }
  const raw = control.value;
  if (raw === "") return undefined;
  // Reaching here through a submission implies the control was valid. The number-state
  // contract (HTML, input type=number) flags `badInput` for exactly the strings whose parse is
  // not a finite double, and `Number()` agrees with that grammar on everything validity
  // admits — so in a conformant browser `raw` is "" (handled above) or the spelling of a
  // finite number, and a finiteness guard here could never fire. happy-dom checks a regex
  // instead — it admits some non-finite spellings and rejects finite ones like "1e2" — so this
  // boundary is pinned in the real-browser lane (e2e/event-composer.e2e.ts), never proven in
  // the unit lane, and not compensated for with code only that fake could reach.
  if (spec.type === "number") return Number(raw);
  return raw;
}

/** One labelled control per spec. `name` carries the key for consumer styling and tests. */
function renderField(
  spec: FieldSpec,
  register: (key: string, control: HTMLInputElement | HTMLSelectElement | null) => void,
): ReactElement {
  const shared = {
    name: spec.key,
    ...(spec.required === true ? { "aria-required": true } : {}),
    ref: (control: HTMLInputElement | HTMLSelectElement | null) => {
      register(spec.key, control);
    },
  };
  let control: ReactNode;
  switch (spec.type) {
    case "select":
      control = createElement(
        "select",
        shared,
        createElement("option", { value: "" }, spec.placeholder ?? ""),
        // Keyed by position, not by value: the contract restricts `options[].value` in no
        // way, so two options may deliberately share one — presentation differing over the
        // same stored value loses nothing, unlike a duplicate `FieldSpec.key`. Value-keying
        // would collide those siblings in reconciliation. Position is a sound identity here
        // because the option list is configuration, fixed for the mounted composition.
        ...(spec.options ?? []).map((option, index) =>
          createElement("option", { key: index, value: option.value }, option.label),
        ),
      );
      break;
    case "boolean":
      control = createElement("input", { ...shared, type: "checkbox" });
      break;
    default:
      control = createElement("input", {
        ...shared,
        type: spec.type,
        // The default step of 1 makes every decimal a stepMismatch, and constraint validation
        // then blocks submission before Save ever runs; a number field takes any number.
        ...(spec.type === "number" ? { step: "any" } : {}),
        ...(spec.placeholder === undefined ? {} : { placeholder: spec.placeholder }),
      });
  }
  return createElement(
    "label",
    { className: "mapatlas-composer-field", key: spec.key },
    createElement("span", null, spec.label),
    control,
    spec.unit === undefined
      ? null
      : createElement("span", { className: "mapatlas-composer-unit" }, spec.unit),
  );
}
