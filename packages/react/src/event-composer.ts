// SPDX-License-Identifier: Apache-2.0

import { createElement, useEffect, useRef, useState } from "react";
import type { ChangeEvent, FormEvent, ReactElement, ReactNode } from "react";

import { newId } from "@mapatlas/core";
import type { JSONValue, LatLng, MapEvent, MediaRef, StorageAdapter } from "@mapatlas/core";

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
 * photo, and save/cancel (`api.md` §9, ADR-0027). `analyzer` is the one prop still to come —
 * it joins with the increment that gives it behaviour; everything documented here is built.
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
  const [busy, setBusy] = useState(false);
  const [photo, setPhoto] = useState<{ file: File; url: string } | undefined>(undefined);
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
    void completeWithPhoto(input, photo.file, snapshot);
  };

  /** The photo-bearing half of one Save attempt: exactly one `putBlob`, then ownership. */
  const completeWithPhoto = async (
    input: Omit<MapEvent, "id" | "position">,
    file: File,
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
    const media: MediaRef = { id: newId(), mime: file.type, blobKey: key };
    snapshot.onSave({ ...input, media: [media] });
  };

  const cancel = (): void => {
    if (outcome.current !== "open") return;
    // Terminal immediately, so a write still in flight resolves into the cleanup branch above
    // rather than into a handoff. `onCancel` does not wait for that write.
    outcome.current = "cancelled";
    // The attempt's own recipient while one is in flight; otherwise the current one.
    const recipient = attempt.current?.onCancel ?? props.onCancel;
    recipient();
  };

  const choosePhoto = (change: ChangeEvent<HTMLInputElement>): void => {
    const chosen = change.target.files?.[0];
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
    // Narrowing, not a runtime guard: this control only renders while a photo — and so its
    // URL — exists, so the undefined arm is unreachable and stays uncovered, like the other
    // strict-indexing narrowings (see the coverage note in vitest.config.ts).
    if (photoUrl.current !== undefined) URL.revokeObjectURL(photoUrl.current);
    photoUrl.current = undefined;
    setPhoto(undefined);
    // Nothing is persisted before Save, so removal has nothing to clean up.
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
