// SPDX-License-Identifier: Apache-2.0

import { createElement, useRef, useState } from "react";
import type { FormEvent, ReactElement, ReactNode } from "react";

import type { JSONValue, LatLng, MapEvent, StorageAdapter } from "@mapatlas/core";

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
 * Compose one event at a position: comment, category, consumer-defined fields, save/cancel
 * (`api.md` §9, T5.3 — this increment carries no photo and no analyzer; `mode` and `analyzer`
 * join the props with the increments that give them behaviour, ADR-0027).
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
 * **A photo-free Save performs zero blob writes.** The `store` exists for photo handoff
 * (ADR-0027's ownership table, next increment); this path never touches it.
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
  onSave(input: Omit<MapEvent, "id" | "position">): void;
  onCancel(): void;
}): ReactElement {
  const settled = useRef(false);
  // The initializer runs on every render and only the first result is kept — the accepted cost
  // of `useRef` initialisation; `Date.now()` is idempotent enough to pay it.
  const openedAt = useRef(Date.now());

  const commentRef = useRef<HTMLTextAreaElement | null>(null);
  const categoryRef = useRef<HTMLSelectElement | null>(null);
  const fieldControls = useRef(new Map<string, HTMLInputElement | HTMLSelectElement>());
  const [missingLabels, setMissingLabels] = useState<readonly string[]>([]);

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
    if (settled.current) return;

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
    settled.current = true;
    props.onSave(input);
  };

  const cancel = (): void => {
    if (settled.current) return;
    settled.current = true;
    props.onCancel();
  };

  const registerField = (key: string, control: HTMLInputElement | HTMLSelectElement | null) => {
    if (control === null) fieldControls.current.delete(key);
    else fieldControls.current.set(key, control);
  };

  return createElement(
    "form",
    { className: "mapatlas-composer", onSubmit: save },
    createElement(
      "label",
      { className: "mapatlas-composer-field" },
      createElement("span", null, "Comment"),
      createElement("textarea", { className: "mapatlas-composer-comment", ref: commentRef }),
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
            ...props.categories.map((entry) =>
              createElement("option", { key: entry.value, value: entry.value }, entry.label),
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
    createElement("button", { type: "submit", className: "mapatlas-composer-save" }, "Save"),
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
        ...(spec.options ?? []).map((option) =>
          createElement("option", { key: option.value, value: option.value }, option.label),
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
