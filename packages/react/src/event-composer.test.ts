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

/**
 * A store whose `putBlob` and `deleteBlob` are *parked* until the test settles them.
 *
 * The ownership table is entirely about what happens while a write is in flight — cancel,
 * unmount, a duplicate Save, a prop replacement — so a fake that resolves immediately cannot
 * express any of it. Every call is recorded with its arguments, and the pending promises are
 * settled by hand, which is what makes "the write landed *after* the cancel" a thing a test
 * can state rather than race for.
 */
function parkedStore(): {
  adapter: StorageAdapter;
  puts: { blob: Blob; settle: (key: string) => void; fail: (why: string) => void }[];
  deletes: { key: string; settle: () => void; fail: (why: string) => void }[];
  calls: string[];
} {
  const calls: string[] = [];
  const puts: { blob: Blob; settle: (key: string) => void; fail: (why: string) => void }[] = [];
  const deletes: { key: string; settle: () => void; fail: (why: string) => void }[] = [];
  const base = fakeStore();
  const adapter: StorageAdapter = {
    ...base.adapter,
    putBlob: (blob) => {
      calls.push("putBlob");
      return new Promise<string>((resolve, reject) => {
        puts.push({
          blob,
          settle: resolve,
          fail: (why) => {
            reject(new Error(why));
          },
        });
      });
    },
    deleteBlob: (key) => {
      calls.push("deleteBlob");
      return new Promise<void>((resolve, reject) => {
        deletes.push({
          key,
          settle: resolve,
          fail: (why) => {
            reject(new Error(why));
          },
        });
      });
    },
  };
  return { adapter, puts, deletes, calls };
}

/** A one-pixel-ish stand-in; the bytes only have to be identifiable on the way through. */
function photoFile(name = "shot.jpg"): File {
  return new File([new Uint8Array([1, 2, 3, 4])], name, { type: "image/jpeg" });
}

/** Put a file into a real file input and fire the change React listens for. */
async function selectPhoto(container: ParentNode, file: File): Promise<void> {
  const input = find<HTMLInputElement>(container, ".mapatlas-composer-photo");
  const transfer = new DataTransfer();
  transfer.items.add(file);
  input.files = transfer.files;
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

/** Let the microtask queue drain inside `act`, so a settled write's continuation runs. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
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

  it("allows two options, or two categories, to share a value", async () => {
    // The contract restricts neither `options[].value` nor `categories[].value`, and unlike a
    // duplicate `FieldSpec.key` nothing is lost: both choices deliberately mean the same
    // stored value, and the labels are presentation. Keying the <option> elements by value
    // would make these siblings collide in reconciliation.
    const fields: FieldSpec[] = [
      {
        key: "choice",
        label: "Choice",
        type: "select",
        options: [
          { value: "same", label: "Choice A" },
          { value: "same", label: "Choice B" },
        ],
      },
    ];
    const categories = [
      { value: "dup", label: "Category A" },
      { value: "dup", label: "Category B" },
    ];

    const warnings: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      warnings.push(args.map((arg) => String(arg)).join(" "));
    });
    let mounted: Mounted;
    try {
      mounted = await mount({ fields, categories, occurredAt: 9 });
    } finally {
      spy.mockRestore();
    }

    // Both labels survive: a duplicate key can drop a sibling outright.
    const choice = field<HTMLSelectElement>(mounted.container, "choice");
    expect([...choice.options].map((option) => option.textContent)).toEqual([
      "",
      "Choice A",
      "Choice B",
    ]);
    const category = find<HTMLSelectElement>(mounted.container, ".mapatlas-composer-category");
    expect([...category.options].map((option) => option.textContent)).toEqual([
      "",
      "Category A",
      "Category B",
    ]);

    // The second of each shares the first's value, and Save emits that shared value.
    choice.selectedIndex = 2;
    category.selectedIndex = 2;
    await clickSave(mounted.container);
    expect(mounted.saves).toStrictEqual([
      { occurredAt: 9, media: [], tags: [], category: "dup", fields: { choice: "same" } },
    ]);

    expect(
      warnings.filter((line) => line.includes("same key")),
      "React reported colliding sibling keys",
    ).toEqual([]);
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

describe("EventComposer — the photo handoff (T5.3 increment 2, ADR-0027)", () => {
  /** Mount with a parked store and a selected photo, ready for the Save under test. */
  async function composed(
    overrides: Partial<ComposerProps> = {},
  ): Promise<Mounted & { store: ReturnType<typeof parkedStore>; file: File }> {
    const store = parkedStore();
    const saves: SaveInput[] = [];
    let cancelled = 0;
    const props: ComposerProps = {
      at: { lat: 59.33, lng: 18.06 },
      store: store.adapter,
      occurredAt: 9,
      onSave: (input) => {
        saves.push(input);
      },
      onCancel: () => {
        cancelled += 1;
      },
      ...overrides,
    };
    const harness = await renderComponent(EventComposer, props);
    const file = photoFile();
    await selectPhoto(harness.container, file);
    return {
      container: harness.container,
      rerender: harness.rerender,
      unmount: harness.unmount,
      saves,
      cancels: () => cancelled,
      store: store as never,
      file,
    } as never;
  }

  it("writes the selected bytes once and hands over the key it was given", async () => {
    const c = await composed();
    await clickSave(c.container);

    expect(c.store.puts).toHaveLength(1);
    expect(c.store.puts[0]?.blob, "the bytes written must be the selected file").toBe(c.file);
    expect(c.saves, "onSave must not run before the write resolves").toEqual([]);

    c.store.puts[0]?.settle("blob-key-1");
    await flush();

    expect(c.saves).toHaveLength(1);
    const media = c.saves[0]?.media ?? [];
    expect(media).toHaveLength(1);
    expect(media[0]?.blobKey).toBe("blob-key-1");
    expect(media[0]?.mime).toBe("image/jpeg");
    expect(media[0]?.id, "the MediaRef needs its own id").toEqual(expect.any(String));
    expect(c.store.calls, "exactly one write, and no deletion").toEqual(["putBlob"]);
  });

  it("refuses a duplicate Save while the write is in flight — one putBlob per attempt", async () => {
    const c = await composed();
    await clickSave(c.container);
    await clickSave(c.container);
    await clickSave(c.container);

    expect(c.store.puts, "a duplicate Save started a second write").toHaveLength(1);
    c.store.puts[0]?.settle("k");
    await flush();
    expect(c.saves, "the duplicates must not produce extra handoffs").toHaveLength(1);
  });

  it("treats a rejection as an unknown outcome: draft kept, no onSave, retry allowed", async () => {
    const c = await composed();
    find<HTMLTextAreaElement>(c.container, ".mapatlas-composer-comment").value = "kept words";
    await clickSave(c.container);
    c.store.puts[0]?.fail("network died after the bytes left");
    await flush();

    expect(c.saves, "a rejected write must not reach onSave").toEqual([]);
    const notice = find<HTMLElement>(c.container, ".mapatlas-composer-notice");
    // The wording may not claim nothing was stored — a remote adapter can persist the bytes
    // and lose the response, so the honest report is that the write is unconfirmed.
    expect(notice.textContent?.toLowerCase()).toContain("may or may not");
    expect(notice.getAttribute("role")).toBe("alert");
    expect(
      find<HTMLTextAreaElement>(c.container, ".mapatlas-composer-comment").value,
      "the draft must survive a rejected write",
    ).toBe("kept words");
    expect(c.store.calls, "there is no key to clean up after a rejection").toEqual(["putBlob"]);

    // The retry is a fresh attempt, and performs exactly one further write.
    await clickSave(c.container);
    expect(c.store.puts).toHaveLength(2);
    c.store.puts[1]?.settle("blob-key-2");
    await flush();
    expect(c.saves).toHaveLength(1);
    expect(c.saves[0]?.media?.[0]?.blobKey).toBe("blob-key-2");
    expect(c.saves[0]?.comment).toBe("kept words");

    // ...and the instance is terminal afterwards.
    await clickSave(c.container);
    expect(c.store.puts, "a Save after handoff started another write").toHaveLength(2);
  });

  it("cleans up a write that lands after cancel, and never calls onSave", async () => {
    const c = await composed();
    await clickSave(c.container);
    await clickCancel(c.container);
    expect(c.cancels(), "cancel must not wait for the write").toBe(1);

    c.store.puts[0]?.settle("orphan-key");
    await flush();

    expect(c.saves, "a cancelled composition must never hand over").toEqual([]);
    expect(c.store.deletes, "the landed blob was left behind").toHaveLength(1);
    expect(c.store.deletes[0]?.key).toBe("orphan-key");
  });

  it("cleans up a write that lands after unmount", async () => {
    const c = await composed();
    await clickSave(c.container);
    await c.unmount();

    c.store.puts[0]?.settle("unmounted-key");
    await flush();

    expect(c.saves).toEqual([]);
    expect(c.store.deletes).toHaveLength(1);
    expect(c.store.deletes[0]?.key).toBe("unmounted-key");
  });

  it("never deletes the blob once onSave has received the key, unmount included", async () => {
    const c = await composed();
    await clickSave(c.container);
    c.store.puts[0]?.settle("owned-by-consumer");
    await flush();
    expect(c.saves).toHaveLength(1);

    await c.unmount();
    await flush();

    expect(
      c.store.deletes,
      "ownership had transferred — the composer deleted the consumer's blob",
    ).toEqual([]);
    expect(c.store.calls).toEqual(["putBlob"]);
  });

  it("completes a parked write against the snapshotted store and callback", async () => {
    const first = parkedStore();
    const second = parkedStore();
    const toFirst: SaveInput[] = [];
    const toSecond: SaveInput[] = [];
    const harness = await renderComponent(EventComposer, {
      at: { lat: 59.33, lng: 18.06 },
      store: first.adapter,
      occurredAt: 9,
      onSave: (input) => {
        toFirst.push(input);
      },
      onCancel: () => undefined,
    });
    await selectPhoto(harness.container, photoFile());
    await clickSave(harness.container);
    expect(first.puts).toHaveLength(1);

    // Replace *both* the store and the callback while the write is parked.
    await harness.rerender({
      at: { lat: 59.33, lng: 18.06 },
      store: second.adapter,
      occurredAt: 9,
      onSave: (input) => {
        toSecond.push(input);
      },
      onCancel: () => undefined,
    });

    first.puts[0]?.settle("key-in-first-store");
    await flush();

    expect(second.calls, "the write was redirected to the replacement store").toEqual([]);
    expect(
      toSecond,
      "store A's key was delivered to a callback paired with store B, where it resolves nowhere",
    ).toEqual([]);
    expect(toFirst).toHaveLength(1);
    expect(toFirst[0]?.media?.[0]?.blobKey).toBe("key-in-first-store");
  });

  it("cancels to the callbacks the in-flight attempt was started with", async () => {
    // Decision 4 of ADR-0027: a Save snapshots its *complete* handoff — store, onSave and
    // onCancel. onSave is carried by the async closure, but a Cancel click is dispatched
    // through whatever render is current, so without a per-attempt snapshot it reaches the
    // replacement recipient instead of the one the attempt began with.
    const first = parkedStore();
    const second = parkedStore();
    const toFirst: SaveInput[] = [];
    const toSecond: SaveInput[] = [];
    let cancelledFirst = 0;
    let cancelledSecond = 0;
    const at = { lat: 59.33, lng: 18.06 };
    const harness = await renderComponent(EventComposer, {
      at,
      store: first.adapter,
      occurredAt: 9,
      onSave: (input: SaveInput) => {
        toFirst.push(input);
      },
      onCancel: () => {
        cancelledFirst += 1;
      },
    });
    await selectPhoto(harness.container, photoFile());
    await clickSave(harness.container);
    expect(first.puts).toHaveLength(1);

    await harness.rerender({
      at,
      store: second.adapter,
      occurredAt: 9,
      onSave: (input: SaveInput) => {
        toSecond.push(input);
      },
      onCancel: () => {
        cancelledSecond += 1;
      },
    });
    await clickCancel(harness.container);

    expect(cancelledFirst, "the attempt's own onCancel must be the one called").toBe(1);
    expect(cancelledSecond, "cancel reached a callback the attempt never knew about").toBe(0);

    first.puts[0]?.settle("a-key");
    await flush();

    expect(
      first.deletes.map((d) => d.key),
      "the landed blob must be cleaned from its own store",
    ).toEqual(["a-key"]);
    expect(second.calls, "the replacement store was touched").toEqual([]);
    expect(toFirst).toEqual([]);
    expect(toSecond).toEqual([]);
  });

  it("releases the attempt snapshot on rejection, so a later cancel is current", async () => {
    // The other half of the snapshot rule. While an attempt is in flight, cancel belongs to
    // that attempt's recipients — but a rejected attempt is *over*, so a cancel afterwards
    // belongs to whoever is rendered now. A snapshot that is taken but never released would
    // keep telling the departed consumer about a composition it no longer owns.
    const store = parkedStore();
    let cancelledFirst = 0;
    let cancelledSecond = 0;
    const at = { lat: 59.33, lng: 18.06 };
    const harness = await renderComponent(EventComposer, {
      at,
      store: store.adapter,
      occurredAt: 9,
      onSave: () => undefined,
      onCancel: () => {
        cancelledFirst += 1;
      },
    });
    await selectPhoto(harness.container, photoFile());
    await clickSave(harness.container);
    store.puts[0]?.fail("write refused");
    await flush();

    await harness.rerender({
      at,
      store: store.adapter,
      occurredAt: 9,
      onSave: () => undefined,
      onCancel: () => {
        cancelledSecond += 1;
      },
    });
    await clickCancel(harness.container);

    expect(cancelledSecond, "cancel after a finished attempt must reach the current callback").toBe(
      1,
    );
    expect(cancelledFirst, "a released attempt still captured the cancel").toBe(0);
  });

  it("does not offer a retry the cancelled instance can never perform", async () => {
    // Cancel, then the parked write rejects. The uncertainty is unchanged — the bytes may or
    // may not have landed — but the instance is terminal, so advising another Save proposes
    // something that cannot happen.
    const c = await composed();
    await clickSave(c.container);
    await clickCancel(c.container);
    c.store.puts[0]?.fail("network died after the bytes left");
    await flush();

    const text =
      find<HTMLElement>(c.container, ".mapatlas-composer-notice").textContent?.toLowerCase() ?? "";
    expect(text, "the uncertainty must survive cancellation").toContain("may or may not");
    expect(text, "a terminal instance was offered a retry").not.toContain("again");

    // And the offer is not merely absent from the words: Save really is inert.
    await clickSave(c.container);
    expect(c.store.puts, "the cancelled instance accepted another attempt").toHaveLength(1);
    expect(c.saves).toEqual([]);
  });

  it("stops being busy once the cancelled attempt's cleanup settles", async () => {
    const form = (container: ParentNode): HTMLFormElement =>
      find<HTMLFormElement>(container, "form.mapatlas-composer");

    // Deletion succeeds.
    const done = await composed();
    await clickSave(done.container);
    await clickCancel(done.container);
    expect(form(done.container).getAttribute("aria-busy")).toBe("true");
    done.store.puts[0]?.settle("cleanup-me");
    await flush();
    done.store.deletes[0]?.settle();
    await flush();
    expect(
      form(done.container).getAttribute("aria-busy"),
      "cleanup finished but the composer stayed busy",
    ).toBe("false");
    expect(find<HTMLButtonElement>(done.container, ".mapatlas-composer-save").textContent).toBe(
      "Save",
    );

    // Deletion rejects: the same release, plus the unconfirmed notice.
    const failed = await composed();
    await clickSave(failed.container);
    await clickCancel(failed.container);
    failed.store.puts[0]?.settle("cleanup-me-too");
    await flush();
    failed.store.deletes[0]?.fail("delete refused");
    await flush();
    expect(
      form(failed.container).getAttribute("aria-busy"),
      "a failed cleanup left the composer busy",
    ).toBe("false");
    expect(find<HTMLElement>(failed.container, ".mapatlas-composer-notice").textContent).toContain(
      "could not be confirmed",
    );
  });

  it("reports a failed cleanup inline while mounted", async () => {
    const c = await composed();
    await clickSave(c.container);
    await clickCancel(c.container);
    c.store.puts[0]?.settle("stuck-key");
    await flush();
    c.store.deletes[0]?.fail("delete refused");
    await flush();

    // The semantic, not the call count: a rejected delete leaves the outcome *unknown*, so
    // the notice may not assert the blob is gone, and may not assert it remains either.
    const notice = find<HTMLElement>(c.container, ".mapatlas-composer-notice");
    const text = notice.textContent?.toLowerCase() ?? "";
    expect(text, "the notice must admit the deletion is unconfirmed").toContain(
      "could not be confirmed",
    );
    expect(text).toContain("may still be stored");
    expect(text, "a rejected delete must not be reported as a completed one").not.toContain(
      "was removed",
    );
  });

  it("warns rather than reports when cleanup fails after unmount", async () => {
    const c = await composed();
    await clickSave(c.container);
    await c.unmount();
    c.store.puts[0]?.settle("gone-key");
    await flush();

    const warnings: string[] = [];
    const spy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(args.map((arg) => String(arg)).join(" "));
    });
    try {
      c.store.deletes[0]?.fail("delete refused");
      await flush();
    } finally {
      spy.mockRestore();
    }

    // There is no reporting channel after unmount; the failure is acknowledged, not silent —
    // and it carries the same uncertainty as the mounted leg rather than a definite claim.
    const reported = warnings.filter((line) => line.includes("gone-key"));
    expect(reported).toHaveLength(1);
    expect(reported[0], "the warning must state the deletion is unconfirmed").toContain(
      "unconfirmed",
    );
    expect(reported[0]).not.toContain("deleted");
  });

  it("survives a write that rejects after unmount, with nothing to clean up", async () => {
    // The unmounted case of the rejection path. What is actually checkable: no handoff, no
    // cleanup — a rejection yields no key, so there is nothing to delete — and no error
    // output. Note what is *not* claimed: that the composer withholds its state updates. In
    // React 18 a post-unmount update is a silent no-op, so a guard against it would be an
    // assertion nobody could make fail, and there is none in the component.
    const c = await composed();
    await clickSave(c.container);
    await c.unmount();

    const warnings: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      warnings.push(args.map((arg) => String(arg)).join(" "));
    });
    try {
      c.store.puts[0]?.fail("rejected long after the composer was gone");
      await flush();
    } finally {
      spy.mockRestore();
    }

    expect(c.saves).toEqual([]);
    expect(c.store.deletes, "a rejection yields no key, so nothing can be cleaned up").toEqual([]);
    expect(warnings, "the unmounted rejection path reported through React").toEqual([]);
  });

  it("keeps the File in memory: replace and remove write nothing", async () => {
    const c = await composed();
    const replacement = photoFile("second.jpg");
    await selectPhoto(c.container, replacement);
    expect(c.store.calls, "replacing a photo touched the store").toEqual([]);

    await act(async () => {
      find<HTMLButtonElement>(c.container, ".mapatlas-composer-photo-remove").click();
    });
    expect(c.store.calls, "removing a photo touched the store").toEqual([]);
    expect(c.container.querySelector(".mapatlas-composer-preview")).toBeNull();

    // With no photo left, Save is the synchronous photo-free path again.
    await clickSave(c.container);
    expect(c.store.calls).toEqual([]);
    expect(c.saves).toStrictEqual([{ occurredAt: 9, media: [], tags: [] }]);
  });

  it("hands over normally when mounted in StrictMode", async () => {
    // StrictMode mounts, unmounts and remounts. A mounted-flag that is only ever cleared
    // survives that as "unmounted", and the landed write is then cleaned up instead of handed
    // over — silently, since the happy path in a non-strict mount looks identical. The
    // real-browser harness mounts in StrictMode, which is where this first showed up.
    const store = parkedStore();
    const saves: SaveInput[] = [];
    const harness = await renderComponent(
      EventComposer,
      {
        at: { lat: 59.33, lng: 18.06 },
        store: store.adapter,
        occurredAt: 9,
        onSave: (input: SaveInput) => {
          saves.push(input);
        },
        onCancel: () => undefined,
      },
      { strict: true },
    );
    await selectPhoto(harness.container, photoFile());
    await clickSave(harness.container);
    store.puts[0]?.settle("strict-key");
    await flush();

    expect(saves, "a StrictMode remount was mistaken for an unmount").toHaveLength(1);
    expect(saves[0]?.media?.[0]?.blobKey).toBe("strict-key");
    expect(store.deletes, "the blob was cleaned up despite a successful handoff").toEqual([]);
  });

  it("clears the selection when the picker comes back empty", async () => {
    // Dismissing the picker fires `change` with no files. That is a removal, not a no-op:
    // leaving the previous photo attached would save bytes the user just declined to keep.
    const c = await composed();
    expect(c.container.querySelector(".mapatlas-composer-preview")).not.toBeNull();

    const input = find<HTMLInputElement>(c.container, ".mapatlas-composer-photo");
    input.files = new DataTransfer().files;
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(c.container.querySelector(".mapatlas-composer-preview")).toBeNull();
    await clickSave(c.container);
    expect(c.store.calls, "an emptied picker still wrote a blob").toEqual([]);
    expect(c.saves).toStrictEqual([{ occurredAt: 9, media: [], tags: [] }]);
  });

  it("focuses capture in photo mode and the comment otherwise", async () => {
    const capture = await composed({ mode: "photo" });
    expect(capture.container.ownerDocument.activeElement).toBe(
      find<HTMLInputElement>(capture.container, ".mapatlas-composer-photo"),
    );

    const comment = await composed({ mode: "comment" });
    expect(comment.container.ownerDocument.activeElement).toBe(
      find<HTMLTextAreaElement>(comment.container, ".mapatlas-composer-comment"),
    );
  });

  it("requests a facing mode in both modes — mode chooses focus, not capture", async () => {
    // `mode` selects the initially active affordance and nothing else. Gating `capture` on it
    // would strip the camera preference from a comment-first composition whose user then
    // decides to add a photo, which is an ordinary way for that mode to be used.
    for (const mode of ["photo", "comment"] as const) {
      const c = await composed({ mode });
      expect(
        find<HTMLInputElement>(c.container, ".mapatlas-composer-photo").getAttribute("capture"),
        `capture must be requested in ${mode} mode`,
      ).toBe("environment");
    }
  });
});
