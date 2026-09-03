// @vitest-environment happy-dom
// SPDX-License-Identifier: Apache-2.0

/**
 * **Convention: never click a node without asserting it is still connected.**
 *
 * React 18 attaches listeners at the root container and delegates, so a *detached* node's
 * `click()` reaches no handler at all — it is a silent no-op, not an error. A test that
 * retains a button, does something that unmounts it, and then clicks it therefore passes
 * whatever the component does. Two tests in this file were written that way and were removed
 * or rewritten once measured; `clickLive` exists so the next one fails loudly instead.
 *
 * The corollary, also learned the hard way: to exercise a handler on a node that is *about*
 * to unmount, both activations must happen inside one `act` — and even then the flush is not
 * uniform. A click (Decline) leaves the sibling button connected for the rest of the task; a
 * `change` dispatch on the file input does not. Assert connectivity rather than predicting it.
 */

import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { noopAnalyzer } from "@mapatlas/core";
import type {
  AnalyzeInput,
  MapEvent,
  MediaAnalysis,
  MediaAnalyzer,
  StorageAdapter,
} from "@mapatlas/core";

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

/** Activate a node, refusing to do so if it has already left the document (see the header). */
function clickLive(node: HTMLElement, what: string): void {
  if (!node.isConnected) {
    throw new Error(`${what} is detached: clicking it would reach no handler and prove nothing`);
  }
  node.click();
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
    clickLive(button, "the Save button");
  });
}

async function clickCancel(container: ParentNode): Promise<void> {
  const button = find<HTMLButtonElement>(container, ".mapatlas-composer-cancel");
  await act(async () => {
    clickLive(button, "the Cancel button");
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

describe("EventComposer — the analyzer (T5.3 increment 3, ADR-0005)", () => {
  /** An analyzer whose `analyze` parks until the test answers it, and records its inputs. */
  function parkedAnalyzer(over: { id?: string; runsRemotely?: boolean } = {}): {
    analyzer: MediaAnalyzer;
    calls: AnalyzeInput[];
    settle: (result: MediaAnalysis, at?: number) => void;
    fail: (why: string, at?: number) => void;
  } {
    const calls: AnalyzeInput[] = [];
    const pending: { resolve: (r: MediaAnalysis) => void; reject: (e: Error) => void }[] = [];
    return {
      analyzer: {
        id: over.id ?? "test-analyzer",
        runsRemotely: over.runsRemotely ?? false,
        analyze: (input) => {
          calls.push(input);
          return new Promise<MediaAnalysis>((resolve, reject) => {
            pending.push({ resolve, reject });
          });
        },
      },
      calls,
      settle: (result, at = 0) => {
        pending[at]?.resolve(result);
      },
      fail: (why, at = 0) => {
        pending[at]?.reject(new Error(why));
      },
    };
  }

  const LABELLED: MediaAnalysis = {
    labels: [{ label: "a heron", confidence: 0.91 }],
    model: "test-model",
  };

  /** Mount with a photo selected and an analyzer attached. */
  async function withAnalyzer(
    analyzer: MediaAnalyzer,
    overrides: Partial<ComposerProps> = {},
  ): Promise<Mounted & { store: ReturnType<typeof parkedStore> }> {
    const store = parkedStore();
    const saves: SaveInput[] = [];
    let cancelled = 0;
    const harness = await renderComponent(EventComposer, {
      at: { lat: 59.33, lng: 18.06 },
      store: store.adapter,
      occurredAt: 9,
      analyzer,
      onSave: (input: SaveInput) => {
        saves.push(input);
      },
      onCancel: () => {
        cancelled += 1;
      },
      ...overrides,
    } as ComposerProps);
    await selectPhoto(harness.container, photoFile());
    return {
      container: harness.container,
      rerender: harness.rerender,
      unmount: harness.unmount,
      saves,
      cancels: () => cancelled,
      store,
    } as never;
  }

  async function clickAnalyze(container: ParentNode): Promise<void> {
    await act(async () => {
      find<HTMLButtonElement>(container, ".mapatlas-composer-analyze").click();
    });
  }

  it("runs only on an explicit action, on the in-memory file", async () => {
    const local = parkedAnalyzer();
    const c = await withAnalyzer(local.analyzer);
    expect(local.calls, "selecting a photo must not analyse it").toEqual([]);

    await clickAnalyze(c.container);
    expect(local.calls).toHaveLength(1);
    // The in-memory File, not a persisted copy — nothing has been written at this point.
    expect(local.calls[0]?.blob).toBeInstanceOf(File);
    expect(c.store.calls, "analysis must not touch storage").toEqual([]);
  });

  it("gates a remote analyzer behind a disclosure that sends nothing when opened", async () => {
    const remote = parkedAnalyzer({ id: "cloud-vision", runsRemotely: true });
    const c = await withAnalyzer(remote.analyzer);

    await clickAnalyze(c.container);
    expect(remote.calls, "activating a remote analyzer sent the photo without consent").toEqual([]);
    const panel = find<HTMLElement>(c.container, ".mapatlas-composer-disclosure");
    expect(panel.textContent, "the disclosure must name where the photo goes").toContain(
      "cloud-vision",
    );
    expect(panel.textContent).toContain("off this device");

    // Declining still sends nothing.
    await act(async () => {
      find<HTMLButtonElement>(c.container, ".mapatlas-composer-disclosure-decline").click();
    });
    expect(remote.calls).toEqual([]);
    expect(c.container.querySelector(".mapatlas-composer-disclosure")).toBeNull();

    // Only the explicit accept causes egress.
    await clickAnalyze(c.container);
    await act(async () => {
      find<HTMLButtonElement>(c.container, ".mapatlas-composer-disclosure-accept").click();
    });
    expect(remote.calls).toHaveLength(1);
  });

  it("needs no disclosure for a local analyzer", async () => {
    const local = parkedAnalyzer({ runsRemotely: false });
    const c = await withAnalyzer(local.analyzer);
    await clickAnalyze(c.container);
    expect(c.container.querySelector(".mapatlas-composer-disclosure")).toBeNull();
    expect(local.calls).toHaveLength(1);
  });

  it("shows an empty result as a result, through the path any analyzer uses", async () => {
    // noopAnalyzer is the shipped analyzer and returns no labels. "Analysed, found nothing"
    // must be distinguishable from "never analysed", and must not be special-cased by id.
    const c = await withAnalyzer(noopAnalyzer);
    expect(
      c.container.querySelector(".mapatlas-composer-suggestions"),
      "nothing has been analysed yet",
    ).toBeNull();

    await clickAnalyze(c.container);
    await flush();

    const empty = find<HTMLElement>(c.container, ".mapatlas-composer-suggestions-empty");
    expect(empty.textContent).toContain("found nothing");
    // And it is confirmable like any other result: an empty analysis is a fact worth keeping.
    await act(async () => {
      find<HTMLButtonElement>(c.container, ".mapatlas-composer-confirm").click();
    });
    await clickSave(c.container);
    c.store.puts[0]?.settle("k");
    await flush();
    expect(c.saves[0]?.media?.[0]?.analysis).toStrictEqual({ labels: [], model: "noop" });
  });

  it("puts a confirmed analysis in MediaRef.analysis and nowhere else", async () => {
    const local = parkedAnalyzer();
    const c = await withAnalyzer(local.analyzer);
    await clickAnalyze(c.container);
    local.settle(LABELLED);
    await flush();

    expect(
      find<HTMLElement>(c.container, ".mapatlas-composer-suggestion-list").textContent,
    ).toContain("a heron");
    await act(async () => {
      find<HTMLButtonElement>(c.container, ".mapatlas-composer-confirm").click();
    });
    await clickSave(c.container);
    c.store.puts[0]?.settle("blob-key");
    await flush();

    const saved = c.saves[0];
    expect(saved?.media?.[0]?.analysis).toStrictEqual(LABELLED);
    // The bar: a label is a suggestion, not a decision. It may not become a tag, a category
    // or a field — those are the consumer's to fill.
    expect(saved?.tags, "a confirmed label became a tag").toEqual([]);
    expect(saved?.category).toBeUndefined();
    expect(saved?.fields).toBeUndefined();
  });

  it("drops an unconfirmed suggestion at Save", async () => {
    const local = parkedAnalyzer();
    const c = await withAnalyzer(local.analyzer);
    await clickAnalyze(c.container);
    local.settle(LABELLED);
    await flush();
    // Deliberately not confirmed.
    await clickSave(c.container);
    c.store.puts[0]?.settle("blob-key");
    await flush();

    expect(
      c.saves[0]?.media?.[0]?.analysis,
      "an unconfirmed suggestion was stored",
    ).toBeUndefined();
  });

  it("reports a failed analysis without blocking the Save", async () => {
    const local = parkedAnalyzer();
    const c = await withAnalyzer(local.analyzer);
    await clickAnalyze(c.container);
    local.fail("model unavailable");
    await flush();

    expect(
      find<HTMLElement>(c.container, ".mapatlas-composer-analysis-notice").textContent,
    ).toContain("could not be analysed");
    await clickSave(c.container);
    c.store.puts[0]?.settle("blob-key");
    await flush();
    expect(c.saves).toHaveLength(1);
    expect(c.saves[0]?.media?.[0]?.analysis).toBeUndefined();
  });

  it("lets the newest request win when an older one answers later", async () => {
    const local = parkedAnalyzer();
    const c = await withAnalyzer(local.analyzer);
    await clickAnalyze(c.container);
    await clickAnalyze(c.container);
    expect(local.calls).toHaveLength(2);

    // The newer answers first, then the older — the order that breaks a naive "last write".
    local.settle({ labels: [{ label: "newer", confidence: 0.5 }] }, 1);
    await flush();
    local.settle({ labels: [{ label: "older", confidence: 0.9 }] }, 0);
    await flush();

    const shown = find<HTMLElement>(c.container, ".mapatlas-composer-suggestion-list").textContent;
    expect(shown, "an older result overwrote a newer one").toContain("newer");
    expect(shown).not.toContain("older");
  });
});

describe("EventComposer — analyzer invalidation, leg by leg (ADR-0005)", () => {
  /**
   * Each leg is its own test on purpose. The legs share one token, so a single test would
   * pass while most of the events that must move that token did not — the shared mechanism
   * is exactly what makes per-leg coverage necessary rather than redundant.
   */
  function parked(): {
    analyzer: MediaAnalyzer;
    settle: (r: MediaAnalysis) => void;
    fail: (why: string) => void;
  } {
    const pending: { resolve: (r: MediaAnalysis) => void; reject: (e: Error) => void }[] = [];
    return {
      analyzer: {
        id: "test-analyzer",
        runsRemotely: false,
        analyze: () =>
          new Promise<MediaAnalysis>((resolve, reject) => {
            pending.push({ resolve, reject });
          }),
      },
      settle: (r) => pending[0]?.resolve(r),
      fail: (why) => pending[0]?.reject(new Error(why)),
    };
  }

  const RESULT: MediaAnalysis = { labels: [{ label: "late", confidence: 1 }] };

  async function analysing(
    analyzer: MediaAnalyzer,
  ): Promise<Mounted & { store: ReturnType<typeof parkedStore> }> {
    const store = parkedStore();
    const saves: SaveInput[] = [];
    let cancelled = 0;
    const harness = await renderComponent(EventComposer, {
      at: { lat: 59.33, lng: 18.06 },
      store: store.adapter,
      occurredAt: 9,
      analyzer,
      onSave: (input: SaveInput) => {
        saves.push(input);
      },
      onCancel: () => {
        cancelled += 1;
      },
    } as ComposerProps);
    await selectPhoto(harness.container, photoFile());
    await act(async () => {
      find<HTMLButtonElement>(harness.container, ".mapatlas-composer-analyze").click();
    });
    return {
      container: harness.container,
      rerender: harness.rerender,
      unmount: harness.unmount,
      saves,
      cancels: () => cancelled,
      store,
    } as never;
  }

  /** No suggestion list anywhere — the late answer was not adopted. */
  function assertDiscarded(container: ParentNode): void {
    expect(
      container.querySelector(".mapatlas-composer-suggestions"),
      "a superseded analysis was adopted",
    ).toBeNull();
  }

  it("discards a resolution arriving after the photo was replaced", async () => {
    const a = parked();
    const c = await analysing(a.analyzer);
    await selectPhoto(c.container, photoFile("other.jpg"));
    a.settle(RESULT);
    await flush();
    assertDiscarded(c.container);
  });

  it("discards a resolution arriving after the photo was removed", async () => {
    const a = parked();
    const c = await analysing(a.analyzer);
    await act(async () => {
      find<HTMLButtonElement>(c.container, ".mapatlas-composer-photo-remove").click();
    });
    a.settle(RESULT);
    await flush();

    // Asserting the absence of the list *here* would pass for the wrong reason: the whole
    // analysis block lives inside the photo block, so with no photo it is absent however the
    // resolution was handled. The harm would only surface on the next photo — suggestions
    // computed from the removed one, presented as describing the new one — so that is what is
    // asserted. Note honestly that choosing that next photo invalidates on its own, so this
    // pins the end-to-end contract rather than the removal bump specifically; the mutation
    // that removes only that bump survives, which the source comment records.
    await selectPhoto(c.container, photoFile("replacement.jpg"));
    assertDiscarded(c.container);
  });

  it("discards a *rejection* that arrives after the request was superseded", async () => {
    // The failure path needs the same token check as the success path. Without it, a request
    // nobody is waiting for reports an error about a photo that is no longer in the
    // composition — noise the user cannot act on and cannot connect to anything they did.
    const a = parked();
    const c = await analysing(a.analyzer);
    await selectPhoto(c.container, photoFile("replacement.jpg"));
    a.fail("model unavailable");
    await flush();

    expect(
      c.container.querySelector(".mapatlas-composer-analysis-notice"),
      "a superseded request reported its failure",
    ).toBeNull();
  });

  it("discards a resolution arriving after cancel", async () => {
    const a = parked();
    const c = await analysing(a.analyzer);
    await clickCancel(c.container);
    a.settle(RESULT);
    await flush();
    assertDiscarded(c.container);
  });

  it("discards a resolution arriving after Save, and never stores it", async () => {
    const a = parked();
    const c = await analysing(a.analyzer);
    await clickSave(c.container);
    a.settle(RESULT);
    await flush();
    c.store.puts[0]?.settle("blob-key");
    await flush();

    assertDiscarded(c.container);
    expect(
      c.saves[0]?.media?.[0]?.analysis,
      "an analysis that arrived after Save was stored anyway",
    ).toBeUndefined();
  });

  // Not independently falsifiable, and labelled rather than dressed up: React makes a state
  // update on an unmounted component a no-op, so this passes with or without composer-side
  // invalidation. It is kept as a smoke test that a late resolution cannot throw.
  it("survives a resolution arriving after unmount", async () => {
    const a = parked();
    const c = await analysing(a.analyzer);
    await c.unmount();
    const warnings: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      warnings.push(args.map((arg) => String(arg)).join(" "));
    });
    try {
      a.settle(RESULT);
      await flush();
    } finally {
      spy.mockRestore();
    }
    expect(warnings).toEqual([]);
  });

  it("discards a resolution arriving after the analyzer prop was replaced", async () => {
    const first = parked();
    const second = parked();
    const c = await analysing(first.analyzer);
    await c.rerender({
      at: { lat: 59.33, lng: 18.06 },
      store: c.store.adapter,
      occurredAt: 9,
      analyzer: second.analyzer,
      onSave: () => undefined,
      onCancel: () => undefined,
    } as ComposerProps);

    first.settle(RESULT);
    await flush();
    assertDiscarded(c.container);
  });

  it("withdraws a disclosure accepted for a different analyzer", async () => {
    // Consent to send a photo to one service is not consent to send it to the next.
    const first = { id: "first-cloud", runsRemotely: true, analyze: () => Promise.resolve(RESULT) };
    const secondCalls: AnalyzeInput[] = [];
    const second: MediaAnalyzer = {
      id: "second-cloud",
      runsRemotely: true,
      analyze: (input) => {
        secondCalls.push(input);
        return Promise.resolve(RESULT);
      },
    };
    const store = parkedStore();
    const harness = await renderComponent(EventComposer, {
      at: { lat: 59.33, lng: 18.06 },
      store: store.adapter,
      occurredAt: 9,
      analyzer: first,
      onSave: () => undefined,
      onCancel: () => undefined,
    } as ComposerProps);
    await selectPhoto(harness.container, photoFile());
    await act(async () => {
      find<HTMLButtonElement>(harness.container, ".mapatlas-composer-analyze").click();
    });
    await act(async () => {
      find<HTMLButtonElement>(harness.container, ".mapatlas-composer-disclosure-accept").click();
    });

    await harness.rerender({
      at: { lat: 59.33, lng: 18.06 },
      store: store.adapter,
      occurredAt: 9,
      analyzer: second,
      onSave: () => undefined,
      onCancel: () => undefined,
    } as ComposerProps);

    await act(async () => {
      find<HTMLButtonElement>(harness.container, ".mapatlas-composer-analyze").click();
    });
    expect(secondCalls, "acceptance carried over to a different analyzer").toEqual([]);
    expect(
      find<HTMLElement>(harness.container, ".mapatlas-composer-disclosure").textContent,
    ).toContain("second-cloud");
  });
});

describe("EventComposer — analyzer authorization and admission (ADR-0005, ADR-0027)", () => {
  /**
   * A remote analyzer that counts every call. These bars are about *egress*, so the oracle is
   * the number of times `analyze` actually ran — not what the UI shows about it. Result
   * invalidation cannot help here: by the time an answer exists the photo has already been
   * sent, so authorization has to be withdrawn before the call, not after it.
   */
  function counting(id = "cloud-vision"): { analyzer: MediaAnalyzer; calls: AnalyzeInput[] } {
    const calls: AnalyzeInput[] = [];
    return {
      analyzer: {
        id,
        runsRemotely: true,
        analyze: (input) => {
          calls.push(input);
          return Promise.resolve({ labels: [], model: id });
        },
      },
      calls,
    };
  }

  async function mounted(
    analyzer: MediaAnalyzer,
  ): Promise<Mounted & { store: ReturnType<typeof parkedStore> }> {
    const store = parkedStore();
    const saves: SaveInput[] = [];
    let cancelled = 0;
    const harness = await renderComponent(EventComposer, {
      at: { lat: 59.33, lng: 18.06 },
      store: store.adapter,
      occurredAt: 9,
      analyzer,
      onSave: (input: SaveInput) => {
        saves.push(input);
      },
      onCancel: () => {
        cancelled += 1;
      },
    } as ComposerProps);
    await selectPhoto(harness.container, photoFile());
    return {
      container: harness.container,
      rerender: harness.rerender,
      unmount: harness.unmount,
      saves,
      cancels: () => cancelled,
      store,
    } as never;
  }

  const analyse = async (container: ParentNode): Promise<void> => {
    await act(async () => {
      clickLive(find<HTMLButtonElement>(container, ".mapatlas-composer-analyze"), "Analyse");
    });
  };
  const accept = async (container: ParentNode): Promise<void> => {
    await act(async () => {
      clickLive(
        find<HTMLButtonElement>(container, ".mapatlas-composer-disclosure-accept"),
        "Accept",
      );
    });
  };
  const disclosure = (container: ParentNode): Element | null =>
    container.querySelector(".mapatlas-composer-disclosure");

  it("closes a disclosure opened for a photo that has been replaced", async () => {
    const remote = counting();
    const c = await mounted(remote.analyzer);
    await analyse(c.container);
    expect(disclosure(c.container)).not.toBeNull();

    await selectPhoto(c.container, photoFile("second.jpg"));

    // The panel was opened to authorise sending the *first* photo. Leaving it actionable
    // would let the next click send a photo no disclosure was ever shown for.
    expect(disclosure(c.container), "a stale disclosure stayed actionable").toBeNull();
    expect(remote.calls).toEqual([]);
  });

  it("consumes consent with the send it authorises", async () => {
    // Acceptance authorises *one* request. If it outlived that request, the second and later
    // activations would send the photo with no disclosure at all — a gate on the first
    // action rather than on the action.
    const remote = counting();
    const c = await mounted(remote.analyzer);
    await analyse(c.container);
    await accept(c.container);
    expect(remote.calls, "the accepted send should have happened").toHaveLength(1);

    await analyse(c.container);
    expect(remote.calls, "a second send reused the first send's consent").toHaveLength(1);
    expect(disclosure(c.container), "the second request was not disclosed").not.toBeNull();
  });

  it("closes a disclosure when the photo it was opened for is removed", async () => {
    // The removal leg, actually removing — the replacement leg is a separate test, and a
    // title covering both while exercising one overstates what is falsified.
    const remote = counting();
    const c = await mounted(remote.analyzer);
    await analyse(c.container);
    expect(disclosure(c.container)).not.toBeNull();

    await act(async () => {
      find<HTMLButtonElement>(c.container, ".mapatlas-composer-photo-remove").click();
    });
    expect(disclosure(c.container), "a disclosure outlived the photo it named").toBeNull();
    expect(remote.calls).toEqual([]);
  });

  it("spends one disclosure on exactly one send, however often Accept is activated", async () => {
    // `setDisclosing(false)` is queued, so between the click and the commit the Accept button
    // is still mounted and still calls its handler. Admission cannot refuse the second
    // activation either — the composition is legitimately open in between.
    const remote = counting();
    const c = await mounted(remote.analyzer);
    await analyse(c.container);
    const button = find<HTMLButtonElement>(c.container, ".mapatlas-composer-disclosure-accept");

    await act(async () => {
      clickLive(button, "Accept (first activation)");
      clickLive(button, "Accept (second activation)");
    });

    expect(remote.calls, "one disclosure authorised two sends").toHaveLength(1);
  });

  it("voids an outstanding disclosure the moment the photo is removed", async () => {
    // The reachable, spendable case for the clear inside `endAnalysis`. Removing the photo
    // leaves the composition open — so admission still permits an accept — and the Accept
    // button stays connected for the rest of the task in which Remove was activated. Only
    // the synchronous void refuses it. `clickLive` is what keeps this honest: if a future
    // React changes the flush and the button detaches, this fails loudly rather than passing
    // for the reason the deleted photo-change test passed.
    const remote = counting();
    const c = await mounted(remote.analyzer);
    await analyse(c.container);
    const accepted = find<HTMLButtonElement>(c.container, ".mapatlas-composer-disclosure-accept");
    const remove = find<HTMLButtonElement>(c.container, ".mapatlas-composer-photo-remove");

    await act(async () => {
      clickLive(remove, "Remove photo");
      clickLive(accepted, "Accept after removing the photo");
    });

    expect(remote.calls, "a disclosure outlived the photo it authorised sending").toEqual([]);
  });

  it("voids an outstanding disclosure the moment it is declined", async () => {
    // Same shape, same reason: the decline's re-render has not committed, so the Accept button
    // is still mounted and still live. Only the synchronous void refuses it.
    const remote = counting();
    const c = await mounted(remote.analyzer);
    await analyse(c.container);
    const accepted = find<HTMLButtonElement>(c.container, ".mapatlas-composer-disclosure-accept");
    const declined = find<HTMLButtonElement>(c.container, ".mapatlas-composer-disclosure-decline");

    await act(async () => {
      clickLive(declined, "Decline");
      clickLive(accepted, "Accept after declining");
    });

    expect(remote.calls, "a declined disclosure was still spendable").toEqual([]);
  });

  it("refuses an Accept activated reentrantly from onCancel", async () => {
    // Closing the panel is a state update, and React has not committed it when `onCancel`
    // runs. A consumer that retains the button and activates it from its own cancel callback
    // therefore reaches the handler on a settled composer — the DOM being about to disappear
    // is not the same as the handler being unreachable.
    const remote = counting();
    const store = parkedStore();
    // A holder, because the cancel callback has to close over the reference before the
    // button exists — the composer must be rendered before it can be retained.
    const retained: { button?: HTMLButtonElement } = {};
    const harness = await renderComponent(EventComposer, {
      at: { lat: 59.33, lng: 18.06 },
      store: store.adapter,
      occurredAt: 9,
      analyzer: remote.analyzer,
      onSave: () => undefined,
      onCancel: () => {
        retained.button?.click();
      },
    } as ComposerProps);
    await selectPhoto(harness.container, photoFile());
    await analyse(harness.container);
    retained.button = find<HTMLButtonElement>(
      harness.container,
      ".mapatlas-composer-disclosure-accept",
    );

    await clickCancel(harness.container);
    expect(remote.calls, "a cancelled composer sent the photo from its own callback").toEqual([]);
  });

  it("keeps analyzer feedback out of the persistence notice, and the reverse", async () => {
    const failing: MediaAnalyzer = {
      id: "broken",
      runsRemotely: false,
      analyze: () => Promise.reject(new Error("model unavailable")),
    };
    const c = await mounted(failing);

    // An analysis failure belongs to this photo and this request.
    await analyse(c.container);
    await flush();
    expect(
      find<HTMLElement>(c.container, ".mapatlas-composer-analysis-notice").textContent,
    ).toContain("could not be analysed");

    // A new photo does not inherit the previous photo's error.
    await selectPhoto(c.container, photoFile("second.jpg"));
    expect(
      c.container.querySelector(".mapatlas-composer-analysis-notice"),
      "a new photo inherited the old photo's analysis error",
    ).toBeNull();

    // And an analysis must not erase an unconfirmed *write*, whose outcome is still unknown.
    await clickSave(c.container);
    c.store.puts[0]?.fail("network died after the bytes left");
    await flush();
    const storage = find<HTMLElement>(c.container, ".mapatlas-composer-notice");
    expect(storage.textContent).toContain("may or may not");
    await analyse(c.container);
    expect(
      find<HTMLElement>(c.container, ".mapatlas-composer-notice").textContent,
      "starting an analysis erased an unresolved storage warning",
    ).toContain("may or may not");

    // Nor does swapping the photo. The write's outcome is unknown whatever the user does
    // next; only resolving that write can retire the warning.
    await selectPhoto(c.container, photoFile("third.jpg"));
    expect(
      find<HTMLElement>(c.container, ".mapatlas-composer-notice").textContent,
      "changing the photo erased an unresolved storage warning",
    ).toContain("may or may not");
  });

  /** A *local* analyzer: no disclosure stands between a click and the call, so admission is
   *  the only thing that can refuse it. With a remote analyzer the withdrawn consent hides a
   *  missing lifecycle gate — the gate must be tested where nothing else can pass for it. */
  function countingLocal(): { analyzer: MediaAnalyzer; calls: AnalyzeInput[] } {
    const calls: AnalyzeInput[] = [];
    return {
      analyzer: {
        id: "on-device",
        runsRemotely: false,
        analyze: (input) => {
          calls.push(input);
          return Promise.resolve({ labels: [], model: "on-device" });
        },
      },
      calls,
    };
  }

  it("admits no local analyzer work after cancel", async () => {
    const local = countingLocal();
    const c = await mounted(local.analyzer);
    await analyse(c.container);
    expect(local.calls).toHaveLength(1);

    await clickCancel(c.container);
    await analyse(c.container);
    expect(local.calls, "a cancelled composer ran the analyzer").toHaveLength(1);
  });

  it("admits no local analyzer work after handoff, or while a Save is pending", async () => {
    const local = countingLocal();
    const c = await mounted(local.analyzer);
    await clickSave(c.container);

    await analyse(c.container);
    expect(local.calls, "the analyzer ran while a Save was in flight").toEqual([]);

    c.store.puts[0]?.settle("blob-key");
    await flush();
    await analyse(c.container);
    expect(local.calls, "the analyzer ran after handoff").toEqual([]);
  });

  it("admits no analyzer work after cancel", async () => {
    const remote = counting();
    const c = await mounted(remote.analyzer);
    await analyse(c.container);
    await accept(c.container);
    expect(remote.calls).toHaveLength(1);

    await clickCancel(c.container);
    await analyse(c.container);
    await act(async () => {
      const button = c.container.querySelector<HTMLButtonElement>(
        ".mapatlas-composer-disclosure-accept",
      );
      button?.click();
    });
    expect(remote.calls, "a cancelled composer started analyzer work").toHaveLength(1);
  });

  it("admits no analyzer work after handoff, or while a Save is pending", async () => {
    const remote = counting();
    const c = await mounted(remote.analyzer);
    await clickSave(c.container);

    // The write is parked: the composer is on its way to a handoff and takes no new work.
    await analyse(c.container);
    expect(remote.calls, "analysis started while a Save was in flight").toEqual([]);

    c.store.puts[0]?.settle("blob-key");
    await flush();
    expect(c.saves).toHaveLength(1);

    await analyse(c.container);
    expect(remote.calls, "analysis started after handoff").toEqual([]);
  });

  it("settles the visible analysis state when the composition ends", async () => {
    const label = (container: ParentNode): string | null =>
      find<HTMLButtonElement>(container, ".mapatlas-composer-analyze").textContent;
    const parkedAnalyzer: MediaAnalyzer = {
      id: "slow",
      runsRemotely: false,
      analyze: () => new Promise<MediaAnalysis>(() => undefined),
    };

    const cancelled = await mounted(parkedAnalyzer);
    await analyse(cancelled.container);
    expect(label(cancelled.container)).toBe("Analysing…");
    await clickCancel(cancelled.container);
    // The token bump discards the answer, but the *user* is looking at a spinner that will
    // never resolve on a composer that is finished.
    expect(label(cancelled.container), "a cancelled composer stayed at Analysing…").toBe(
      "Analyse photo",
    );

    const saved = await mounted(parkedAnalyzer);
    await analyse(saved.container);
    await clickSave(saved.container);
    saved.store.puts[0]?.settle("blob-key");
    await flush();
    expect(label(saved.container), "a saved composer stayed at Analysing…").toBe("Analyse photo");
  });

  it("closes an open disclosure when the composition ends", async () => {
    const remote = counting();
    const c = await mounted(remote.analyzer);
    await analyse(c.container);
    expect(disclosure(c.container)).not.toBeNull();
    await clickCancel(c.container);
    expect(disclosure(c.container), "a cancelled composer left the send panel open").toBeNull();
  });

  it("turns a synchronous analyzer throw into the ordinary failure", async () => {
    // `analyze` is called before any promise chain exists, so an implementation that fails
    // before returning its promise would otherwise escape the click handler entirely and
    // leave the button stuck at "Analysing…".
    const thrower: MediaAnalyzer = {
      id: "broken",
      runsRemotely: false,
      analyze: () => {
        throw new Error("failed before returning a promise");
      },
    };
    const c = await mounted(thrower);
    await analyse(c.container);
    await flush();

    expect(
      find<HTMLElement>(c.container, ".mapatlas-composer-analysis-notice").textContent,
    ).toContain("could not be analysed");
    expect(find<HTMLButtonElement>(c.container, ".mapatlas-composer-analyze").textContent).toBe(
      "Analyse photo",
    );
  });
});
