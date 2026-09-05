// @vitest-environment happy-dom
// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PersistenceApi } from "./persistence.js";
import { mountPersistenceControl, readPersistenceApi } from "./persistence.js";

/**
 * The control's branches, driven through the seam.
 *
 * **What is deliberately not asserted anywhere here: that a browser grants persistence.** That
 * is a heuristic decision by three different engines, one of which asks a human. A test calling
 * `persist()` and expecting `true` would be asserting Chromium's engagement heuristics about a
 * test page — passing or failing for reasons unrelated to this code, and reading, when it
 * passed, as evidence that persistence works. It is T6.2's version of "zero network requests is
 * not evidence".
 *
 * What *is* asserted: when the call happens, how many times, and that each answer the browser
 * can give is reported as the thing it is.
 */

/** Records calls, and lets a test decide when each settles. */
function api(over: Partial<PersistenceApi> = {}): PersistenceApi & {
  persistedCalls: number;
  persistCalls: number;
} {
  const recorder = {
    persistedCalls: 0,
    persistCalls: 0,
    persisted: (): Promise<boolean> => {
      recorder.persistedCalls += 1;
      return (over.persisted ?? (() => Promise.resolve(false)))();
    },
    persist: (): Promise<boolean> => {
      recorder.persistCalls += 1;
      return (over.persist ?? (() => Promise.resolve(true)))();
    },
  };
  return recorder;
}

const host = (): HTMLElement => {
  const element = document.createElement("main");
  document.body.append(element);
  return element;
};

const button = (root: HTMLElement): HTMLButtonElement => {
  const found = root.querySelector<HTMLButtonElement>("#persistence-request");
  if (found === null) throw new Error("the control rendered no request button");
  return found;
};

const stateOf = (root: HTMLElement): string | undefined =>
  root.querySelector<HTMLElement>("#persistence")?.dataset["state"];

const textOf = (root: HTMLElement): string => root.textContent ?? "";

/** Lets the promise chain the control started run to completion. */
const settle = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("the control asks nothing until it is asked", () => {
  it("checks persisted() on mount and requests nothing", async () => {
    // The documented guidance, made into an assertion: do not request on load. Firefox prompts,
    // so a bootstrap request interrupts a user who has done nothing.
    const storage = api();
    const root = host();
    mountPersistenceControl(root, storage);
    await settle();

    expect(storage.persistedCalls, "the status was never read").toBe(1);
    expect(storage.persistCalls, "a request was made before any gesture").toBe(0);
    expect(stateOf(root)).toBe("unpersisted");
  });

  it("cannot request anything while the status check is still in flight", async () => {
    // The race this control has to not have. Rendering the actionable state synchronously would
    // put a live button on the page while `persisted()` was still pending — a fast activation
    // would then request persistence for an origin that may already have it, and the late status
    // answer would overwrite the request's own result. The check is held open by hand, because
    // a guard that only applied after the check resolved would be no guard at all.
    let answer: (persisted: boolean) => void = () => undefined;
    const storage = api({
      persisted: () =>
        new Promise<boolean>((resolve) => {
          answer = resolve;
        }),
    });
    const root = host();
    mountPersistenceControl(root, storage);
    await settle();

    expect(stateOf(root), "the control claimed an answer it does not have").toBe("checking");
    button(root).click();
    button(root).click();
    await settle();
    expect(storage.persistCalls, "a request was made before the status was known").toBe(0);

    answer(false);
    await settle();
    expect(stateOf(root)).toBe("unpersisted");

    // And only now is it actionable — otherwise "zero calls" would hold for a control that
    // never worked at all.
    button(root).click();
    await settle();
    expect(storage.persistCalls).toBe(1);
  });

  it("requests exactly once when the button is activated", async () => {
    const storage = api();
    const root = host();
    mountPersistenceControl(root, storage);
    await settle();

    button(root).click();
    await settle();

    // Exactly one, not "at least one": a control that fires twice on one gesture prompts a
    // Firefox user twice.
    expect(storage.persistCalls).toBe(1);
    expect(stateOf(root)).toBe("granted");
  });

  it("starts nothing on a second activation while the first is in flight", async () => {
    // The in-flight guard. Held open by a promise this test resolves by hand, because the race
    // is the point — a guard only applied after the first request settled would be no guard.
    let release: (granted: boolean) => void = () => undefined;
    const storage = api({
      persist: () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    });
    const root = host();
    mountPersistenceControl(root, storage);
    await settle();

    button(root).click();
    button(root).click();
    button(root).click();
    await settle();

    expect(storage.persistCalls, "the guard let a second request through").toBe(1);

    release(true);
    await settle();
    expect(stateOf(root)).toBe("granted");
  });

  it("re-arms after a denial, so the request can be made again later", async () => {
    // `disabled` is the in-flight guard, not a terminal state: a denial is not permanent, and a
    // control that locked itself after one would misreport a browser that changes its mind as
    // the user's engagement grows.
    const storage = api({ persist: () => Promise.resolve(false) });
    const root = host();
    mountPersistenceControl(root, storage);
    await settle();

    button(root).click();
    await settle();
    expect(stateOf(root)).toBe("denied");
    expect(button(root).disabled, "the button stayed disabled after a denial").toBe(false);

    button(root).click();
    await settle();
    expect(storage.persistCalls).toBe(2);
  });
});

describe("every answer a browser can give is reported as the thing it is", () => {
  it("reports an origin that is already persistent, and offers no request", async () => {
    const storage = api({ persisted: () => Promise.resolve(true) });
    const root = host();
    mountPersistenceControl(root, storage);
    await settle();

    expect(stateOf(root)).toBe("already-persistent");
    expect(storage.persistCalls, "asked for what it already had").toBe(0);
    expect(button(root).hidden, "offered to fix a non-problem").toBe(true);
  });

  it("reports a grant", async () => {
    const root = host();
    mountPersistenceControl(root, api({ persist: () => Promise.resolve(true) }));
    await settle();
    button(root).click();
    await settle();

    expect(stateOf(root)).toBe("granted");
  });

  it("reports a denial as a normal answer, not a failure", async () => {
    // Denial is the *common* outcome in Chromium for a site with no engagement history, so it
    // has to read as an answer. The wording carries that, which is why it is asserted.
    const root = host();
    mountPersistenceControl(root, api({ persist: () => Promise.resolve(false) }));
    await settle();
    button(root).click();
    await settle();

    expect(stateOf(root)).toBe("denied");
    expect(textOf(root)).toMatch(/normal answer/i);
  });

  it("reports an unsupported browser without offering a request", async () => {
    // **`null`, not `undefined`.** A default parameter is applied when a caller passes
    // `undefined` explicitly, so the earlier version of this test injected nothing: it fell
    // through to the ambient `navigator` and passed only because happy-dom happens to lack the
    // API. To prove the branch is driven by the caller rather than by the environment, a
    // *working* API is put on `navigator` first — under the old test that would have flipped
    // the result, and here it must change nothing.
    vi.stubGlobal("navigator", {
      storage: { persisted: () => Promise.resolve(true), persist: () => Promise.resolve(true) },
    });

    const root = host();
    mountPersistenceControl(root, null);
    await settle();

    expect(stateOf(root), "the ambient navigator decided this, not the caller").toBe("unsupported");
    expect(button(root).hidden).toBe(true);
  });

  it("reports a rejected request as an error, not as a denial", async () => {
    // These are different facts. "Denied" says the browser refused; "error" says it never
    // answered. Collapsing them tells a user their browser said no when it said nothing.
    const root = host();
    mountPersistenceControl(root, api({ persist: () => Promise.reject(new Error("nope")) }));
    await settle();
    button(root).click();
    await settle();

    expect(stateOf(root)).toBe("error");
  });

  it("reports a rejected status check as an error, without calling it a failed request", async () => {
    // Reached before anything is requested, so copy naming "the request" would describe a
    // request that never happened. The wording has to hold for both paths into this state.
    const root = host();
    mountPersistenceControl(root, api({ persisted: () => Promise.reject(new Error("nope")) }));
    await settle();

    expect(stateOf(root)).toBe("error");
    expect(textOf(root), "a check failure is described as a failed request").not.toMatch(
      /the request failed|persistence request/i,
    );
    expect(textOf(root)).toMatch(/did not answer/i);
  });

  it("renders each state distinguishably, checking included", async () => {
    // Pairwise, because "every state renders *something*" is satisfied by a control that
    // renders one thing. Two states sharing text is the defect this catches.
    //
    // **`checking` is in here, and it is the one most easily left out.** The race test above
    // pins its dataset value but not what a person sees, so giving `checking` the settled
    // `unpersisted` copy would leave every other test green while the control displayed an
    // answer before `persisted()` had produced one. It is captured mid-flight, from a status
    // check this test never resolves.
    const rendered = new Map<string, string>();

    const pending = host();
    mountPersistenceControl(
      pending,
      api({ persisted: () => new Promise<boolean>(() => undefined) }),
    );
    await settle();
    rendered.set("checking", textOf(pending));
    // And it must not read as a settled answer. The rule is not "different text" — the pairwise
    // check below already covers that, and it passes when only *half* the copy is borrowed. The
    // rule is that while the check is in flight the control states **no position** on what the
    // browser's storage is. Each phrase below is a settled state's own claim: `unpersisted`'s
    // headline, `unpersisted`'s detail, and the claim `already-persistent` and `granted` share.
    // Borrowing any of them announces the browser's answer before the browser has given it.
    for (const claim of [/best-effort/i, /may evict/i, /excluded from automatic eviction/i]) {
      expect(
        rendered.get("checking") ?? "",
        `checking states a position it does not have: ${String(claim)}`,
      ).not.toMatch(claim);
    }

    const cases: [string, PersistenceApi | null][] = [
      ["already-persistent", api({ persisted: () => Promise.resolve(true) })],
      ["unpersisted", api()],
      ["unsupported", null],
    ];
    for (const [name, storage] of cases) {
      const root = host();
      mountPersistenceControl(root, storage);
      await settle();
      rendered.set(name, textOf(root));
    }
    for (const [after, storage] of [
      ["granted", api({ persist: () => Promise.resolve(true) })],
      ["denied", api({ persist: () => Promise.resolve(false) })],
      ["error", api({ persist: () => Promise.reject(new Error("nope")) })],
    ] as const) {
      const root = host();
      mountPersistenceControl(root, storage);
      await settle();
      button(root).click();
      await settle();
      rendered.set(after, textOf(root));
    }

    expect(new Set(rendered.values()).size, "two states render the same text").toBe(rendered.size);
  });
});

describe("the asynchronous result is announced, not just displayed", () => {
  it("puts the status text in a live region, and leaves the button out of it", async () => {
    // Every meaningful change here arrives asynchronously — the check answers, then a request
    // answers — so without a live region a reader not watching this corner of the page is told
    // nothing. The button is outside it because a live region announces its whole contents on
    // change, and re-reading the control's name each time the text moves is noise, not news.
    const storage = api();
    const root = host();
    mountPersistenceControl(root, storage);
    await settle();

    const region = root.querySelector('[role="status"]');
    expect(region, "no live region: the result is displayed but never announced").not.toBeNull();
    expect(region?.textContent ?? "", "the region carries no status text").toMatch(/best-effort/i);
    expect(region?.querySelector("button"), "the button is inside the live region").toBeNull();

    // And the region is what changes, so the announcement carries the new state rather than a
    // stale one.
    button(root).click();
    await settle();
    expect(root.querySelector('[role="status"]')?.textContent ?? "").toMatch(/now persistent/i);
  });
});

describe("what the control claims about persistence", () => {
  const wordingFor = async (storage: PersistenceApi): Promise<string> => {
    const root = host();
    mountPersistenceControl(root, storage);
    await settle();
    button(root).click();
    await settle();
    return textOf(root);
  };

  it("scopes a grant to everything the origin stores, not to map regions", async () => {
    // The API is origin-wide, and ADR-0016's two stores do not change that — they are lifecycle
    // isolation, not quota isolation. A control implying it protected downloaded regions alone
    // would misdescribe both the API and the ADR.
    const words = await wordingFor(api({ persist: () => Promise.resolve(true) }));

    expect(words).toMatch(/trips/i);
    expect(words).toMatch(/map regions/i);
  });

  it("does not overstate a grant", async () => {
    // A grant excludes the origin from *automatic* eviction. It does not make the data
    // permanent: the user can still clear it, and a later write can still hit the quota. The
    // control has to say both, and must not say anything stronger.
    const words = await wordingFor(api({ persist: () => Promise.resolve(true) }));

    expect(words, "the limits are not stated").toMatch(/clear it yourself/i);
    expect(words, "the quota limit is not stated").toMatch(/quota/i);
    expect(words, "an absolute promise about the future").not.toMatch(
      /forever|never be|always be/i,
    );
    expect(words).toMatch(/excluded from automatic eviction/i);
  });
});

describe("readPersistenceApi", () => {
  it("finds the two methods when the browser has them", () => {
    const persisted = vi.fn(() => Promise.resolve(true));
    const persist = vi.fn(() => Promise.resolve(true));
    const found = readPersistenceApi({ storage: { persisted, persist } } as unknown as Navigator);

    expect(found).toBeDefined();
    void found?.persisted();
    expect(persisted).toHaveBeenCalledTimes(1);
  });

  it("reports unsupported when the namespace is missing", () => {
    expect(readPersistenceApi({} as unknown as Navigator)).toBeNull();
  });

  it("reports unsupported when the namespace exists but the methods do not", () => {
    // The case a namespace check alone would miss: `navigator.storage` is present in contexts
    // where `persist` is not, and calling through would throw rather than render "unsupported".
    expect(readPersistenceApi({ storage: {} } as unknown as Navigator)).toBeNull();
    expect(
      readPersistenceApi({
        storage: { persisted: () => Promise.resolve(true) },
      } as unknown as Navigator),
    ).toBeNull();
  });
});
