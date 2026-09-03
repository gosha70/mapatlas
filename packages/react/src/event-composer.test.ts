// @vitest-environment happy-dom
// SPDX-License-Identifier: Apache-2.0

import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import type { MapEvent, StorageAdapter } from "@mapatlas/core";

import { EventComposer } from "./event-composer.js";
import type { FieldSpec } from "./event-composer.js";
import { renderComponent } from "./testing/render-hook.js";

type SaveInput = Omit<MapEvent, "id" | "position">;
type ComposerProps = Parameters<typeof EventComposer>[0];

/**
 * A store that records every method it is asked for and answers vacuously.
 *
 * The composer's contract with the store in this increment is *silence*: a photo-free Save
 * performs zero blob writes (ADR-0027), and nothing else in the composer has any business with
 * persistence either. Recording every method — not just `putBlob` — is what lets the assertion
 * say "never touched" instead of "never wrote a blob".
 */
function fakeStore(): { adapter: StorageAdapter; calls: string[] } {
  const calls: string[] = [];
  const answer = <T>(name: string, result: T): (() => Promise<T>) => {
    return () => {
      calls.push(name);
      return Promise.resolve(result);
    };
  };
  const adapter: StorageAdapter = {
    saveTrack: answer("saveTrack", undefined),
    getTrack: answer("getTrack", undefined),
    listTrackSummaries: answer("listTrackSummaries", []),
    deleteTrack: answer("deleteTrack", undefined),
    saveEvent: answer("saveEvent", undefined),
    getEvent: answer("getEvent", undefined),
    listEvents: answer("listEvents", []),
    deleteEvent: answer("deleteEvent", undefined),
    putBlob: answer("putBlob", "unused-key"),
    getBlob: answer("getBlob", undefined),
    deleteBlob: answer("deleteBlob", undefined),
    clearAll: answer("clearAll", undefined),
  };
  return { adapter, calls };
}

interface Mounted {
  container: HTMLElement;
  rerender: (props: ComposerProps) => Promise<void>;
  unmount: () => Promise<void>;
  saves: SaveInput[];
  cancels: () => number;
  store: ReturnType<typeof fakeStore>;
}

/** Mount with recording callbacks; `overrides` may replace any prop, callbacks included. */
async function mount(overrides: Partial<ComposerProps> = {}): Promise<Mounted> {
  const store = fakeStore();
  const saves: SaveInput[] = [];
  let cancelled = 0;
  const props: ComposerProps = {
    at: { lat: 59.33, lng: 18.06 },
    store: store.adapter,
    onSave: (input) => {
      saves.push(input);
    },
    onCancel: () => {
      cancelled += 1;
    },
    ...overrides,
  };
  const harness = await renderComponent(EventComposer, props);
  return {
    container: harness.container,
    rerender: harness.rerender,
    unmount: harness.unmount,
    saves,
    cancels: () => cancelled,
    store,
  };
}

/** The one element matching `selector`, or a loud failure naming what is missing. */
function find<T extends Element>(container: ParentNode, selector: string): T {
  const element = container.querySelector<T>(selector);
  if (element === null) throw new Error(`no element matches ${selector}`);
  return element;
}

function field<T extends HTMLInputElement | HTMLSelectElement>(
  container: ParentNode,
  key: string,
): T {
  return find<T>(container, `[name="${key}"]`);
}

async function clickSave(container: ParentNode): Promise<void> {
  const button = find<HTMLButtonElement>(container, ".mapatlas-composer-save");
  await act(async () => {
    button.click();
  });
}

async function clickCancel(container: ParentNode): Promise<void> {
  const button = find<HTMLButtonElement>(container, ".mapatlas-composer-cancel");
  await act(async () => {
    button.click();
  });
}

describe("EventComposer — save and cancel (T5.3 increment 1)", () => {
  it("hands over exactly the published input on a photo-free Save, touching the store never", async () => {
    const { container, saves, store } = await mount({
      categories: [
        { value: "c1", label: "First kind" },
        { value: "c2", label: "Second kind" },
      ],
      occurredAt: 1_234,
    });

    find<HTMLTextAreaElement>(container, ".mapatlas-composer-comment").value =
      "seen from the trail";
    find<HTMLSelectElement>(container, ".mapatlas-composer-category").value = "c2";
    await clickSave(container);

    // `toStrictEqual`, because `toEqual` ignores undefined-valued properties: this pins that
    // `trackId`, `fields`, `id` and `position` are absent even as `key: undefined`, that
    // `category` is the option's value and not its label, and that the empty media/tags arrays
    // are present rather than omitted.
    expect(saves).toStrictEqual([
      {
        occurredAt: 1_234,
        media: [],
        tags: [],
        comment: "seen from the trail",
        category: "c2",
      },
    ]);
    expect(store.calls, "the photo-free path talked to the store").toEqual([]);
  });

  it("omits comment and category that were never entered", async () => {
    const { container, saves } = await mount({ occurredAt: 5 });
    await clickSave(container);
    expect(saves).toStrictEqual([{ occurredAt: 5, media: [], tags: [] }]);
  });

  it("defaults occurredAt to the moment composition began, not the moment of Save", async () => {
    // The clock is held at a fixed, distant past value across the mount only, and runs
    // normally for the Save. Bounding the emitted value between two real readings would not
    // do: mount and Save land in the same millisecond often enough that reading the clock at
    // Save time passes anyway — the distinction is only observable when the two moments are
    // separated by more than scheduling luck.
    const openedAt = 1_700_000_000_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(openedAt);
    let mounted: Mounted;
    try {
      mounted = await mount();
    } finally {
      clock.mockRestore();
    }

    expect(
      Date.now(),
      "the real clock must be far past the stub for this to prove anything",
    ).toBeGreaterThan(openedAt);
    await clickSave(mounted.container);
    expect(mounted.saves).toStrictEqual([{ occurredAt: openedAt, media: [], tags: [] }]);
  });

  it("emits field values as values: 0, false, and strings that never met a Date", async () => {
    const fields: FieldSpec[] = [
      { key: "count", label: "Count", type: "number", unit: "pieces" },
      { key: "flag", label: "Flag", type: "boolean" },
      { key: "lit", label: "Lit", type: "boolean" },
      { key: "when", label: "When", type: "date" },
      {
        key: "choice",
        label: "Choice",
        type: "select",
        options: [
          { value: "v1", label: "Shown one" },
          { value: "v2", label: "Shown two" },
        ],
      },
      { key: "note", label: "Note", type: "text" },
      { key: "blank", label: "Blank", type: "text" },
    ];
    const { container, saves } = await mount({ fields, occurredAt: 9 });

    field<HTMLInputElement>(container, "count").value = "0";
    field<HTMLInputElement>(container, "lit").checked = true;
    field<HTMLInputElement>(container, "when").value = "2026-09-02";
    field<HTMLSelectElement>(container, "choice").value = "v2";
    field<HTMLInputElement>(container, "note").value = "plain words";
    await clickSave(container);

    // `count: 0` and `flag: false` pin that inclusion is by missing-ness, not truthiness;
    // `when` pins the date as the entered string — a Date round-trip alters it (`toISOString()`
    // re-serialises to a UTC datetime string; local-date formatting shifts the day anywhere
    // west of UTC); `choice: "v2"` pins value-not-label; `blank` untouched pins key omission.
    expect(saves).toStrictEqual([
      {
        occurredAt: 9,
        media: [],
        tags: [],
        fields: {
          count: 0,
          flag: false,
          lit: true,
          when: "2026-09-02",
          choice: "v2",
          note: "plain words",
        },
      },
    ]);
  });

  it("rejects duplicate field keys rather than resolving them by order", async () => {
    // `MapEvent.fields` is keyed by `key`, so these two cannot both survive Save. Last-wins
    // would discard "First" silently, after the user had already typed into it.
    const fields: FieldSpec[] = [
      { key: "rating", label: "First", type: "number" },
      { key: "rating", label: "Second", type: "text" },
    ];
    await expect(mount({ fields })).rejects.toThrow(/duplicate FieldSpec key "rating"/);
  });

  it("accepts a key that repeats across separate composers, and a single __proto__", async () => {
    // The uniqueness scope is one composer, not the process — and the check uses a Set, so a
    // single "__proto__" is a legal key rather than one that reads as already-seen.
    const fields: FieldSpec[] = [
      { key: "rating", label: "Rating", type: "text" },
      { key: "__proto__", label: "Proto", type: "text" },
    ];
    const first = await mount({ fields, occurredAt: 9 });
    const second = await mount({ fields, occurredAt: 9 });
    field<HTMLInputElement>(first.container, "rating").value = "one";
    field<HTMLInputElement>(second.container, "rating").value = "two";
    await clickSave(first.container);
    await clickSave(second.container);

    expect(first.saves[0]?.fields?.["rating"]).toBe("one");
    expect(second.saves[0]?.fields?.["rating"]).toBe("two");
  });

  it("keeps an empty-string option value as a value, distinct from no selection", async () => {
    // `FieldSpec.options[].value` is an unrestricted string, so `""` is a legal consumer value
    // and must survive as `""`. Reading missing-ness as `value === ""` would confuse the two:
    // this field is `required`, so that reading blocks a Save the contract permits.
    const fields: FieldSpec[] = [
      {
        key: "condition",
        label: "Condition",
        type: "select",
        required: true,
        options: [
          { value: "", label: "Unknown" },
          { value: "good", label: "Good" },
        ],
      },
    ];
    const { container, saves } = await mount({ fields, occurredAt: 9 });
    const select = field<HTMLSelectElement>(container, "condition");

    // Leg one: the placeholder is still selected, so the required value is genuinely missing.
    await clickSave(container);
    expect(saves, "the placeholder must read as no selection").toEqual([]);
    expect(find<HTMLElement>(container, ".mapatlas-composer-invalid").textContent).toContain(
      "Condition",
    );

    // Leg two: the consumer's own `""` option. Selected by index, because assigning `.value`
    // would match the placeholder first and prove nothing about the option under test.
    select.selectedIndex = 1;
    expect(select.value, "the option under test must carry the empty string").toBe("");
    await clickSave(container);
    expect(saves).toStrictEqual([
      { occurredAt: 9, media: [], tags: [], fields: { condition: "" } },
    ]);
  });

  it("keeps an empty-string category value, distinct from no category", async () => {
    const categories = [
      { value: "", label: "Unclassified" },
      { value: "c1", label: "First kind" },
    ];
    const { container, saves } = await mount({ categories, occurredAt: 9 });
    const select = find<HTMLSelectElement>(container, ".mapatlas-composer-category");

    // Leg one: nothing chosen — the key is absent, not present as "".
    await clickSave(container);
    expect(saves).toStrictEqual([{ occurredAt: 9, media: [], tags: [] }]);

    // Leg two: a fresh instance, choosing the consumer's `""` category.
    const second = await mount({ categories, occurredAt: 9 });
    const secondSelect = find<HTMLSelectElement>(second.container, ".mapatlas-composer-category");
    secondSelect.selectedIndex = 1;
    expect(secondSelect.value).toBe("");
    await clickSave(second.container);
    expect(second.saves).toStrictEqual([{ occurredAt: 9, media: [], tags: [], category: "" }]);
    expect(select.selectedIndex, "the first instance must be untouched").toBe(0);
  });

  it("accepts occurredAt: 0 — the epoch is a supplied value, not an absent one", async () => {
    // The default applies when the prop is *absent*; 0 is a number the consumer supplied.
    // `occurredAt || Date.now()` would silently replace it with the open time — the same
    // truthiness class already falsified for field values.
    const { container, saves } = await mount({ occurredAt: 0 });
    await clickSave(container);
    expect(saves).toStrictEqual([{ occurredAt: 0, media: [], tags: [] }]);
  });

  it("never resamples occurredAt — a blocked Save and its retry keep the opening moment", async () => {
    // The capture-once contract (api.md, ADR-0027): a composer open while the user types, and
    // every retry after a validation failure, carry the moment composition began. Resampling
    // at Save would stamp the retry instead.
    const fields: FieldSpec[] = [{ key: "note", label: "Note", type: "text", required: true }];
    const openedAt = 1_700_000_000_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(openedAt);
    let mounted: Mounted;
    try {
      mounted = await mount({ fields });
    } finally {
      clock.mockRestore();
    }

    await clickSave(mounted.container);
    expect(mounted.saves, "the required field was empty").toEqual([]);
    field<HTMLInputElement>(mounted.container, "note").value = "corrected";
    await clickSave(mounted.container);

    expect(mounted.saves).toStrictEqual([
      { occurredAt: openedAt, media: [], tags: [], fields: { note: "corrected" } },
    ]);
  });

  it("renders the presentational half of FieldSpec: placeholder, unit, and required", async () => {
    // These properties are published surface that only the DOM shows — the save path never
    // reads them, so a value assertion cannot reach them and dropping one would be invisible.
    // `placeholder` does double duty: the attribute on an input, the empty option's label on a
    // select, where a select carrying no `options` at all is the whole control.
    const fields: FieldSpec[] = [
      { key: "note", label: "Note", type: "text", placeholder: "what you saw" },
      { key: "count", label: "Count", type: "number", unit: "pieces", required: true },
      { key: "empty", label: "Empty", type: "select", placeholder: "pick one" },
    ];
    const { container } = await mount({ fields });

    expect(field<HTMLInputElement>(container, "note").placeholder).toBe("what you saw");
    expect(
      find<HTMLElement>(container, ".mapatlas-composer-unit").textContent,
      "the unit must be shown beside its control",
    ).toBe("pieces");
    expect(
      field<HTMLInputElement>(container, "count").getAttribute("aria-required"),
      "required must be announced, not only enforced",
    ).toBe("true");
    expect(field<HTMLInputElement>(container, "note").hasAttribute("aria-required")).toBe(false);

    // An optionless select is a placeholder and nothing else — not a crash, and not a control
    // that silently drops the empty choice the omission bar depends on.
    const optionless = field<HTMLSelectElement>(container, "empty");
    expect([...optionless.options].map((option) => [option.value, option.textContent])).toEqual([
      ["", "pick one"],
    ]);
  });

  it("blocks Save on a missing required value, keeps the draft, and yields to a corrected retry", async () => {
    const fields: FieldSpec[] = [{ key: "count", label: "Count", type: "number", required: true }];
    const { container, saves } = await mount({ fields, occurredAt: 9 });
    find<HTMLTextAreaElement>(container, ".mapatlas-composer-comment").value = "kept words";

    await clickSave(container);
    expect(saves, "a blocked Save must not hand anything over").toEqual([]);
    const notice = find<HTMLParagraphElement>(container, ".mapatlas-composer-invalid");
    expect(notice.getAttribute("role")).toBe("alert");
    expect(notice.textContent).toContain("Count");
    expect(
      find<HTMLTextAreaElement>(container, ".mapatlas-composer-comment").value,
      "the draft must survive a blocked Save",
    ).toBe("kept words");

    // The correction is `0`: a required check written as truthiness would still block it.
    field<HTMLInputElement>(container, "count").value = "0";
    await clickSave(container);
    expect(saves).toStrictEqual([
      { occurredAt: 9, media: [], tags: [], comment: "kept words", fields: { count: 0 } },
    ]);
    expect(container.querySelector(".mapatlas-composer-invalid")).toBeNull();
  });

  it("submits a decimal — the numeric control must not inherit the default step", async () => {
    // Without step="any" the input inherits step=1, "1.5" is a stepMismatch, and constraint
    // validation blocks submission before Save ever runs — zero onSave calls, no notice.
    const fields: FieldSpec[] = [{ key: "count", label: "Count", type: "number" }];
    const { container, saves } = await mount({ fields, occurredAt: 9 });

    field<HTMLInputElement>(container, "count").value = "1.5";
    await clickSave(container);
    expect(saves, "constraint validation rejected the decimal before Save ran").toStrictEqual([
      { occurredAt: 9, media: [], tags: [], fields: { count: 1.5 } },
    ]);
  });

  it("carries a field key that a plain object literal would swallow", async () => {
    // "__proto__" is a key FieldSpec does not reserve. Assignment into an ordinary object
    // invokes the inherited setter instead of creating an own property, discarding the value.
    const fields: FieldSpec[] = [{ key: "__proto__", label: "Proto", type: "text" }];
    const { container, saves } = await mount({ fields, occurredAt: 9 });

    field<HTMLInputElement>(container, "__proto__").value = "kept";
    await clickSave(container);
    const bag = saves[0]?.fields ?? {};
    // Read as an own property — a plain `bag["__proto__"]` would answer from the prototype —
    // and through JSON, the transport the bag exists for.
    expect(Object.getOwnPropertyDescriptor(bag, "__proto__")?.value).toBe("kept");
    expect(JSON.stringify(bag)).toBe('{"__proto__":"kept"}');
  });

  it("is terminal after Save: no second submission, no late cancel", async () => {
    const { container, saves, cancels } = await mount();
    await clickSave(container);
    await clickSave(container);
    await clickCancel(container);
    expect(saves).toHaveLength(1);
    expect(cancels(), "cancel after a completed Save must do nothing").toBe(0);
  });

  it("is terminal after Cancel: onCancel exactly once, onSave never", async () => {
    const { container, saves, cancels } = await mount();
    await clickCancel(container);
    await clickSave(container);
    await clickCancel(container);
    expect(cancels()).toBe(1);
    expect(saves, "a cancelled composer must never save").toEqual([]);
  });

  it("seals itself before invoking onSave, so a reentrant callback cannot resubmit", async () => {
    const saves: SaveInput[] = [];
    const { container, cancels } = await mount({
      onSave: (input) => {
        saves.push(input);
        // Reentrancy, bounded so a broken guard fails an assertion instead of overflowing the
        // stack: sealed-after-callback would let each invocation submit again.
        if (saves.length < 3) {
          find<HTMLButtonElement>(container, ".mapatlas-composer-save").click();
        }
      },
    });
    await clickSave(container);
    expect(saves, "a reentrant onSave produced a second submission").toHaveLength(1);
    expect(cancels()).toBe(0);
  });

  it("seals itself before invoking onCancel, so a reentrant cancel cannot become a save", async () => {
    const saves: SaveInput[] = [];
    let cancelled = 0;
    const { container } = await mount({
      onSave: (input) => {
        saves.push(input);
      },
      onCancel: () => {
        cancelled += 1;
        find<HTMLButtonElement>(container, ".mapatlas-composer-save").click();
      },
    });
    await clickCancel(container);
    expect(cancelled).toBe(1);
    expect(saves, "a reentrant onCancel reached onSave").toEqual([]);
  });

  it("stays sealed when onSave throws — the terminal state precedes the callback", async () => {
    const saves: SaveInput[] = [];
    const { container, cancels } = await mount({
      onSave: (input) => {
        saves.push(input);
        throw new Error("the consumer failed after receiving the input");
      },
    });

    // React reports the handler's error through the dispatch machinery rather than rethrowing
    // to the `click()` caller, so the throw's transport is not asserted — only what it must not
    // do: unseal the composer. Sealed-after-callback is never reached on this path at all.
    await act(async () => {
      try {
        find<HTMLButtonElement>(container, ".mapatlas-composer-save").click();
      } catch {
        // either propagation behaviour is acceptable
      }
    });

    await clickSave(container);
    await clickCancel(container);
    expect(saves, "a throwing onSave reopened the composer").toHaveLength(1);
    expect(cancels()).toBe(0);
  });

  it("still cancels while a validation notice is showing", async () => {
    const fields: FieldSpec[] = [{ key: "note", label: "Note", type: "text", required: true }];
    const { container, saves, cancels } = await mount({ fields });
    await clickSave(container);
    expect(container.querySelector(".mapatlas-composer-invalid")).not.toBeNull();
    await clickCancel(container);
    expect(cancels(), "validation must not lock out cancellation").toBe(1);
    expect(saves).toEqual([]);
  });

  it("invokes the callbacks it was last rendered with", async () => {
    const first: SaveInput[] = [];
    const second: SaveInput[] = [];
    const mounted = await mount({
      occurredAt: 9,
      onSave: (input) => {
        first.push(input);
      },
    });
    await mounted.rerender({
      at: { lat: 59.33, lng: 18.06 },
      store: mounted.store.adapter,
      occurredAt: 9,
      onSave: (input) => {
        second.push(input);
      },
      onCancel: () => undefined,
    });

    await clickSave(mounted.container);
    expect(first, "Save reached a callback from an earlier render").toEqual([]);
    expect(second).toHaveLength(1);
  });
});
